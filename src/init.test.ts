import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.ts";
import { INIT_DEFAULTS, INIT_USAGE, formatInit, helpRequested, init, mergeGitignore, parseInitOptions, mergeSettings } from "./init.ts";

// 出力の体裁ごと固定する。部分一致で見ると、改行の数や区切りが崩れても気づかない。
// 0.21 以前が置いた quick 直呼びのフックを残すと、`if` を知らない版の Claude Code で
// 全 Bash に quick が走り続ける（precommit への差し替えが効かない）。
describe("mergeSettings の移行", () => {
  // 0.14〜0.22.0 が置いた 3 世代の配線をすべて 1 本に置き換える。残すと二重に走るか、
  // `if` の解釈が揺れる環境で全 Bash に quick が走り続ける。
  it.each([
    ["quick 直呼び（〜0.21）", { type: "command", if: "Bash(git commit *)", command: "npx gauntlet quick" }],
    ["precommit + if（0.22.0）", { type: "command", if: "Bash(git commit *)", command: "npx gauntlet precommit" }],
    ["guard 単独", { type: "command", command: "npx gauntlet guard" }],
  ])("旧配線を撤去して hook 1 本に置き換える: %s", (_name, entry) => {
    const legacy = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [entry] }] } });
    const merged = mergeSettings(legacy);
    expect(merged).not.toContain(JSON.stringify(entry.command));
    expect(merged).toContain('"npx gauntlet hook"');
  });

  it("他人のフックは撤去しない", () => {
    const theirs = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npx their-tool quick" }] }] },
    });
    expect(mergeSettings(theirs)).toContain("npx their-tool quick");
  });
});

