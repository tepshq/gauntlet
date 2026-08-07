/**
 * mutation testing。gauntlet の中で唯一「テストを増やすだけでは通せない」ゲート。
 *
 * **`--inPlace` を使う。** Stryker は既定でサンドボックスにコピーし、その過程で
 * TypeScript の compiler API（`ts.parseConfigFileTextToJson`）を呼ぶが、
 * TypeScript 7 にその API は無く落ちる。`--inPlace` はコピーしないので前処理が走らない。
 * 実ファイルを書き換えることになるが、mutation は CI でしか走らせないので作業ツリーは使い捨て。
 */

import { existsSync, globSync, readFileSync, rmSync } from "node:fs";
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
 * 生き残った変異を返す。
 *
 * `NoCoverage`（どのテストも通っていない）は数えない。それは網羅率の話で、
 * CRAP が既に見ている。mutation が独自に捕まえるのは「テストは通るが assert が弱い」ケース。
 */
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

/** 変異させる対象が 1 つ以上あることは呼び出し側が保証する。 */
export function runMutation(root: string, files: readonly string[]): SurvivedMutant[] {
  const bin = strykerBin(root);
  const args = ["run", "--testRunner", "vitest", "--inPlace", "--reporters", "json", "--mutate", files.join(",")];
  const { combined } = capture(bin, args, root);

  const path = join(root, REPORT_PATH);
  if (!existsSync(path)) {
    throw new RunnerError(`Stryker がレポートを出しませんでした:\n${lastLines(combined, 15)}`);
  }
  const report = JSON.parse(readFileSync(path, "utf8")) as MutationReport;
  rmSync(path, { force: true });
  cleanLeftovers(root);
  return survivedFrom(report);
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

