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

/**
 * `core.quotePath=false` は必須。
 *
 * 既定では git が非 ASCII のパスを引用符付き・8 進エスケープで返す
 * （`"docs/\343\203\206..."`）。そのまま開こうとすると ENOENT で落ちる。
 */
function git(root: string, args: readonly string[]): string {
  const withConfig = ["-c", "core.quotePath=false", ...args];
  try {
    // 子プロセスの起動引数と stdio の指定。壊すと git が動かないだけで、
    // 区別できる振る舞いが無い。
    // Stryker disable next-line ArrayDeclaration,StringLiteral,MethodExpression
    return execFileSync("git", withConfig, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    throw new GitError(`git ${args.join(" ")} が失敗しました: ${(cause as Error).message}`);
  }
}

/** 空行は落とす。git の出力は末尾に改行が付くので、素で分割すると空文字が混ざる。 */
export function lines(output: string): string[] {
  return output.split("\n").filter((line) => line !== "");
}

/**
 * 探す順。ローカルに無ければリモート追跡ブランチを見る。
 *
 * CI の checkout は対象ブランチしかローカルに作らないので、`main` は解決できず
 * `origin/main` だけが存在する。手元では逆のこともあるため、両方を順に試す。
 */
export function branchCandidates(defaultBranch: string): string[] {
  return defaultBranch.includes("/") ? [defaultBranch] : [defaultBranch, `origin/${defaultBranch}`];
}

function tryMergeBase(root: string, ref: string): string | null {
  try {
    return git(root, ["merge-base", "HEAD", ref]);
  } catch {
    return null;
  }
}

/** デフォルトブランチとの分岐点。turn と pr はこれを共有する。 */
export function mergeBase(root: string, defaultBranch: string): string {
  const found = branchCandidates(defaultBranch)
    .map((ref) => tryMergeBase(root, ref))
    .find((base) => base !== null);
  if (found === undefined) {
    throw new GitError(
      `${defaultBranch} との分岐点が見つかりません。` +
        `CI では actions/checkout に fetch-depth: 0 を指定してください。`,
    );
  }
  return found;
}

/** `@@ -a,b +c,d @@` の新側だけを読む。削除のみのハンクは新側の行を持たない。 */
export function hunkLines(header: string): number[] {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (match === null) return [];
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  return Array.from({ length: count }, (_, offset) => start + offset);
}

/** 空を渡されたらキーを作らない。変更行を持たないファイルが差分に現れても意味を持たない。 */
function addAll(into: Map<string, Set<number>>, file: string, values: readonly number[]): void {
  if (values.length === 0) return;
  const target = into.get(file) ?? new Set<number>();
  for (const value of values) target.add(value);
  into.set(file, target);
}

/**
 * ハンク行かどうかを別に判定しない。`hunkLines` が非ハンク行に対して空を返すので、
 * ここで `startsWith("@@")` を見ても同じ結果になる。
 */
export function collectHunks(diff: string, into: Map<string, Set<number>>): void {
  let file: string | null = null;
  for (const line of lines(diff)) {
    if (line.startsWith("+++ b/")) file = line.slice("+++ b/".length);
    else if (file !== null) addAll(into, file, hunkLines(line));
  }
}

/**
 * 新規ファイルの行数。読めなければ 0。
 *
 * 未追跡のファイルには画像や xlsx も混ざる。ここで落ちると、
 * リポジトリに置いてあるものだけで gauntlet 全体が動かなくなる。
 */
function countLines(root: string, file: string): number {
  try {
    return readFileSync(join(root, file), "utf8").split("\n").length;
  } catch {
    return 0;
  }
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
