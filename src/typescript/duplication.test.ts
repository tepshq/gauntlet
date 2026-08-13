import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIN_TOKENS, jscpdArgs, parseDuplication, relativizeClones, runDuplication } from "./duplication.ts";

// 呼び出しは必ず it の中で行う。describe の直下で値を作ると、
// 変異が有効になる前に計算が終わっていて、テストが変異を検知できない。
describe("jscpdArgs", () => {
  // 引数は丸ごと固定する。--silent が欠けるとフックの出力に jscpd のバナーが混ざり、
  // reporters がずれるとレポートが出ずに落ちる。--absolute が欠けるとクローンの
  // ファイル名が空文字になり、`list` が `(空) ↔ (空)` を並べる（#41）。
  it("丸ごと固定する", () => {
    expect(jscpdArgs(["src/a.ts", "src/b.ts"], "/tmp/out")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "--min-tokens",
      "50",
      "--reporters",
      "json",
      "--output",
      "/tmp/out",
      "--silent",
      "--absolute",
    ]);
  });

  // 対象は glob ではなく解決済みのファイル一覧。CRAP と同一の集合であることの保証。
  it("ファイルを位置引数の先頭に置く", () => {
    expect(jscpdArgs(["a.ts"], "/o")[0]).toBe("a.ts");
  });

  it("閾値は全社で 1 つ", () => {
    expect(MIN_TOKENS).toBe(50);
  });
});

describe("parseDuplication", () => {
  const report = (total: object, duplicates: unknown = []): string =>
    JSON.stringify({ statistics: { total }, duplicates });
  const clone = (first: unknown, second: unknown, tokens: unknown): unknown => ({
    firstFile: { name: first },
    secondFile: { name: second },
    tokens,
  });

  it("重複トークン数と対象ファイル数を読む", () => {
    expect(parseDuplication(report({ duplicatedTokens: 1090, sources: 837 }), "")).toEqual({
      duplicatedTokens: 1090,
      sources: 837,
      clones: [],
    });
  });

  it("クローンをファイルの対とトークン数で読む", () => {
    const text = report({ duplicatedTokens: 124, sources: 26 }, [clone("/r/src/a.ts", "/r/src/b.ts", 124)]);
    expect(parseDuplication(text, "").clones).toEqual([{ files: ["/r/src/a.ts", "/r/src/b.ts"], tokens: 124 }]);
  });

  // 読めないまま 0 と扱うと、重複ゲートが実質無効になっても緑になる。
  it.each([
    ["JSON でない", "Error: oops"],
    ["statistics が無い", "{}"],
  ])("%s なら落とす", (_label, text) => {
    expect(() => parseDuplication(text, "jscpd stderr")).toThrow(/jscpd のレポートを読めません/);
  });

  // 片方だけ欠けた形で試すと、もう片方の検査が無くても通ってしまう
  // （実測: duplicatedTokens 側の検査を外しても緑のままだった）。両方向から試す。
  it.each([
    ["sources が無い", { duplicatedTokens: 3 }],
    ["duplicatedTokens が無い", { sources: 837 }],
    ["duplicatedTokens が数値でない", { duplicatedTokens: "3", sources: 837 }],
  ])("%s なら落とす", (_label, total) => {
    expect(() => parseDuplication(report(total), "detail")).toThrow(/statistics\.total がありません/);
  });

  it("落ちるときに jscpd の出力を添える", () => {
    expect(() => parseDuplication("broken", "手がかりになる出力")).toThrow(/手がかりになる出力/);
  });

  // 名前が空文字で返るのは `--absolute` が落ちた形。並べても `(空) ↔ (空)` にしか
  // ならず、#41 が報告した「総数は出るが辿り着けない」状態に戻る。
  it.each([
    ["先のファイル名が空", clone("", "/r/b.ts", 124)],
    ["後のファイル名が空", clone("/r/a.ts", "", 124)],
    ["ファイル名が null", clone(null, "/r/b.ts", 124)],
    // 空文字でも null でもない別物。ここを見ていないと、名前でない値がそのまま
    // 一覧に並ぶ（`42 ↔ src/b.ts`）。
    ["ファイル名が文字列でない", clone(42, "/r/b.ts", 124)],
    // 欄ごと無い形。`?.` を落とすと RunnerError ではなく TypeError になり、
    // 「jscpd の形が変わった」と読めるメッセージが出なくなる。
    ["先のファイルの欄が無い", { secondFile: { name: "/r/b.ts" }, tokens: 124 }],
    ["トークン数が数値でない", clone("/r/a.ts", "/r/b.ts", "124")],
  ])("%s なら落とす", (_label, duplicate) => {
    expect(() => parseDuplication(report({ duplicatedTokens: 124, sources: 26 }, [duplicate]), "detail")).toThrow(
      /--absolute が効いていない/,
    );
  });

  // 総数だけ読めても、内訳の欄ごと消えていれば形が変わったということ。
  it("duplicates が無ければ落とす", () => {
    expect(() => parseDuplication(JSON.stringify({ statistics: { total: { duplicatedTokens: 0, sources: 2 } } }), "d")).toThrow(
      /duplicates がありません/,
    );
  });
});

