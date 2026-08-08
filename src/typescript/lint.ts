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

/** eslint の指摘 1 件分。`ruleId` は設定や構文のエラー（fatal）では null。 */
interface EslintMessage {
  ruleId: string | null;
  line?: number;
  message: string;
  severity: number;
}

interface EslintFileResult {
  filePath: string;
  errorCount: number;
  messages?: EslintMessage[];
}

/** baseline のキーと同じ形（リポジトリ相対・区切りは `/`）に揃える。 */
function relativeKey(filePath: string, root: string): string {
  return relative(root, filePath).split("\\").join("/");
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
    counts[relativeKey(result.filePath, root)] = result.errorCount;
  }
  return counts;
}

/** どの行のどのルールか。これが無いと読み手は eslint を再実行しないと直せない。 */
function describeMessage(message: EslintMessage): string {
  return `L${message.line ?? "?"} ${message.ruleId ?? "(設定または構文のエラー)"}  ${message.message}`;
}

/** ファイルごとの error の内訳。counts と同じ基準（severity 2 のみ。warning は見ない）。 */
export function errorDetails(results: readonly EslintFileResult[], root: string): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const result of results) {
    // Stryker disable next-line ArrayDeclaration: 既定値に何を入れても
    // 直後の filter が severity を見て落とすので、区別できる振る舞いが無い。
    const errors = (result.messages ?? []).filter((message) => message.severity === 2);
    if (errors.length > 0) details[relativeKey(result.filePath, root)] = errors.map(describeMessage);
  }
  return details;
}

export interface LintResult {
  /** eslint が報告したファイル数。エラー 0 のファイルも数える。scope はこちらを言う —
   * エラーのあったファイル数だと、綺麗なリポジトリで「対象 0」になり、
   * 「見て問題なし」が「何も見ていない」に読める（hono で 309 ファイル 0 エラーを踏んだ）。 */
  scanned: number;
  /** ファイルごとの error の数。0 のファイルは載らない。 */
  counts: Record<string, number>;
  /** ファイルごとの error の内訳（行・ルール・本文）。0 のファイルは載らない。 */
  details: Record<string, string[]>;
}

export function parseLintOutput(stdout: string, root: string, detail = ""): LintResult {
  try {
    const results = JSON.parse(stdout) as EslintFileResult[];
    return { scanned: results.length, counts: countErrors(results, root), details: errorDetails(results, root) };
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