describe("mergeGitignore", () => {
  // `coverage` はディレクトリにも当たるので `coverage/` を含む。h3 には元から
  // `coverage` があり、そこへ `coverage/` を足していた（動作は同じでも二度書きに見える）。
  it("末尾の / 違いは同じ行として扱う", () => {
    expect(mergeGitignore("coverage\nreports\n.stryker-tmp\n*.tsbuildinfo\n")).toBe(
      "coverage\nreports\n.stryker-tmp\n*.tsbuildinfo\n",
    );
  });

  // 逆向き（既存が広い方）も同じ。足りないものだけを足す。
  it("足りないものだけ足す", () => {
    expect(mergeGitignore("coverage/\n")).toBe(
      "coverage/\n\n# gauntlet の出力\nreports/\n.stryker-tmp/\n*.tsbuildinfo\n",
    );
  });
  // *.tsbuildinfo は既定の型チェック（tsc --noEmit --incremental）の検査キャッシュ。
  const ADDED = "# gauntlet の出力\ncoverage/\nreports/\n.stryker-tmp/\n*.tsbuildinfo\n";

  it("何も無ければ全部足す", () => {
    expect(mergeGitignore(null)).toBe(ADDED);
  });

  it("空でも全部足す", () => {
    expect(mergeGitignore("")).toBe(ADDED);
  });

  // 既存の .gitignore を壊すと、導入そのものが敬遠される。
  it("既にある行の後ろに空行を挟んで足す", () => {
    expect(mergeGitignore("node_modules/\n.env\n")).toBe(`node_modules/\n.env\n\n${ADDED}`);
  });

  it("末尾の改行が重なっても増やさない", () => {
    expect(mergeGitignore("node_modules/\n\n\n")).toBe(`node_modules/\n\n${ADDED}`);
  });

  it("全部揃っていれば一字も変えない", () => {
    const existing = "coverage/\nreports/\n.stryker-tmp/\n*.tsbuildinfo\n";
    expect(mergeGitignore(existing)).toBe(existing);
  });

  it("足りないものだけ足す", () => {
    expect(mergeGitignore("coverage/\n")).toBe("coverage/\n\n# gauntlet の出力\nreports/\n.stryker-tmp/\n*.tsbuildinfo\n");
  });

  // 既存の .gitignore は字下げされていることがある。
  it("前後の空白を無視して既存判定する", () => {
    const existing = "  coverage/  \nreports/\n.stryker-tmp/\n*.tsbuildinfo\n";
    expect(mergeGitignore(existing)).toBe(existing);
  });
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gauntlet-init-"));
  // scopeReport は「リポジトリが所有するファイル」で数えるので、git が要る。
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (path: string): string => readFileSync(join(root, path), "utf8");
/**
 * skill の正本。0.17.0 で init の生成物からリポジトリ直下のファイルになった
 * （配布は `npx skills add tepshq/gauntlet -a claude-code`）。
 */
const skillSource = (): string => readFileSync("skills/gauntlet-setup/SKILL.md", "utf8");
const settings = (): { hooks: Record<string, { matcher?: string }[]> } =>
  JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, { matcher?: string }[]> };

describe("init", () => {
  it("薄いファイルだけ置く", () => {
    expect(init(root).files.map((file) => file.path)).toEqual([
      "gauntlet.config.json",
      ".claude/settings.json",
      ".gitignore",
    ]);
  });

  // パスだけ並べると、読み手は「自分の settings.json が上書きされたか」を
  // 出力から判断できない。4 ファイルで振る舞いが 3 種類ある。
  it("初回は全部 作成 と言う", () => {
    expect(init(root).files.map((file) => file.note)).toEqual(["作成", "作成", "作成"]);
  });

  // settings.json は存在の有無だけで「更新」と言っていた（#47）。内容が同一の回に
  //「更新」と出ると、本当に配線が変わった回（0.23.4 → 0.25.0 のフック形の変更など）と
  // 出力で区別できない。
  it("何も変わらない二度目は全部 変更なし と言う", () => {
    init(root);
    expect(init(root).files.map((file) => file.note)).toEqual(["変更なし", "変更なし", "変更なし"]);
  });

  // 「変更なし」は言葉どおり触らない。書き直すと mtime が動き、watcher や
  // インクリメンタルビルドが無駄に反応する。
  it("内容が同一なら settings.json を書き直さない", () => {
    init(root);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(root, ".claude/settings.json"), past, past);
    init(root);
    expect(statSync(join(root, ".claude/settings.json")).mtime).toEqual(past);
  });

  // 出し分けの「更新」側。旧配線からの移行では実際に内容が変わるので、そこは更新と言う。
  it("settings.json が実際に変わる回は 更新 と言う", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude/settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npx gauntlet quick" }] }] },
      }),
    );
    const file = init(root).files.find((entry) => entry.path === ".claude/settings.json");
    expect(file!.note).toBe("更新（既存の設定は残しました）");
  });

  // config も同じ性質で守る。同じ範囲を渡し直した回は「更新」ではない。
  it("同じ範囲を指定し直した二度目の config は 変更なし と言う", () => {
    const options = { defaultBranch: "main", include: ["lib/**/*.ts"], exclude: [], testProjects: [] };
    init(root, options);
    expect(init(root, options).files[0]).toEqual({ path: "gauntlet.config.json", note: "変更なし" });
  });

  // 新しいフックを取り込むために叩き直した人が、測る範囲を既定値に戻された
  // （lib/** で運用していたリポジトリが src/** に化ける）。commands 消失と同じ形。
  it("範囲の指定が無ければ既存の config に触らない", () => {
    init(root, { defaultBranch: "trunk", include: ["lib/**/*.ts"], exclude: [], testProjects: ["unit"] });
    const before = read("gauntlet.config.json");

    const result = init(root);

    expect(read("gauntlet.config.json")).toBe(before);
    expect(result.files[0]).toEqual({ path: "gauntlet.config.json", note: "変更なし" });
  });

  // 壊れた config を既定値で上書きすると、手書きの範囲が消える。読めない config は
  // 実行時に ConfigError で落ちるので、黙って進むことはない。
  it("読めない config も範囲の指定が無ければ残す", () => {
    writeFileSync(join(root, "gauntlet.config.json"), "{ broken");
    init(root);
    expect(read("gauntlet.config.json")).toBe("{ broken");
  });

  it("範囲を指定すれば書き換える", () => {
    init(root);
    const result = init(root, { defaultBranch: "main", include: ["lib/**/*.ts"], exclude: [], testProjects: [] });
    expect(parseConfig(read("gauntlet.config.json"), "test").source.include).toEqual(["lib/**/*.ts"]);
    // 書き換えたことを出力でも言う。0.17.0 で skill を書かなくなり、config が
    //「更新」を出す唯一の経路になった（mutation で検査漏れとして出た）。
    expect(result.files[0]!.note).toBe("更新");
  });

  // 案内が要るのは、まだ範囲が決まっていないときだけ。設定済みのリポジトリを
  // 更新した回に「セットアップしてください」と出すと雑音になる。
  it("config を作った回だけ次の一歩を要求する", () => {
    expect(init(root).needsSetup).toBe(true);
    expect(init(root).needsSetup).toBe(false);
  });

  it("範囲を指定した回は案内しない", () => {
    expect(init(root, INIT_DEFAULTS).needsSetup).toBe(false);
  });

  // 行数まで固定する。数字を見ないと、引き算が足し算に化けても気づかない
  //（mutation で実際に生き残った）。空行 + 見出し + 4 エントリで 6 行。
  it("足りない行だけ足した .gitignore は足した行数を言う", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    const gitignore = init(root).files.find((file) => file.path === ".gitignore");
    expect(gitignore!.note).toBe("更新（6 行追加）");
  });

  // CI が要るもの（サービスコンテナ・マイグレーション・Node のバージョン・認証）は
  // gauntlet からは見えない。置くと既存 CI と重複し、手で足したものが再実行で消える。
  it("CI workflow は置かない", () => {
    init(root);
    expect(existsSync(join(root, ".github/workflows/gauntlet.yml"))).toBe(false);
  });

  it("書いた config が自分のスキーマを通る", () => {
    init(root);
    expect(() => parseConfig(read("gauntlet.config.json"), "test")).not.toThrow();
  });

  // $schema が壊れるとエディタでの検証が黙って効かなくなる。
  it("同梱スキーマへの $schema を書く", () => {
    init(root);
    expect(JSON.parse(read("gauntlet.config.json"))).toMatchObject({
      $schema: "./node_modules/@teps/gauntlet/schema/gauntlet.config.schema.json",
    });
  });

  it("skill に触ってはいけないものを書く", () => {
    const skill = skillSource();
    expect(skill).toContain("name: gauntlet");
    expect(skill).toContain("gauntlet.baseline.json");
    expect(skill).toContain("gauntlet.config.json");
  });

  // 除外は「生成物」「e2e」などに今も要る。書いたものが落ちると範囲が黙って広がる。
  it("渡した除外は config に入れる", () => {
    init(root, { ...INIT_DEFAULTS, exclude: ["lib/generated/**"] });
    expect(parseConfig(read("gauntlet.config.json"), "test").source).toEqual({
      include: ["src/**/*.ts"],
      exclude: ["lib/generated/**"],
    });
  });

  // テストは gauntlet が自動で外す（0.20.0）。既定に書いておくと
  // 「テストは自分で外すもの」と読ませてしまうし、空の配列は設定の飾りになる。
  it("除外が無ければ exclude を書かない", () => {
    init(root);
    expect(parseConfig(read("gauntlet.config.json"), "test").source).toEqual({ include: ["src/**/*.ts"] });
  });

  it("指定した値を config に入れる", () => {
    init(root, { defaultBranch: "trunk", include: ["lib/**/*.ts"], exclude: [], testProjects: [] });
    const config = parseConfig(read("gauntlet.config.json"), "test");
    expect(config.defaultBranch).toBe("trunk");
    expect(config.source.include).toEqual(["lib/**/*.ts"]);
  });

  // 宣言は正の選択（DESIGN §2）。空なら config にキー自体を書かない —
  // 「書いていない」と「空で書いた」の区別が schema 検証（minItems 1）で守られる。
  it("走らせる project の宣言を config に入れる", () => {
    init(root, { defaultBranch: "main", include: ["lib/**/*.ts"], exclude: [], testProjects: ["node", "dom"] });
    const config = parseConfig(read("gauntlet.config.json"), "test");
    expect(config.tests).toEqual({ projects: ["node", "dom"] });
  });

  it("宣言が無ければ tests キーを書かない", () => {
    init(root, { defaultBranch: "main", include: ["lib/**/*.ts"], exclude: [], testProjects: [] });
    expect(parseConfig(read("gauntlet.config.json"), "test").tests).toBeUndefined();
  });

  // init にフラグが無く skill が「手で書く」と案内しているキー。全上書きしていた頃は
  // 範囲を直すために init を叩き直すと黙って消え、2 パス型チェックのリポジトリが
  // 既定の tsc --noEmit に落ちて「半分しか見ないまま緑」になっていた。
  it("再実行しても手で書いた commands を残す", () => {
    init(root);
    const config = JSON.parse(read("gauntlet.config.json")) as Record<string, unknown>;
    config.commands = { typecheck: "tsc -p tsconfig.src.json --noEmit && tsc --noEmit" };
    writeFileSync(join(root, "gauntlet.config.json"), `${JSON.stringify(config, null, 2)}\n`);

    init(root, { defaultBranch: "main", include: ["lib/**/*.ts"], exclude: [], testProjects: [] });

    const after = parseConfig(read("gauntlet.config.json"), "test");
    expect(after.commands).toEqual({ typecheck: "tsc -p tsconfig.src.json --noEmit && tsc --noEmit" });
    // 残すのは commands だけ。フラグで管理するキーは指定どおり上書きする。
    expect(after.source.include).toEqual(["lib/**/*.ts"]);
  });

  it("commands を残したことを出力で言う", () => {
    init(root);
    const config = JSON.parse(read("gauntlet.config.json")) as Record<string, unknown>;
    config.commands = { typecheck: "tsc --noEmit" };
    writeFileSync(join(root, "gauntlet.config.json"), `${JSON.stringify(config, null, 2)}\n`);
    const written = init(root, { defaultBranch: "main", include: ["lib/**/*.ts"], exclude: [], testProjects: [] });
    expect(written.files[0]!.note).toBe("更新（commands は残しました）");
  });

  // 推測で既存の設定を捨てるくらいなら止まる。フックが 1 つ消えれば、
  // そのリポジトリのゲートが黙って無効になる。
  it("読めない settings.json では 1 つも書かずに落ちる", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude/settings.json"), '{\n  // コメント\n  "hooks": {}\n}\n');
    expect(() => init(root)).toThrow(/settings.json が JSON として読めません/);
    expect(existsSync(join(root, "gauntlet.config.json"))).toBe(false);
  });

  // 原因（読めない）だけでは直せない。直し方まで言えているかを見る —
  // 助言の一文は mutation で消しても誰も気づかなかった。
  it("読めない settings.json では直し方まで言う", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude/settings.json"), "{ broken");
    expect(() => init(root)).toThrow(
      /コメントや末尾のカンマがあれば外してください（Claude Code の設定は厳密な JSON です）。$/,
    );
  });

  // 0.14 で起動点を guard（PreToolUse）に集約した。git のフックは配線
  //（core.hooksPath）が clone ごとに要り、忘れた人には静かに効かない。
  it("git のフックは置かない", () => {
    init(root);
    expect(existsSync(join(root, ".githooks"))).toBe(false);
  });

  // Stop（0.12 以前）を書くと遅いリポジトリで毎ターン数十秒かかる。
  it("Stop フックは書かない", () => {
    init(root);
    expect(settings().hooks.Stop).toBeUndefined();
  });

  // 丸ごと固定する。matcher が壊れればコミットが素通りする — 「気づけない失敗」なので
  // 部分一致では見ない。`if` は**書かない**（同一マシンで解釈が揺れた実測がある。#22）。
  it("PreToolUse フックの中身を丸ごと固定する", () => {
    init(root);
    expect(settings().hooks.PreToolUse).toEqual([
      {
        matcher: "Edit|Write|NotebookEdit|Bash",
        hooks: [{ type: "command", command: "npx gauntlet hook" }],
      },
    ]);
  });

  // init は測る範囲を直すたびに叩かれる。積み上げると毎ターン何度も gauntlet が走る。
  it("二度実行してもフックが増えない", () => {
    init(root);
    const once = read(".claude/settings.json");
    init(root);
    expect(read(".claude/settings.json")).toBe(once);
  });

  // 統合された 1 本だけ。積み上がると 1 回のコミットで何度も検査が走る。
  it("何度実行してもフックは 1 つのまま", () => {
    init(root);
    init(root);
    init(root);
    expect(settings().hooks.PreToolUse).toHaveLength(1);
  });

  // 他の用途で使っている設定を壊すと、導入そのものが敬遠される。
  // リポジトリ自前の Stop フックは他人の持ち物 — 消さず、gauntlet のものも足さない。
  it("既にある settings.json を壊さない", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [] }] } }),
    );
    init(root);
    const merged = JSON.parse(read(".claude/settings.json")) as { permissions: unknown; hooks: { Stop: unknown[] } };
    expect(merged.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(merged.hooks.Stop).toHaveLength(1);
  });

  it("既にある .gitignore を残して足す", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    init(root);
    expect(read(".gitignore")).toBe("node_modules/\n\n# gauntlet の出力\ncoverage/\nreports/\n.stryker-tmp/\n*.tsbuildinfo\n");
  });

  // CI の雛形は skill が持つ。ここが欠けると導入した CI が動かない。
  it.each([
    ["full tier を回す", "npx gauntlet full"],
    ["履歴を全部取る（merge-base に要る）", "fetch-depth: 0"],
    ["Node は 22 以上（node:fs の globSync）", "node-version: 22"],
  ])("skill の CI 雛形は %s", (_label, expected) => {
    expect(skillSource()).toContain(expected);
  });

  // 0.0.14 から public npm。認証の雛形が残っていると、それを写した導入先が
  // GitHub Packages を見に行って新しいバージョンが取れなくなる。
  // 語そのものは「古い設定を外せ」の案内に出てくるので、yaml の設定形（コロン付き）だけを禁じる。
  it.each([
    ["registry の指定", "registry-url:"],
    ["トークンの受け渡し", "NODE_AUTH_TOKEN:"],
  ])("skill の CI 雛形に %s は無い", (_label, gone) => {
    expect(skillSource()).not.toContain(gone);
  });

  // 逆に「古い認証を見つけたら外す」案内は要る。移行期の導入先はまだ残している。
  it("skill は古い認証設定の掃除を案内する", () => {
    expect(skillSource()).toContain("@tepshq:registry=https://npm.pkg.github.com");
  });

  // 既に動いている job に足すのが基本。生成ファイルは重複を生む。
  it("skill は既存の job に 1 行足す形を先に示す", () => {
    const skill = skillSource();
    expect(skill.indexOf("既に動いている job に 1 行足す")).toBeLessThan(skill.indexOf("足せる job が無ければ作る"));
  });

});

