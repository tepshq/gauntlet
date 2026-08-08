/**
 * mutation testing。gauntlet の中で唯一「テストを増やすだけでは通せない」ゲート。
 *
 * **`--inPlace` を使う。** Stryker は既定でサンドボックスにコピーし、その過程で
 * TypeScript の compiler API（`ts.parseConfigFileTextToJson`）を呼ぶが、
 * TypeScript 7 にその API は無く落ちる。`--inPlace` はコピーしないので前処理が走らない。
 * 実ファイルを書き換えることになるが、mutation は CI でしか走らせないので作業ツリーは使い捨て。
 */

import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../exec.ts";
import { RunnerError, lastLines } from "./runner.ts";

/** Stryker の json reporter の固定出力先。CLI からファイル名を変えられない。 */
export const REPORT_PATH = "reports/mutation/mutation.json";

interface Mutant {
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number } };
}

export interface MutationReport {
  files: Record<string, { mutants: Mutant[] }>;
}

export interface SurvivedMutant {
  file: string;
  line: number;
  mutator: string;
}

/**
 * 生き残った変異だけを取り出す。
 *
 * `NoCoverage`（どのテストも通っていない）は数えない。それは網羅率の話で、
 * CRAP が既に見ている。mutation が独自に捕まえるのは「テストは通るが assert が弱い」ケース。
 */
export function survivedFrom(report: MutationReport): SurvivedMutant[] {
  return Object.entries(report.files).flatMap(([file, entry]) =>
    entry.mutants
      .filter((mutant) => mutant.status === "Survived")
      .map((mutant) => ({ file, line: mutant.location.start.line, mutator: mutant.mutatorName })),
  );
}

/** `--ignoreStatic` で測らなかった変異の数。黙って落とさず、件数として出す。 */
export function ignoredCount(report: MutationReport): number {
  return Object.values(report.files).reduce(
    (total, entry) => total + entry.mutants.filter((mutant) => mutant.status === "Ignored").length,
    0,
  );
}

/**
 * 対象リポジトリの Stryker。
 *
 * `npx stryker` は入っていないと npm から別の（非推奨の）パッケージを取ってきてしまう。
 * 対象リポジトリの vitest に合わせる必要があるので、gauntlet が同梱するのではなく
 * 対象側に入れてもらい、無ければその場で止める。
 */
function strykerBin(root: string): string {
  const bin = join(root, "node_modules", ".bin", "stryker");
  if (existsSync(bin)) return bin;
  throw new RunnerError(
    "Stryker が入っていません。次で入れてください:\n" +
      "  npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner",
  );
}

/**
 * Stryker に渡す設定。CLI 引数ではなく生成した設定ファイルで渡す —
 * vitest runner の `configFile`（下のラッパー）は CLI から指定できないため。
 *
 * **退避先をリポジトリの外に出す。** `--inPlace` は実ファイルを書き換えるので、
 * まず元ファイルを退避ディレクトリへ丸ごとコピーする。それが既定ではリポジトリ内の
 * `.stryker-tmp/` なので、**対象リポジトリの vitest がそのコピーをテストとして拾う**。
 * duct では 22 個の「テストファイルが入力ファイルと照合できない」警告が出て
 * coverage 解析が壊れ、変異ごとに全スイートが走って timeout していた
 * （同じ DB 行を二重に叩いて dry run が落ちることもあった）。外に出せば、
 * 各リポジトリの vitest 設定に除外を足してもらう必要が無くなる。実測 127 秒 → 69 秒。
 *
 * **`--ignoreStatic`。** モジュール直下の式（定数やマップ）への変異は
 * モジュール読み込みそのものに影響するので、Stryker は per-test coverage を使えず
 * **変異ごとに全テストを走らせる**。duct の全スイートは 55 秒なので大半が timeout した
 * （30 行の component で 11 変異中 8 件）。**これは無料ではない** — timeout せずに
 * 判定が出ていた分も失う（同じ実測で Killed 2・Survived 1）。それでも入れる理由は、
 * timeout は違反に数えないので**分単位を払って何も分からない**状態だったこと、
 * そして duct の CI が既に 13 分に達していること。失った分は `ignoredCount` で件数を出す。
 */
export function strykerConfig(
  files: readonly string[],
  tempDir: string,
  vitestConfigFile: string | null,
): Record<string, unknown> {
  return {
    testRunner: "vitest",
    inPlace: true,
    tempDirName: tempDir,
    ignoreStatic: true,
    reporters: ["json"],
    mutate: [...files],
    ...(vitestConfigFile === null ? {} : { vitest: { configFile: vitestConfigFile } }),
  };
}

