import { describe, expect, it } from "vitest";
import { GUARD_MESSAGE, shouldBlock } from "./guard.ts";

describe("shouldBlock", () => {
  // 塞がなければ「赤 → baseline を緩める → 緑」が最短経路になる。
  it.each([
    ["Edit", { file_path: "/repo/gauntlet.baseline.json" }],
    ["Write", { file_path: "gauntlet.baseline.json" }],
    ["NotebookEdit", { file_path: "/repo/gauntlet.baseline.json" }],
    ["Bash", { command: "echo '{\"crap\":99}' > gauntlet.baseline.json" }],
    ["Bash", { command: "sed -i '' s/0/99/ ./gauntlet.baseline.json" }],
  ])("%s から baseline を書き換えようとしたら止める", (tool, args) => {
    expect(shouldBlock({ tool_name: tool, tool_input: args })).toBe(true);
  });

  it.each([
    ["別のファイルの Edit", "Edit", { file_path: "/repo/src/index.ts" }],
    ["普通の Bash", "Bash", { command: "npm test" }],
    ["baseline を読むだけの Bash は対象外にしない", "Read", { file_path: "gauntlet.baseline.json" }],
    ["引数が無い", "Edit", undefined],
  ])("%s は通す", (_label, tool, args) => {
    expect(shouldBlock({ tool_name: tool, ...(args === undefined ? {} : { tool_input: args }) })).toBe(false);
  });

  it("空の入力で落ちない", () => {
    expect(shouldBlock({})).toBe(false);
  });
});

describe("GUARD_MESSAGE", () => {
  // 文言はエージェントへのフィードバックそのもの。「編集できません」だけだと、
  // 種置きの指示どおり git add gauntlet.baseline.json した読み手に
  // 矛盾した 2 つの指示が並ぶ。止まる条件と正規の経路まで言う。
  it("止まる条件と正規の経路を丸ごと固定する", () => {
    expect(GUARD_MESSAGE).toBe(
      "gauntlet.baseline.json に触れる Bash コマンドと編集は止めています。" +
        "これは許容する違反数の記録で、減らすのは gauntlet が自動で行います。" +
        "赤を消すには違反そのものを直してください。" +
        "読むには Read ツールを、コミットするには git add -A のようにファイル名を含まない形を使ってください。",
    );
  });
});
