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
export function listSourceFiles(root: string, source: GauntletConfig["source"]): string[] {
  const owned = repoSourceSet(root);
  const found = globSync(source.include, {
    cwd: root,
    ...(source.exclude === undefined ? {} : { exclude: source.exclude }),
  });
  return found
    .map(toPosix)
    .filter((file) => owned.has(file))
    .sort();
}

export interface DeadInclude {
  pattern: string;
  /** そのまま置き換えれば測れるようになる書き方。作れなければ null。 */
  fix: string | null;
}

/**
 * **何かにはマッチしているのに、ソースを 1 つも連れてこない** include。
 *
 * `--include=src` は glob として成立する（ディレクトリ `src` 自身にマッチする）ので、
 * 綴りの誤りと同じ「対象 0」になりながら、原因は正反対（パスは実在する）。
 * しかも include が複数あると**そこだけ黙って抜け落ちて全体は緑**になり、
 * 範囲が狭いまま通るという、このツールが一番防ぎたい形になる（h3 で実測）。
 *
 * **1 つもマッチしないものは咎めない。** `src/**\/*.tsx` のような
 * 「今は無いが将来 増える」書き方は害が無く、これを落とすと config が窮屈になる。
 */
export function deadIncludes(root: string, source: GauntletConfig["source"]): DeadInclude[] {
  const owned = repoSourceSet(root);
  const reaches = (pattern: string): boolean =>
    globSync(pattern, { cwd: root })
      .map(toPosix)
      .some((file) => owned.has(file));
  return source.include
    .filter((pattern) => globSync(pattern, { cwd: root }).length > 0 && !reaches(pattern))
    .map((pattern) => {
      // ディレクトリを指していただけなら、その下を辿る形が答え。**当てて確かめてから言う** —
      // `src/**/*.ts` を決め打ちで案内すると、`lib/` のリポジトリに当たらない助言になる。
      const descended = `${pattern.replace(/\/$/, "")}/**/*.ts`;
      return { pattern, fix: reaches(descended) ? descended : null };
    });
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
