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

export interface LintResult {
  /** eslint が報告したファイル数。エラー 0 のファイルも数える。scope はこちらを言う —
   * エラーのあったファイル数だと、綺麗なリポジトリで「対象 0」になり、
   * 「見て問題なし」が「何も見ていない」に読める（hono で 309 ファイル 0 エラーを踏んだ）。 */
  scanned: number;
  /** ファイルごとの error の数。0 のファイルは載らない。 */
  counts: Record<string, number>;
}

export function parseLintOutput(stdout: string, root: string, detail = ""): LintResult {
  try {
    const results = JSON.parse(stdout) as EslintFileResult[];
    return { scanned: results.length, counts: countErrors(results, root) };
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
export function runLint(root: string, targets: readonly string[]): LintResult {
  const args = ["--format", "json", "--no-error-on-unmatched-pattern", ...targets];
  const { stdout, combined } = capture(eslintBin(root), args, root);
  return parseLintOutput(stdout, root, combined);
}