// 出力そのものが導入者への案内なので、体裁ごと固定する。main.ts に置くと
// テストできない場所に判断が溜まり、実際 CRAP 12 でゲートに止められた。
describe("formatInit", () => {
  const files = [
    { path: "gauntlet.config.json", note: "作成" },
    { path: ".claude/settings.json", note: "更新（既存の設定は残しました）" },
  ];

  it("パスを揃えて、何をしたかを添える", () => {
    expect(formatInit({ files, needsSetup: false })).toBe(
      "  gauntlet.config.json   作成\n  .claude/settings.json  更新（既存の設定は残しました）\n",
    );
  });

  // 案内は丸ごと固定する。「何をしてくれるのか」の一文を消しても
  // /gauntlet-setup の部分一致では気づけない（mutation で実際に生き残った）。
  it("範囲がまだなら次の一歩を案内する", () => {
    expect(formatInit({ files, needsSetup: true })).toBe(
      "  gauntlet.config.json   作成\n" +
        "  .claude/settings.json  更新（既存の設定は残しました）\n" +
        "\n次: Claude Code で /gauntlet-setup を実行してください\n" +
        "（無ければ npx skills add tepshq/gauntlet -a claude-code で入ります）\n",
    );
  });

  // 設定済みのリポジトリを更新した回に「セットアップしてください」は雑音。
  it("範囲が決まっていれば案内しない", () => {
    expect(formatInit({ files, needsSetup: false })).not.toContain("/gauntlet-setup");
  });
});