/**
 * 同梱 jscpd を実際に走らせる唯一のテスト。**symlink 越しの root で試す。**
 *
 * `--absolute` が返す名前は realpath 解決済みなので、root が symlink だと
 * `relative(root, name)` が `../../…` に化ける。macOS の mkdtemp がまさにこの形
 * （`/var` → `/private/var`）だが、Linux の CI では踏まない — **プラットフォームで
 * 意味が変わるテストにしない**ために、symlink を明示的に作って両方で同じことを試す。
 */
describe("runDuplication", () => {
  const body = Array.from({ length: 20 }, (_unused, i) => `  const v${i} = f${i}(a${i}, b${i}) + g${i}(c${i}, d${i}) * s${i};`).join("\n");
  let real = "";
  let link = "";
  beforeEach(() => {
    real = mkdtempSync(join(tmpdir(), "gauntlet-dup-real-"));
    link = join(mkdtempSync(join(tmpdir(), "gauntlet-dup-link-")), "root");
    symlinkSync(real, link);
    mkdirSync(join(real, "src"));
    for (const name of ["alpha", "beta"]) {
      writeFileSync(join(real, "src", `${name}.ts`), `export function ${name}(a: number): number {\n${body}\n  return a;\n}\n`);
    }
  });
  afterEach(() => {
    rmSync(real, { recursive: true, force: true });
    rmSync(link, { force: true });
  });

  it("symlink 越しの root でもリポジトリからの相対パスで返す", () => {
    const result = runDuplication(link, ["src/alpha.ts", "src/beta.ts"]);
    expect(result.duplicatedTokens).toBeGreaterThan(MIN_TOKENS);
    expect(result.clones).toEqual([{ files: ["src/alpha.ts", "src/beta.ts"], tokens: result.duplicatedTokens }]);
  });

  // #41 の本題。`--absolute` が無いと名前は空文字で返り、数だけが残る。
  it("重複が無ければクローンも返さない", () => {
    expect(runDuplication(link, ["src/alpha.ts"])).toEqual({ duplicatedTokens: 0, sources: 1, clones: [] });
  });

  // jscpd のレポートは毎回 tmp に出す。後始末を落とすと `full` を回すたびに溜まる
  // （消えるのは CI の使い捨てコンテナだけで、手元には残り続ける）。
  //
  // **共有の tmp を数えない。** 最初はそこで数えていて、`run.test.ts` の jscpd 実行と
  // 競って 14 回に 1 回落ちた（vitest はファイルを並列に走らせる）。走るたびに答えが
  // 変わるテストは、数回の食い違いで無視されるようになる。TMPDIR を自分専用に向けて、
  // **自分が作ったものだけを見る**（vitest はファイルごとに別プロセスなので env は競らない）。
  it("一時ディレクトリを残さない", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "gauntlet-tmproot-"));
    const saved = process.env["TMPDIR"];
    process.env["TMPDIR"] = sandbox;
    try {
      runDuplication(link, ["src/alpha.ts", "src/beta.ts"]);
    } finally {
      if (saved === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = saved;
    }
    expect(readdirSync(sandbox)).toEqual([]);
    rmSync(sandbox, { recursive: true, force: true });
  });
});

describe("relativizeClones", () => {
  it("基準からの相対パスに直す", () => {
    expect(relativizeClones("/r", [{ files: ["/r/src/a.ts", "/r/src/b.ts"], tokens: 97 }])).toEqual([
      { files: ["src/a.ts", "src/b.ts"], tokens: 97 },
    ]);
  });

  it("クローンが無ければ何も返さない", () => {
    expect(relativizeClones("/r", [])).toEqual([]);
  });
});
