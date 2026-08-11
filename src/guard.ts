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
 * 内容を変えない git のサブコマンド。
 *
 * `add` はステージするだけでファイルを書き換えない。**`restore` / `checkout` は入れない** —
 * 締まった記録を元の緩い値に戻せてしまい、それは「基準を緩める」そのもの。
 */
const READ_ONLY_GIT = /^\s*git\s+(?:(?:-C|-c)\s+\S+\s+|-\S+\s+)*(?:diff|log|show|status|ls-files|blame|add)\b/;

/**
 * その 1 区間が記録を書き換えうるか。
 *
 * リダイレクト（`>` `>>`）があれば、先頭が何であれ書き換え。
 */
function writes(segment: string): boolean {
  if (segment.includes(">")) return true;
  return !READ_ONLY_GIT.test(segment);
}

/**
 * Bash コマンドが記録を書き換えうるか。**読むだけのものは通す。**
 *
 * 一律に止めていたので `git diff` も `git add <path>` も止まっていた。前者は読むだけで、
 * 案内していた Read ツールでは差分が見られない。後者はファイルを書き換えない。
 * その結果 `git add -A` が唯一の道になり、**並行作業があると無関係な変更まで
 * 巻き込む**（導入中に実際に踏まれた）。
 *
 * 区間ごとに見る — `git diff <path> && sed -i ... <path>` の後半を見逃さないため。
 */
export function writesBaseline(command: string): boolean {
  return command
    .split(/&&|\|\||;|\||\n/)
    .filter((segment) => segment.includes(BASELINE_FILENAME))
    .some(writes);
}

export function shouldBlock(input: HookInput): boolean {
  const { tool_name: tool, tool_input: args } = input;
  if (tool === undefined || args === undefined) return false;
  if (EDITING_TOOLS.has(tool)) return (args.file_path ?? "").endsWith(BASELINE_FILENAME);
  if (tool === "Bash") return writesBaseline(args.command ?? "");
  return false;
}

// 「編集できません」だけだと、指示どおり `git add gauntlet.baseline.json` した
// エージェントに矛盾した 2 つの指示が並ぶ。止まる条件（ファイル名に触れること）と
// 正規の経路（Read / git add -A）まで言う。
export const GUARD_MESSAGE =
  `${BASELINE_FILENAME} を書き換える操作は止めています。` +
  `これは許容する違反数の記録で、減らすのは gauntlet が自動で行います。` +
  `赤を消すには違反そのものを直してください。` +
  `読むのは通ります（Read ツール、git diff / log / show / status）。` +
  `コミットは git add でも git add -A でも構いません。`;
