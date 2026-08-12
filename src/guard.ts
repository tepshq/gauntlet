/**
 * baseline をエージェントの手から守る。
 *
 * `PreToolUse` フックとして呼ばれ、baseline を書き換えようとするツール呼び出しを止める。
 * 塞がなければ「赤 → baseline を緩める → 緑」が最短経路になる（gameable）。
 * 改善方向の書き換えは gauntlet 自身が行うので、エージェントが触る理由は無い。
 */

import { BASELINE_FILENAME } from "./baseline.ts";

interface HookInput {
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
}

const EDITING_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/**
 * 引用符の中身を落とす。**散文とコマンドを見分けるため。**
 *
 * `gh issue create --body "…ファイル名…"` のように、記録のファイル名が**文章として**
 * 引用符の中に現れるだけのコマンドを止めていた（issue の本文にファイル名が書けず、
 * gauntlet 自身の issue が立てられなかった）。パスとして使う名前は裸で書かれるのが
 * 普通なので、引用の中は見ない。引用されたパスで書く形（`sed -i "…" "<file>"`）は
 * すり抜けるが、guard は最短経路を塞ぐ柵であって金庫ではない —
 * 名指しを避けた書き換え（動的に組んだパスなど）は元から止めようがない。
 */
function stripQuoted(segment: string): string {
  // Stryker disable next-line StringLiteral: 置換後を "''" にするか "" にするかで
  // 判定は変わらない（見るのは裸のファイル名と書き換え構文だけ）。器は読みやすさのため。
  return segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * 記録を書き換える形。**動詞（書き換える側）で判定する。**
 *
 * - リダイレクトは**行き先がこのファイルのときだけ**（`cat <file> > 控え` は読むだけ）
 * - `sed -i` / `perl -i` はその場で書く
 * - `tee` は引数に書く
 * - `rm` / `mv` / `cp` / `truncate` は消す・置き換える
 * - `git restore` / `git checkout` は**締まった記録を緩い値に戻せる**ので書き換え扱い
 */
const WRITE_FORMS = [
  new RegExp(`>>?\\s*\\S*${BASELINE_FILENAME.replace(/\./g, "\\.")}`),
  /\b(?:sed|perl)\s+(?:-\S+\s+)*-\w*i/,
  /\btee\b/,
  /\b(?:rm|mv|cp|truncate|shred|unlink)\b/,
  /\bgit\s+(?:(?:-C|-c)\s+\S+\s+|-\S+\s+)*(?:restore|checkout|clean)\b/,
];

/**
 * Bash コマンドが記録を書き換えうるか。**書く形のときだけ止める。**
 *
 * 「ファイル名に触れたら止める」から 2 段階で狭めてきた:
 * 0.21.0 で読むだけの git を通し（`git add -A` の強制が並行作業を巻き込んだ）、
 * ここで判定を動詞側に反転した（`gh issue create` の本文に名前が書けなかった）。
 *
 * 区間ごとに見る — `git diff <file> && sed -i ... <file>` の後半を見逃さないため。
 */
export function writesBaseline(command: string): boolean {
  // **剥がしてから区切る。** 逆にすると、引用の中の `&&` で区切られて引用が千切れ、
  // 中の散文が裸のファイル名として現れる（自分のテストデータを書くコマンドで実測）。
  return stripQuoted(command)
    .split(/&&|\|\||;|\||\n/)
    .filter((segment) => segment.includes(BASELINE_FILENAME))
    .some((segment) => WRITE_FORMS.some((form) => form.test(segment)));
}

/**
 * その Bash コマンドが `git commit` を含むか。**precommit フックの発火条件。**
 *
 * Claude Code のフックの `if: "Bash(git commit *)"` に任せていたが、`if` を知らない
 * 版の Claude Code は**未知のフィールドを黙って無視して全 Bash で quick を走らせる**。
 * 作業ツリーが赤い間は復旧の git コマンドまで全部止まり、抜け出す道が
 * 「ゲートを一時的に無効化する」しか無くなる（実際に踏まれた）。
 * 発火条件を gauntlet 自身が持てば、どの版でも同じ意味になる。
 */
/**
 * フック入力 → とるべき行動。判断はここ、プロセスの入出力は main。
 *
 * guard と precommit を 1 つのフックに束ねる（Bash 1 回につき node の起動を 1 回に
 * 抑えるため）。順序は block が先 — 記録を書き換えるコミットは、検問より先に止める。
 */
export function hookAction(input: HookInput): "block" | "quick" | "pass" {
  if (shouldBlock(input)) return "block";
  if (gatesCommit(input)) return "quick";
  return "pass";
}

/** precommit フックが quick を回すべき入力か。判断はここ、プロセスの入出力は main。 */
export function gatesCommit(input: HookInput): boolean {
  // Stryker disable next-line StringLiteral: 既定値はコマンドを含まない文字列なら
  // 何でも同じ（runsGitCommit が false を返す）。空文字は意図の表明。
  return input.tool_name === "Bash" && runsGitCommit(input.tool_input?.command ?? "");
}

export function runsGitCommit(command: string): boolean {
  const form = /^\s*(?:\w+=\S*\s+)*git\s+(?:(?:-C|-c)\s+\S+\s+|-\S+\s+)*commit\b/;
  return command.split(/&&|\|\||;|\||\n/).some((segment) => form.test(segment));
}

export function shouldBlock(input: HookInput): boolean {
  const { tool_name: tool, tool_input: args } = input;
  // Stryker disable next-line ConditionalExpression: 左辺（tool 側）を false にしても
  // 下流が undefined を安全に扱う（has(undefined) は false、"Bash" とも一致しない）ので
  // 区別できる振る舞いが無い。早期 return は args 側の参照を守るためにある。
  if (tool === undefined || args === undefined) return false;
  // Stryker disable next-line StringLiteral: 既定値は記録の名前で終わらない文字列なら
  // 何でも同じ（endsWith が false を返す）。空文字は意図の表明。
  if (EDITING_TOOLS.has(tool)) return (args.file_path ?? "").endsWith(BASELINE_FILENAME);
  if (tool === "Bash") return writesBaseline(args.command ?? "");
  return false;
}

// 「編集できません」だけだと、直しにいく先が分からない。止まる条件（書き換える形）と
// 正規の経路（読む・ステージする・違反そのものを直す）まで言う。
export const GUARD_MESSAGE =
  `${BASELINE_FILENAME} を書き換える操作は止めています。` +
  `これは許容する違反数の記録で、減らすのは gauntlet が自動で行います。` +
  `赤を消すには違反そのものを直してください。` +
  `読むのは通ります（Read ツール、git diff / log / show / status）。` +
  `コミットは git add でも git add -A でも構いません。`;
