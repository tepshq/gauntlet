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

export function shouldBlock(input: HookInput): boolean {
  const { tool_name: tool, tool_input: args } = input;
  if (tool === undefined || args === undefined) return false;
  if (EDITING_TOOLS.has(tool)) return (args.file_path ?? "").endsWith(BASELINE_FILENAME);
  // Bash からも書けるので、ファイル名に触れるコマンドを止める。
  if (tool === "Bash") return (args.command ?? "").includes(BASELINE_FILENAME);
  return false;
}

// 「編集できません」だけだと、指示どおり `git add gauntlet.baseline.json` した
// エージェントに矛盾した 2 つの指示が並ぶ。止まる条件（ファイル名に触れること）と
// 正規の経路（Read / git add -A）まで言う。
export const GUARD_MESSAGE =
  `${BASELINE_FILENAME} に触れる Bash コマンドと編集は止めています。` +
  `これは許容する違反数の記録で、減らすのは gauntlet が自動で行います。` +
  `赤を消すには違反そのものを直してください。` +
  `読むには Read ツールを、コミットするには git add -A のようにファイル名を含まない形を使ってください。`;
