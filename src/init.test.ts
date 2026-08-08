import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { INIT_DEFAULTS, init, mergeGitignore, parseInitOptions, scopeReport } from "./init.ts";

// 出力の体裁ごと固定する。部分一致で見ると、改行の数や区切りが崩れても気づかない。
describe("mergeGitignore", () => {
  const ADDED = "# gauntlet の出力\ncoverage/\nreports/\n.stryker-tmp/\n";

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
    const existing = "coverage/\nreports/\n.stryker-tmp/\n";
    expect(mergeGitignore(existing)).toBe(existing);
  });

  it("足りないものだけ足す", () => {
    expect(mergeGitignore("coverage/\n")).toBe("coverage/\n\n# gauntlet の出力\nreports/\n.stryker-tmp/\n");
  });

  // 既存の .gitignore は字下げされていることがある。
  it("前後の空白を無視して既存判定する", () => {
    expect(mergeGitignore("  coverage/  \nreports/\n.stryker-tmp/\n")).toBe("  coverage/  \nreports/\n.stryker-tmp/\n");
  });
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gauntlet-init-"));
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
      ".claude/settings.json",
      ".claude/skills/gauntlet/SKILL.md",
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
      $schema: "./node_modules/@tepshq/gauntlet/schema/gauntlet.config.schema.json",
    });
  });

  it("skill に触ってはいけないものを書く", () => {
    init(root);
    const skill = read(".claude/skills/gauntlet/SKILL.md");
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
    init(root, { defaultBranch: "trunk", include: ["lib/**/*.ts"], exclude: [] });
    const config = parseConfig(read("gauntlet.config.json"), "test");
    expect(config.defaultBranch).toBe("trunk");
    expect(config.source.include).toEqual(["lib/**/*.ts"]);
  });

  // 部分一致で確かめると、matcher や type が空になっても気づかない。
  // それは「ガードが起動しなくなっても緑」を意味する。
  it("Stop フックの中身を丸ごと固定する", () => {
    init(root);
    expect(settings().hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "npx gauntlet run --tier=turn" }] },
    ]);
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
    expect(settings().hooks.Stop).toHaveLength(1);
    expect(settings().hooks.PreToolUse).toHaveLength(1);
  });

  // 他の用途で使っている設定を壊すと、導入そのものが敬遠される。
  it("既にある settings.json を壊さない", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude/settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [] }] } }),
    );
    init(root);
    const merged = JSON.parse(read(".claude/settings.json")) as { permissions: unknown; hooks: { Stop: unknown[] } };
    expect(merged.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(merged.hooks.Stop).toHaveLength(2);
  });

  it("既にある .gitignore を残して足す", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    init(root);
    expect(read(".gitignore")).toBe("node_modules/\n\n# gauntlet の出力\ncoverage/\nreports/\n.stryker-tmp/\n");
  });

  // CI の雛形は skill が持つ。ここが欠けると導入した CI が動かない。
  it.each([
    ["pr tier を回す", "--tier=pr"],
    ["履歴を全部取る（merge-base に要る）", "fetch-depth: 0"],
    ["Node は 22 以上（node:fs の globSync）", "node-version: 22"],
  ])("skill の CI 雛形は %s", (_label, expected) => {
    init(root);
    expect(read(".claude/skills/gauntlet/SKILL.md")).toContain(expected);
  });

  // 0.0.14 から public npm。認証の雛形が残っていると、それを写した導入先が
  // GitHub Packages を見に行って新しいバージョンが取れなくなる。
  // 語そのものは「古い設定を外せ」の案内に出てくるので、yaml の設定形（コロン付き）だけを禁じる。
  it.each([
    ["registry の指定", "registry-url:"],
    ["トークンの受け渡し", "NODE_AUTH_TOKEN:"],
  ])("skill の CI 雛形に %s は無い", (_label, gone) => {
    init(root);
    expect(read(".claude/skills/gauntlet/SKILL.md")).not.toContain(gone);
  });

  // 逆に「古い認証を見つけたら外す」案内は要る。移行期の導入先はまだ残している。
  it("skill は古い認証設定の掃除を案内する", () => {
    init(root);
    expect(read(".claude/skills/gauntlet/SKILL.md")).toContain("@tepshq:registry=https://npm.pkg.github.com");
  });

  // 既に動いている job に足すのが基本。生成ファイルは重複を生む。
  it("skill は既存の job に 1 行足す形を先に示す", () => {
    init(root);
    const skill = read(".claude/skills/gauntlet/SKILL.md");
    expect(skill.indexOf("足せる job がある場合")).toBeLessThan(skill.indexOf("足せる job が無い場合"));
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

  it("exclude のフラグを読む", () => {
    expect(parseInitOptions(["init", "--exclude=x/**,y/**"]).exclude).toEqual(["x/**", "y/**"]);
  });

  // 空の値で既定に戻らないと、`--include=` が「何も測らない」設定になる。
  it.each(["include", "exclude"] as const)("--%s= が空なら既定に戻す", (name) => {
    expect(parseInitOptions(["init", `--${name}=`])[name]).toEqual(INIT_DEFAULTS[name]);
  });
});
