import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { INIT_DEFAULTS, init, measuredFileCount, mergeGitignore, parseInitOptions } from "./init.ts";

// 出力の体裁ごと固定する。部分一致で見ると、改行の数や区切りが崩れても気づかない。
describe("mergeGitignore", () => {
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
const settings = (): { hooks: Record<string, { matcher?: string }[]> } =>
  JSON.parse(read(".claude/settings.json")) as { hooks: Record<string, { matcher?: string }[]> };

describe("init", () => {
  it("薄いファイルだけ置く", () => {
    expect(init(root).map((file) => file.path)).toEqual([
      "gauntlet.config.json",
      ".claude/settings.json",
      ".claude/skills/gauntlet-setup/SKILL.md",
      ".gitignore",
    ]);
  });

  // パスだけ並べると、読み手は「自分の settings.json が上書きされたか」を
  // 出力から判断できない。4 ファイルで振る舞いが 3 種類ある。
  it("初回は全部 作成 と言う", () => {
    expect(init(root).map((file) => file.note)).toEqual(["作成", "作成", "作成", "作成"]);
  });

  it("二度目は何をしたかを言い分ける", () => {
    init(root);
    expect(init(root).map((file) => file.note)).toEqual([
      "更新",
      "更新（既存の設定は残しました）",
      "更新",
      "変更なし",
    ]);
  });

  // 行数まで固定する。数字を見ないと、引き算が足し算に化けても気づかない
  //（mutation で実際に生き残った）。空行 + 見出し + 4 エントリで 6 行。
  it("足りない行だけ足した .gitignore は足した行数を言う", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    const gitignore = init(root).find((file) => file.path === ".gitignore");
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
    init(root);
    const skill = read(".claude/skills/gauntlet-setup/SKILL.md");
    expect(skill).toContain("name: gauntlet");
    expect(skill).toContain("gauntlet.baseline.json");
    expect(skill).toContain("gauntlet.config.json");
  });

  // 既定の exclude が消えると、テストファイル自身を測り始める。
  it("既定でテストファイルを除く", () => {
    init(root);
    expect(parseConfig(read("gauntlet.config.json"), "test").source).toEqual({
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    });
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
    expect(init(root)[0]!.note).toBe("更新（commands は残しました）");
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

  // 丸ごと固定する。`if` が消えれば全 Bash で quick が走り、matcher が壊れれば
  // コミットが素通りする — どちらも「気づけない失敗」なので部分一致では見ない。
  it("PreToolUse フックの中身を丸ごと固定する", () => {
    init(root);
    expect(settings().hooks.PreToolUse).toEqual([
      {
        matcher: "Edit|Write|NotebookEdit|Bash",
        hooks: [{ type: "command", command: "npx gauntlet guard" }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", if: "Bash(git commit *)", command: "npx gauntlet quick" }],
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

  // guard と quick の 2 つ。積み上がると 1 回のコミットで何度も検査が走る。
  it("何度実行してもフックは 2 つのまま", () => {
    init(root);
    init(root);
    init(root);
    expect(settings().hooks.PreToolUse).toHaveLength(2);
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
    init(root);
    expect(read(".claude/skills/gauntlet-setup/SKILL.md")).toContain(expected);
  });

  // 0.0.14 から public npm。認証の雛形が残っていると、それを写した導入先が
  // GitHub Packages を見に行って新しいバージョンが取れなくなる。
  // 語そのものは「古い設定を外せ」の案内に出てくるので、yaml の設定形（コロン付き）だけを禁じる。
  it.each([
    ["registry の指定", "registry-url:"],
    ["トークンの受け渡し", "NODE_AUTH_TOKEN:"],
  ])("skill の CI 雛形に %s は無い", (_label, gone) => {
    init(root);
    expect(read(".claude/skills/gauntlet-setup/SKILL.md")).not.toContain(gone);
  });

  // 逆に「古い認証を見つけたら外す」案内は要る。移行期の導入先はまだ残している。
  it("skill は古い認証設定の掃除を案内する", () => {
    init(root);
    expect(read(".claude/skills/gauntlet-setup/SKILL.md")).toContain("@tepshq:registry=https://npm.pkg.github.com");
  });

  // 既に動いている job に足すのが基本。生成ファイルは重複を生む。
  it("skill は既存の job に 1 行足す形を先に示す", () => {
    init(root);
    const skill = read(".claude/skills/gauntlet-setup/SKILL.md");
    expect(skill.indexOf("足せる job がある場合")).toBeLessThan(skill.indexOf("足せる job が無い場合"));
  });

  // 0.9.x 以前の skill 名は「gauntlet の全部」を名乗る大きさで、無関係な質問まで
  // 吸い込んでいた。置き直すとき古い方が残ると、似た skill が 2 枚並ぶ。
  it("旧名の skill（.claude/skills/gauntlet）を片付ける", () => {
    mkdirSync(join(root, ".claude/skills/gauntlet"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/gauntlet/SKILL.md"), "old");
    // 消してよいのは旧名ちょうど 1 つ。パスが 1 文字ずれて「もっと消す」ようになっても
    // 上の assert だけでは気づけないので、隣の無関係な skill が生きていることも見る。
    mkdirSync(join(root, ".claude/skills/other"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/other/SKILL.md"), "keep");
    init(root);
    expect(existsSync(join(root, ".claude/skills/gauntlet"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/gauntlet-setup/SKILL.md"))).toBe(true);
    expect(read(".claude/skills/other/SKILL.md")).toBe("keep");
  });
});

describe("measuredFileCount", () => {
  function put(path: string): void {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "export const x = 1;\n");
  }

  it("測る対象の数を返す", () => {
    put("src/a.ts");
    put("src/b.ts");
    expect(measuredFileCount(root, INIT_DEFAULTS)).toBe(2);
  });

  // glob はディスクを見るので gitignore された生成物を拾う。duct では Prisma の
  // 生成クライアントが「測る対象 837」を水増ししていた。
  it("gitignore された生成物は数えない", () => {
    writeFileSync(join(root, ".gitignore"), "src/generated.ts\n");
    put("src/real.ts");
    put("src/generated.ts");
    expect(measuredFileCount(root, INIT_DEFAULTS)).toBe(1);
  });

  it("除外されたファイルは数えない", () => {
    put("src/a.ts");
    put("src/a.test.ts");
    expect(measuredFileCount(root, INIT_DEFAULTS)).toBe(1);
  });

  // 0 件は「設定が現実とずれている」という一番大事な信号。
  it("範囲外しか無ければ 0", () => {
    put("bin/tool.ts");
    expect(measuredFileCount(root, INIT_DEFAULTS)).toBe(0);
  });
});

describe("parseInitOptions", () => {
  it("指定が無ければ既定値", () => {
    expect(parseInitOptions([])).toEqual(INIT_DEFAULTS);
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
    expect(parseInitOptions(["init", "--exclude=x/**,y/**"]).exclude).toEqual(["x/**", "y/**"]);
  });

  // 空の値で既定に戻らないと、`--include=` が「何も測らない」設定になる。
  it.each(["include", "exclude"] as const)("--%s= が空なら既定に戻す", (name) => {
    expect(parseInitOptions(["init", `--${name}=`])[name]).toEqual(INIT_DEFAULTS[name]);
  });
});
