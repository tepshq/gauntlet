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
      "gauntlet.baseline.json を書き換える操作は止めています。" +
        "これは許容する違反数の記録で、減らすのは gauntlet が自動で行います。" +
        "赤を消すには違反そのものを直してください。" +
        "読むのは通ります（Read ツール、git diff / log / show / status）。" +
        "コミットは git add でも git add -A でも構いません。",
    );
  });

  // 一律に止めていたので、読むだけの git まで止まっていた。案内していた Read ツールでは
  // 差分が見られず、`git add -A` が唯一の道になって並行作業を巻き込んだ（導入中に実測）。
  it.each([
    "git diff gauntlet.baseline.json",
    "git log -p gauntlet.baseline.json",
    "git show HEAD:gauntlet.baseline.json",
    "git status gauntlet.baseline.json",
    "git add gauntlet.baseline.json",
    "git -C /repo diff gauntlet.baseline.json",
  ])("読むだけ・ステージするだけは通す: %s", (command) => {
    expect(shouldBlock({ tool_name: "Bash", tool_input: { command } })).toBe(false);
  });

  // 締まった記録を元の緩い値に戻せる。これは「基準を緩める」そのもの。
  it.each([
    "git checkout -- gauntlet.baseline.json",
    "git restore gauntlet.baseline.json",
    "sed -i '' s/9/99/ gauntlet.baseline.json",
    "rm gauntlet.baseline.json",
    "echo '{}' > gauntlet.baseline.json",
    "cat x.json > gauntlet.baseline.json",
    "git diff > gauntlet.baseline.json",
  ])("書き換えは止める: %s", (command) => {
    expect(shouldBlock({ tool_name: "Bash", tool_input: { command } })).toBe(true);
  });

  // 前半が読むだけでも、後半で書き換えられる。区間ごとに見ないと素通りする。
  it("繋いだコマンドは区間ごとに見る", () => {
    const command = "git diff gauntlet.baseline.json && sed -i '' s/1/2/ gauntlet.baseline.json";
    expect(shouldBlock({ tool_name: "Bash", tool_input: { command } })).toBe(true);
  });
});
