/**
 * eslint の実行。
 *
 * ルールそのものは対象リポジトリが持つ。gauntlet は件数を数えて、
 * ラチェットで「増やさない」だけを課す。どのルールを有効にするかには口を出さない。
 */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { capture } from "../exec.ts";
import { RunnerError } from "./runner.ts";

interface EslintFileResult {
  filePath: string;
  errorCount: number;
}

function eslintBin(root: string): string {
  const bin = join(root, "node_modules", ".bin", "eslint");
  if (existsSync(bin)) return bin;
  throw new RunnerError("eslint が入っていません。次で入れてください:\n  npm i -D eslint");
}

/**
 * ファイルごとの **error** の数。warning は数えない。
 *
 * warning は「直すかどうかを書き手が決める」ものとして設定されている印なので、
 * ゲートに混ぜると設定の意図を壊す。
 */
export function countErrors(results: readonly EslintFileResult[], root: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    if (result.errorCount === 0) continue;
    counts[relative(root, result.filePath).split("\\").join("/")] = result.errorCount;
  }
  return counts;
}

export function parseLintOutput(stdout: string, root: string, detail = ""): Record<string, number> {
  try {
    return countErrors(JSON.parse(stdout) as EslintFileResult[], root);
  } catch {
    // 原因は標準エラーにしか出ないことがある。stdout だけ見せると空の報告になる。
    throw new RunnerError(`eslint の出力を読めません:\n${(detail === "" ? stdout : detail).slice(0, 500)}`);
  }
}

/**
 * 対象が 1 つ以上あることは呼び出し側が保証する。
 *
 * `--no-error-on-unmatched-pattern` が要る。eslint は既定で、マッチしない glob が
 * 1 つでもあると即エラーで終わる。gauntlet が渡すのは**測る範囲**の指定なので、
 * `src/**\/*.tsx` のように空になる組み合わせは普通にある（teps で実際に踏んだ）。
 */
export function runLint(root: string, targets: readonly string[]): Record<string, number> {
  const args = ["--format", "json", "--no-error-on-unmatched-pattern", ...targets];
  const { stdout, combined } = capture(eslintBin(root), args, root);
  return parseLintOutput(stdout, root, combined);
}