/** vitest が設定として解決する名前。vitest 優先は vitest 自身の解決順に合わせている。 */
const CONFIG_CANDIDATES = ["vitest.config", "vite.config"].flatMap((base) =>
  ["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => `${base}.${ext}`),
);

/** リポジトリの vitest 設定。Stryker のラッパーが import する相手。 */
export function findRepoVitestConfig(root: string): string | null {
  const found = CONFIG_CANDIDATES.find((name) => existsSync(join(root, name)));
  return found === undefined ? null : join(root, found);
}

/**
 * Stryker に渡す vitest 設定のラッパー。
 *
 * Stryker の vitest runner には project フィルタが無い（`dir` / `related` /
 * `configFile` のみ）。宣言（`tests.projects`）を効かせるには設定ごと差し替えるしか
 * ないので、リポジトリの設定を import して宣言にある project だけ残したものを
 * 一時ファイルとして渡す。
 *
 * 別ファイルへの glob 文字列（`./x/*\/vitest.config.ts`）で参照された project は
 * 名前が読めないため、宣言があるときは**残せない**（= 宣言できるのはインラインの
 * project だけ）。gauntlet の世界に入れたい project はインラインで書いてもらう。
 *
 * `root` を明示するのは、設定ファイルがリポジトリの外（一時ディレクトリ）に
 * 置かれるため。vitest が設定の場所から root を推測すると探索が壊れる。
 */
export function strykerVitestWrapper(repoConfigPath: string, root: string, projects: readonly string[]): string {
  return [
    "// gauntlet が生成した一時ファイル。リポジトリの vitest 設定から、宣言された project だけを残す。",
    `import base from ${JSON.stringify(repoConfigPath)};`,
    'const config = (await (typeof base === "function" ? base({ command: "serve", mode: "test" }) : base)) ?? {};',
    `config.root ??= ${JSON.stringify(root)};`,
    `const declared = ${JSON.stringify([...projects])};`,
    "if (declared.length > 0 && Array.isArray(config.test?.projects)) {",
    "  config.test.projects = config.test.projects.filter(",
    '    (project) => typeof project !== "string" && declared.includes(project?.test?.name),',
    "  );",
    "}",
    "export default config;",
    "",
  ].join("\n");
}

export interface GeneratedFile {
  path: string;
  content: string;
}

/**
 * Stryker 起動に要るファイル一式。**先頭が Stryker に渡す設定。**
 * 組み立ては純粋に行い、書くのは呼び出し側。ここをテストで固定して、
 * プロセスを起動する殻（`runMutation`）には判断を残さない。
 */
function confFile(confDir: string, tempDir: string, files: readonly string[], wrapper: string | null): GeneratedFile {
  return {
    path: join(confDir, "stryker.conf.json"),
    content: JSON.stringify(strykerConfig(files, tempDir, wrapper), null, 2),
  };
}

export function strykerFiles(
  confDir: string,
  tempDir: string,
  root: string,
  repoConfig: string | null,
  projects: readonly string[],
  files: readonly string[],
): GeneratedFile[] {
  if (repoConfig === null) return [confFile(confDir, tempDir, files, null)];
  const wrapper = join(confDir, "vitest.config.mjs");
  return [
    confFile(confDir, tempDir, files, wrapper),
    { path: wrapper, content: strykerVitestWrapper(repoConfig, root, projects) },
  ];
}

export interface MutationOutcome {
  survived: SurvivedMutant[];
  /** `--ignoreStatic` で測らなかった数。 */
  ignored: number;
}

/** 変異させる対象が 1 つ以上あることは呼び出し側が保証する。 */
export function runMutation(root: string, files: readonly string[], projects: readonly string[]): MutationOutcome {
  const bin = strykerBin(root);
  const tempDir = mkdtempSync(join(tmpdir(), "gauntlet-stryker-"));
  // 設定は退避先と別のディレクトリに置く。Stryker は tempDirName の中身を管理する
  // （作成・掃除）ので、同居させると設定ファイルごと消されうる。
  const confDir = mkdtempSync(join(tmpdir(), "gauntlet-stryker-conf-"));
  try {
    const launch = strykerFiles(confDir, tempDir, root, findRepoVitestConfig(root), projects, files);
    launch.forEach((file) => writeFileSync(file.path, file.content));
    const { combined } = capture(bin, ["run", launch[0]!.path], root);

    const path = join(root, REPORT_PATH);
    if (!existsSync(path)) {
      throw new RunnerError(`Stryker がレポートを出しませんでした:\n${lastLines(combined, 15)}`);
    }
    const report = JSON.parse(readFileSync(path, "utf8")) as MutationReport;
    rmSync(path, { force: true });
    cleanLeftovers(root);
    return { survived: survivedFrom(report), ignored: ignoredCount(report) };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(confDir, { recursive: true, force: true });
  }
}

/**
 * Stryker が置いていく作業ファイルを消す。
 *
 * `--inPlace` では `stryker-setup-*.js` がリポジトリのルートに残る。
 * 対象リポジトリを汚すのは gauntlet の仕事ではないので、こちらで片付ける。
 */
function cleanLeftovers(root: string): void {
  for (const name of globSync("stryker-setup-*.js", { cwd: root })) {
    rmSync(join(root, name), { force: true });
  }
}

