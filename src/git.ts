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
/**
 * `git diff` の出力は既定の 1MB を軽く超える。
 *
 * duct では起点が古いブランチに解決された結果、差分が 1643 ファイル・46 万行になり
 * `spawnSync git ENOBUFS` で落ちた。上限に当たると差分の一部ではなく**全部**を失うので、
 * 「変更行ゼロ」ではなく起動時のエラーになる。それでも起点の取り違えは起きうるため、
 * 現実的な最大の差分でも収まる値を置く。
 */
const MAX_OUTPUT_BYTES = 512_000_000;

function git(root: string, args: readonly string[]): string {
  const withConfig = ["-c", "core.quotePath=false", ...args];
  try {
    // 子プロセスの起動引数と stdio の指定。壊すと git が動かないだけで、
    // 区別できる振る舞いが無い。1 行に収めないと disable の射程から外れる。
    // Stryker disable next-line ArrayDeclaration,StringLiteral,MethodExpression,ObjectLiteral
    return execFileSync("git", withConfig, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_OUTPUT_BYTES }).trim();
  } catch (cause) {
    throw new GitError(`git ${args.join(" ")} が失敗しました: ${(cause as Error).message}`);
  }
}

/** 空行は落とす。git の出力は末尾に改行が付くので、素で分割すると空文字が混ざる。 */
export function lines(output: string): string[] {
  return output.split("\n").filter((line) => line !== "");
}

/**
 * 探す順。**リモート追跡ブランチを先に見る。**
 *
 * PR が実際にマージされる先は `origin/main` であって、手元の `main` ではない。
 * 手元の `main` は fetch しただけでは動かないので、いくらでも古くなる。
 * duct では 1643 ファイル分古く、そこを起点にすると差分が 46 万行になり、
 * 触っていない箇所まで絶対閾値の対象になっていた。
 *
 * ローカルだけを見る形にも戻せない。CI の checkout は対象ブランチしか
 * ローカルに作らないので `main` は解決できず、`origin/main` だけが存在する。
 * 両方を順に試す。手元の `main` が origin より進んでいる場合は起点が古い側になるが、
 * それは対象が広がる方向なので、緑の意味を緩めない。
 */
export function branchCandidates(defaultBranch: string): string[] {
  return defaultBranch.includes("/") ? [defaultBranch] : [`origin/${defaultBranch}`, defaultBranch];
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
/**
 * リポジトリが所有するファイル — 追跡済み + 追跡外だが gitignore されていないもの。
 *
 * 測る対象を glob（ディスク）だけで決めると、gitignore された生成物が混入する。
 * duct では `postinstall` が生成する Prisma クライアント 61 ファイルが `lib/**` に
 * 合致し、CRAP の対象と重複の数を静かに膨らませていた（重複 169k ↔ 実際は 29k）。
 * エージェントが書いたばかりの未コミットの新規ファイルは gitignore されていないので、
 * `--others` 側でここに含まれる。
 */
export function repoSourceSet(root: string): Set<string> {
  return new Set(lines(git(root, ["ls-files", "--cached", "--others", "--exclude-standard"])));
}

/**
 * git が実行ビット付き（100755）として持っているファイル。
 *
 * Stryker の `--inPlace` は**プロジェクト全体**を退避して戻すので、変異対象だけ
 * mode を控えても足りない（h3 では `bin/h3.mjs` が 755 → 644 に落ちた）。
 * 何を触るかを gauntlet が知らなくても、git が持っている一覧なら過不足なく戻せる。
 */
/**
 * 作業ツリーがコミット済みの状態と一致しているか。
 *
 * 許容値の記録を**作業途中の値で**締めないための判定。分割の途中は数字が上下する
 * のが普通で、途中の一番良かった瞬間が基準になると、続きの編集が自分の未完成状態に
 * 負ける（実際に 77 → 80 で落ちた）。clean なツリー = コミット済みの実測だけを記録する。
 */
export function workingTreeClean(root: string): boolean {
  // Stryker disable next-line MethodExpression: clean のとき porcelain は完全な空文字を
  // 返すので trim は保険。外しても観測できる振る舞いは変わらない。
  return git(root, ["status", "--porcelain"]).trim() === "";
}

export function executableFiles(root: string): Set<string> {
  const entries = lines(git(root, ["ls-files", "-s"]))
    .filter((line) => line.startsWith("100755"))
    .map((line) => line.slice(line.indexOf("\t") + 1));
  return new Set(entries);
}

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
