/**
 * git から差分の起点と変更行を引く。
 *
 * `turn` と `pr` が同じ集合を判定するために、起点は必ずデフォルトブランチとの merge-base。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

function git(root: string, args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw new GitError(`git ${args.join(" ")} が失敗しました: ${(cause as Error).message}`);
  }
}

function lines(output: string): string[] {
  return output === "" ? [] : output.split("\n");
}

/** デフォルトブランチとの分岐点。turn と pr はこれを共有する。 */
export function mergeBase(root: string, defaultBranch: string): string {
  return git(root, ["merge-base", "HEAD", defaultBranch]);
}

/** `@@ -a,b +c,d @@` の新側だけを読む。削除のみのハンクは新側の行を持たない。 */
function hunkLines(header: string): number[] {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (match === null) return [];
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  return Array.from({ length: count }, (_, offset) => start + offset);
}

function addAll(into: Map<string, Set<number>>, file: string, values: readonly number[]): void {
  const target = into.get(file) ?? new Set<number>();
  for (const value of values) target.add(value);
  into.set(file, target);
}

function collectHunks(diff: string, into: Map<string, Set<number>>): void {
  let file: string | null = null;
  for (const line of lines(diff)) {
    if (line.startsWith("+++ b/")) file = line.slice("+++ b/".length);
    else if (line.startsWith("@@") && file !== null) addAll(into, file, hunkLines(line));
  }
}

function countLines(root: string, file: string): number {
  return readFileSync(join(root, file), "utf8").split("\n").length;
}

/**
 * 変更された行番号をファイルごとに返す。未コミットの変更と新規ファイルも含む。
 *
 * ファイル単位ではなく行単位で見る。ファイル単位だと、1 行直しただけで
 * そのファイルの全関数が絶対閾値の対象になり、既存リポジトリが即座に赤くなる。
 * エージェントはコミットせずにターンを終えるので、コミット済みだけでは足りない。
 */
export function changedLines(root: string, base: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  collectHunks(git(root, ["diff", "--unified=0", `${base}...HEAD`]), result);
  collectHunks(git(root, ["diff", "--unified=0", "HEAD"]), result);
  // 新規ファイルは全体が新しいので、行を引かずに全行を対象にする。
  for (const file of lines(git(root, ["ls-files", "--others", "--exclude-standard"]))) {
    addAll(result, file, Array.from({ length: countLines(root, file) }, (_, index) => index + 1));
  }
  return result;
}
