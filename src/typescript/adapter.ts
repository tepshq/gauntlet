/**
 * TypeScript アダプタ。
 *
 * 責務は「ソースと coverage から、関数単位の cc と網羅率を出す」ことだけ。
 * git の差分も閾値も CRAP の式も core 側にある。
 */

import { globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { GauntletConfig } from "../config.ts";
import { repoSourceSet } from "../git.ts";
import { REPORT_SCHEMA_VERSION, type AdapterReport, type ExcludedFile, type FunctionReport } from "../report.ts";
import { extractFunctions } from "./complexity.ts";
import { type IstanbulCoverage, coverageByFunction } from "./coverage.ts";

export const ADAPTER_NAME = "typescript";

/** 区切りを常に `/` に揃える。Windows と macOS で違うキーになると照合が壊れる。 */
export function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/**
 * 測る対象 = include/exclude の glob に合致し、**かつリポジトリが所有する**ファイル。
 *
 * glob（ディスク）だけだと gitignore された生成物が混入する — duct では Prisma の
 * 生成クライアント 61 ファイルが `lib/**` に合致していた（`repoSourceSet` 参照）。
 * エージェントの書きたての新規ファイルは gitignore されていないので残る。
 */
/**
 * テストファイルか。**測る対象からも変異対象からも外す。**
 *
 * テストにテストは書けないので、テストファイルの複雑な関数は網羅率 0% で必ず CRAP
 * 違反になる（duct では `vi.fn().mockImplementation()` に渡した switch が CRAP 110 で、
 * テストを 1 行直すとコミットが止まった）。変異させても、守るテストが無いので必ず生き残る。
 * 重複も、`beforeEach` の並びや AAA の骨格が似るのは自然なので、数えると本体が量に埋もれる
 * （duct で 133437 → 30196 トークン）。**どのリポジトリでも答えが同じ**なので config で
 * 決めることではない。
 */
export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file);
}

export function listSourceFiles(root: string, source: GauntletConfig["source"]): string[] {
  const owned = repoSourceSet(root);
  const found = globSync(source.include, { cwd: root, exclude: source.exclude ?? [] });
  return found
    .map(toPosix)
    .filter((file) => owned.has(file) && !isTestFile(file))
    .sort();
}

export interface DeadInclude {
  pattern: string;
  /** そのまま置き換えれば測れるようになる書き方。作れなければ null。 */
  fix: string | null;
}

export interface IncludeReview {
  /** マッチはしているのに、測れるファイルに 1 つも届かないもの。落とす。 */
  dead: DeadInclude[];
  /** 1 件もマッチしないもの。**落とさずに言う。** */
  unmatched: string[];
}

/**
 * include を 1 本ずつ当てて、測る対象を連れてこないものを分ける。
 *
 * `--include=src` は glob として成立する（ディレクトリ `src` 自身にマッチする）ので、
 * 綴りの誤りと同じ「対象 0」になりながら、原因は正反対（パスは実在する）。
 * しかも include が複数あると**そこだけ黙って抜け落ちて全体は緑**になり、
 * 範囲が狭いまま通るという、このツールが一番防ぎたい形になる（h3 で実測）。
 *
 * **1 件もマッチしないものは落とさない。** ディレクトリを指す書き方は
 * *どんなリポジトリでも* ファイルを連れてこないと言い切れるが、0 件マッチは
 * 「今このリポジトリに無い」だけで、`src/**\/*.tsx` のような先回りは正しい書き方でありうる。
 * 落とすと、**最後の 1 ファイルを消しただけで無関係な赤**が出る（環境で答えが変わる方向）。
 * ただし綴りの誤り（`testt/**\/*.ts`）も同じ形なので、黙りはしない — 言うだけにする。
 */
export function reviewIncludes(root: string, source: GauntletConfig["source"]): IncludeReview {
  const owned = repoSourceSet(root);
  const reaches = (pattern: string): boolean =>
    globSync(pattern, { cwd: root })
      .map(toPosix)
      .some((file) => owned.has(file));
  const review: IncludeReview = { dead: [], unmatched: [] };
  for (const pattern of source.include) {
    if (reaches(pattern)) continue;
    if (globSync(pattern, { cwd: root }).length === 0) {
      review.unmatched.push(pattern);
      continue;
    }
    // ディレクトリを指していただけなら、その下を辿る形が答え。**当てて確かめてから言う** —
    // `src/**/*.ts` を決め打ちで案内すると、`lib/` のリポジトリに当たらない助言になる。
    const descended = `${pattern.replace(/\/$/, "")}/**/*.ts`;
    review.dead.push({ pattern, fix: reaches(descended) ? descended : null });
  }
  return review;
}

/**
 * 測る対象に入っているのに、coverage に現れないファイル。**フル実行にだけ当てる。**
 *
 * gauntlet は `--coverage.include` に自分の宣言を渡すので、対象のファイルは
 * テストが触れていなくてもゼロ行の項目として載る。それでも現れないのは、
 * **リポジトリ側の `coverage.exclude` が消している**ときだけ（CLI から上書きできない）。
 *
 * 放置すると網羅率 0% と区別がつかない。しかし直し方は正反対で、
 * こちらは**テストを書いても網羅率が上がらない** — 複雑度が閾値に触れた瞬間に
 * 「網羅率 N% で通ります」という到達できない出口を案内する赤になる（h3 が指摘）。
 */
export function unmeasuredFiles(
  root: string,
  source: GauntletConfig["source"],
  coverage: IstanbulCoverage,
): string[] {
  const measured = new Set(Object.keys(coverage).map((absolute) => toPosix(relative(root, absolute))));
  return listSourceFiles(root, source).filter((file) => !measured.has(file));
}

/** coverage-final.json は絶対パスをキーに持つので、リポジトリ相対に直して引けるようにする。 */
function indexCoverageByRelativePath(root: string, coverage: IstanbulCoverage): Map<string, IstanbulCoverage[string]> {
  const index = new Map<string, IstanbulCoverage[string]>();
  for (const [absolute, entry] of Object.entries(coverage)) {
    index.set(toPosix(relative(root, absolute)), entry);
  }
  return index;
}

export function analyze(root: string, config: GauntletConfig, coverage: IstanbulCoverage): AdapterReport {
  const index = indexCoverageByRelativePath(root, coverage);
  const functions: FunctionReport[] = [];
  const excluded: ExcludedFile[] = [];

  for (const file of listSourceFiles(root, config.source)) {
    const source = readFileSync(resolve(root, file), "utf8");
    const extracted = extractFunctions(file, source);
    if (extracted.length === 0) {
      excluded.push({ file, reason: "関数がありません" });
      continue;
    }
    const rates = coverageByFunction(extracted, index.get(file));
    for (const fn of extracted) {
      functions.push({ location: fn.location, cc: fn.cc, coverage: rates.get(fn)! });
    }
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    adapter: { name: ADAPTER_NAME, version: "0.0.0" },
    root,
    functions,
    excluded,
  };
}