// h3 の導入で、エージェントが `init --help` を叩いたら実行され、決めた測る範囲が
// 既定値（src/**）に戻された。ヘルプは実行の前に見る。
describe("helpRequested", () => {
  it.each([["--help"], ["-h"]])("%s はヘルプ", (flag) => {
    expect(helpRequested(["init", flag])).toBe(true);
  });

  it("範囲の指定はヘルプではない", () => {
    expect(helpRequested(["init", "--include=src/**/*.ts"])).toBe(false);
  });

  it("引数が無ければヘルプではない", () => {
    expect(helpRequested([])).toBe(false);
  });
});

describe("INIT_USAGE", () => {
  // 何が指定できるか分からないと、打ち間違いを直せない。
  it.each([["--default-branch"], ["--include"], ["--exclude"], ["--test-projects"]])(
    "%s を挙げる",
    (flag) => {
      expect(INIT_USAGE).toContain(flag);
    },
  );

  // フラグ無しで叩いても範囲が消えないことは、使う前に知っている必要がある。
  it("フラグ無しの意味を言う", () => {
    expect(INIT_USAGE).toContain("既存の測る範囲には触りません");
  });
});

describe("parseInitOptions", () => {
  // null = 範囲の指定なし。init はこれを見て既存の config に触らないと決める
  //（既定値を返すと、叩き直すたびに測る範囲が src/** に戻る事故になる）。
  it.each([[[] as string[]], [["init"]]])("フラグが無ければ null: %j", (argv) => {
    expect(parseInitOptions(argv)).toBe(null);
  });

  // 打ち間違いを素通しすると、既定値で書いたのに「指定したつもり」の設定が残る。
  it("知らないフラグは止める", () => {
    expect(() => parseInitOptions(["init", "--includes=src/**/*.ts"])).toThrow(
      /init が知らない指定です: --includes/,
    );
  });

  // 文言を丸ごと固定する。未知フラグを 1 つしか渡さないと、区切り（join の空白）や
  // 使い方との間の空行が消えても気づかない（mutation で実際に生き残った）。
  it("知らないフラグを全部挙げ、使い方を添える", () => {
    expect(() => parseInitOptions(["init", "--nope", "--typo=x"])).toThrow(
      `init が知らない指定です: --nope --typo\n\n${INIT_USAGE}`,
    );
  });

  it("落ちるときは ConfigError", () => {
    expect(() => parseInitOptions(["init", "--typo"])).toThrow(ConfigError);
  });

  // 知っているフラグが混ざっていても、知らないものがあれば止める。
  it("既知と混ざっていても止める", () => {
    expect(() => parseInitOptions(["init", "--include=a/**", "--nope"])).toThrow(/--nope/);
  });

  it("フラグを読む", () => {
    expect(parseInitOptions(["init", "--default-branch=trunk", "--include=a/**,b/**"])).toMatchObject({
      defaultBranch: "trunk",
      include: ["a/**", "b/**"],
    });
  });

  it("test-projects のフラグを読む", () => {
    expect(parseInitOptions(["--test-projects=node,dom"])).toMatchObject({ testProjects: ["node", "dom"] });
  });

  it("exclude のフラグを読む", () => {
    expect(parseInitOptions(["init", "--exclude=x/**,y/**"])!.exclude).toEqual(["x/**", "y/**"]);
  });

  // 空の値で既定に戻らないと、`--include=` が「何も測らない」設定になる。
  it.each(["include", "exclude"] as const)("--%s= が空なら既定に戻す", (name) => {
    expect(parseInitOptions(["init", `--${name}=`])![name]).toEqual(INIT_DEFAULTS[name]);
  });
});
