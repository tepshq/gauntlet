import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { INIT_DEFAULTS, init, mergeGitignore, parseInitOptions, scopeReport } from "./init.ts";

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
    expect(init(root)).toEqual([
      "gauntlet.config.json",
      ".githooks/pre-commit",
      ".claude/settings.json",
      ".claude/skills/gauntlet-setup/SKILL.md",
      ".gitignore",
    ]);
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

  // 部分一致で確かめると、shebang や exec が消えても気づかない。
  // それは「検問所が起動しなくなっても緑」を意味する。
  it("pre-commit の中身を丸ごと固定する", () => {
    init(root);
    expect(read(".githooks/pre-commit")).toBe(
      "#!/bin/sh\n" +
        "# gauntlet quick — コミットを検問所にする。\n" +
        "#\n" +
        "# 赤なら exit 2 でコミットが中断する。履歴に入った状態はすべて検査済み、が不変条件。\n" +
        "# 有効にするには clone ごとに一度だけ:  git config core.hooksPath .githooks\n" +
        "exec npx gauntlet quick\n",
    );
  });

  // 実行ビットが無いと git はフックを黙って無視する = 走らないゲートが置いてあるだけになる。
  it("pre-commit に実行ビットを立てる", () => {
    init(root);
    expect(statSync(join(root, ".githooks/pre-commit")).mode & 0o111).not.toBe(0);
  });

  // 0.13 で pre-commit に一本化した。Stop を書くと遅いリポジトリで毎ターン数十秒かかる。
  it("Stop フックは書かない", () => {
    init(root);
    expect(settings().hooks.Stop).toBeUndefined();
  });

  it("PreToolUse フックの中身を丸ごと固定する", () => {
    init(root);
    expect(settings().hooks.PreToolUse).toEqual([
      {
        matcher: "Edit|Write|NotebookEdit|Bash",
        hooks: [{ type: "command", command: "npx gauntlet guard" }],
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

  it("二度実行してもフックは各 1 つ", () => {
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

describe("scopeReport", () => {
  function put(path: string): void {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "export const x = 1;\n");
  }

  it("測る対象の数を返す", () => {
    put("src/a.ts");
    put("src/b.ts");
    expect(scopeReport(root, INIT_DEFAULTS).matched).toBe(2);
  });

  // glob はディスクを見るので gitignore された生成物を拾う。duct では Prisma の
  // 生成クライアントが「測る対象 837」を水増しし、対象外の候補にも生成物が混ざった。
  it("gitignore された生成物は数えず、対象外の候補にも出さない", () => {
    writeFileSync(join(root, ".gitignore"), "src/generated.ts\ngen/\n");
    put("src/real.ts");
    put("src/generated.ts");
    put("gen/out.ts");
    const report = scopeReport(root, INIT_DEFAULTS);
    expect(report.matched).toBe(1);
    expect(report.unmatched).not.toContain("gen");
  });

  it("除外されたファイルは数えない", () => {
    put("src/a.ts");
    put("src/a.test.ts");
    expect(scopeReport(root, INIT_DEFAULTS).matched).toBe(1);
  });

  // 測る範囲が狭いまま緑になるのが一番気づけない失敗なので、取りこぼしを見せる。
  it("対象外に TypeScript がある場所を挙げる", () => {
    put("src/a.ts");
    put("bin/tool.ts");
    put("scripts/gen.ts");
    expect(scopeReport(root, INIT_DEFAULTS).unmatched).toEqual(["bin", "scripts"]);
  });

  it("取りこぼしが無ければ空", () => {
    put("src/a.ts");
    expect(scopeReport(root, INIT_DEFAULTS).unmatched).toEqual([]);
  });

  // 依存や生成物まで挙げると、本当に見るべき取りこぼしが埋もれる。
  it.each(["node_modules", "dist", "coverage"])("%s は取りこぼしに数えない", (dir) => {
    put("src/a.ts");
    put(`${dir}/pkg/index.ts`);
    expect(scopeReport(root, INIT_DEFAULTS).unmatched).toEqual([]);
  });

  // ルート直下の .ts はディレクトリではないので、場所として挙げても行動できない。
  it("ルート直下のファイルは取りこぼしに数えない", () => {
    put("src/a.ts");
    put("vitest.config.ts");
    expect(scopeReport(root, INIT_DEFAULTS).unmatched).toEqual([]);
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
