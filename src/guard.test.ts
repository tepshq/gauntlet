import { describe, expect, it } from "vitest";
import { GUARD_MESSAGE, gatesCommit, runsGitCommit, shouldBlock } from "./guard.ts";

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

  // ファイル名が**散文として**引用符の中にあるだけのコマンドを止めていた。
  // issue の本文にファイル名が書けず、gauntlet 自身の issue が立てられなかった。
  it.each([
    'gh issue create --title "guard の件" --body "gauntlet.baseline.json を書き換える操作が…"',
    'git commit -m "gauntlet.baseline.json の許容値を締めた"',
    "echo 'gauntlet.baseline.json は ratchet の記録'",
  ])("散文として引用の中にあるだけなら通す: %s", (command) => {
    expect(shouldBlock({ tool_name: "Bash", tool_input: { command } })).toBe(false);
  });

  // 中身を控えに写すのは読むだけ。行き先がこのファイルのときだけ書き換え。
  it("控えへの書き出しは通す", () => {
    const command = "cat gauntlet.baseline.json > /tmp/copy.json";
    expect(shouldBlock({ tool_name: "Bash", tool_input: { command } })).toBe(false);
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

// 発火条件を Claude Code の `if` に預けない — `if` を知らない版は未知フィールドを黙って
// 無視し、全 Bash で quick が走る。赤いツリーでは復旧の git コマンドまで止まった。
describe("runsGitCommit", () => {
  it.each([
    'git commit -m "x"',
    "git commit",
    'git -C /repo commit -m "x"',
    'GIT_AUTHOR_NAME=t git commit -m "x"',
    'git add -A && git commit -m "x"',
    'echo msg | git commit -F -',
  ])("コミットは検問にかける: %s", (command) => {
    expect(runsGitCommit(command)).toBe(true);
  });

  it.each([
    "git status",
    "git stash pop",
    "git checkout -- src/a.ts",
    "npx tsx src/compose.ts",
    "npm run catalog",
    'git diff HEAD~1',
    'echo "git commit の話"',
    "gh pr create --title 'git commit を止める'",
  ])("コミット以外は素通しする: %s", (command) => {
    expect(runsGitCommit(command)).toBe(false);
  });
});

// 発火の判断。ここが緩むと、コミットでないコマンドまで quick で止まる（#22 の形に戻る）。
describe("gatesCommit", () => {
  it("Bash の git commit だけを検問にかける", () => {
    expect(gatesCommit({ tool_name: "Bash", tool_input: { command: 'git commit -m "x"' } })).toBe(true);
  });

  it.each([
    { tool_name: "Bash", tool_input: { command: "npx tsx src/compose.ts" } },
    { tool_name: "Edit", tool_input: {} },
    { tool_name: "Bash", tool_input: {} },
    {},
  ])("それ以外は素通しする", (input) => {
    expect(gatesCommit(input as Parameters<typeof gatesCommit>[0])).toBe(false);
  });
});

// 引用の落とし方そのもの。1 文字ずれると「散文を止める」か「引用パスの書き換えを通す」に戻る。
describe("引用の扱い", () => {
  // 空文字に潰すと `echo '' > gauntlet.baseline.json` の空引用が消えて隣とくっつき、
  // リダイレクトの行き先の判定がずれる。中身だけ落とし、引用の器は残す。
  it("引用の器は残して中身だけ落とす", () => {
    const command = `echo 'x' > gauntlet.baseline.json`;
    expect(shouldBlock({ tool_name: "Bash", tool_input: { command } })).toBe(true);
  });

  it("二重引用の中の書き換え構文は無視される", () => {
    const command = `echo "sed -i tee rm > gauntlet.baseline.json の話" && ls gauntlet.baseline.json`;
    expect(shouldBlock({ tool_name: "Bash", tool_input: { command } })).toBe(false);
  });

  // 引用の外に構文があれば、引用の中に説明文が混ざっていても止める。
  it("引用の外の書き換えは引用に紛れない", () => {
    const command = `sed -i 's/"crap": 9/"crap": 99/' gauntlet.baseline.json`;
    expect(shouldBlock({ tool_name: "Bash", tool_input: { command } })).toBe(true);
  });
});

// commit 検出の regex を 1 部品ずつ。ここが緩むと #22（全 Bash で quick）か、
// 逆にコミットの素通り（検問の消滅）に倒れる。
describe("runsGitCommit の部品", () => {
  it.each([
    "  git commit",
    "FOO=bar BAZ=qux git commit",
    "git -c core.editor=true commit",
    "git --no-pager commit",
    "git -C /a -c x=y --no-pager commit -m 'z'",
  ])("コミットに届く形: %s", (command) => {
    expect(runsGitCommit(command)).toBe(true);
  });

  it.each([
    "gito commit",
    "git commitx",
    "mygit commit",
    "git recommit",
    "git log --grep commit",
    "FOO=bar-git-commit ls",
  ])("コミットでない形: %s", (command) => {
    expect(runsGitCommit(command)).toBe(false);
  });
});
