import { describe, expect, it } from "vitest";
import { MIN_TOKENS, jscpdArgs, parseDuplication } from "./duplication.ts";

// 呼び出しは必ず it の中で行う。describe の直下で値を作ると、
// 変異が有効になる前に計算が終わっていて、テストが変異を検知できない。
describe("jscpdArgs", () => {
  // 引数は丸ごと固定する。--silent が欠けるとフックの出力に jscpd のバナーが混ざり、
  // reporters がずれるとレポートが出ずに落ちる。
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
  const report = (total: object): string => JSON.stringify({ statistics: { total } });

  it("重複トークン数と対象ファイル数を読む", () => {
    expect(parseDuplication(report({ duplicatedTokens: 1090, sources: 837 }), "")).toEqual({
      duplicatedTokens: 1090,
      sources: 837,
    });
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
});
