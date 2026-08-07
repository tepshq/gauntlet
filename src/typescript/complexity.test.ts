import { describe, expect, it } from "vitest";
import { describeLocation } from "../report.ts";
import { ParseError, extractFunctions } from "./complexity.ts";

function ccOf(source: string): number {
  const found = extractFunctions("t.ts", source);
  return found[0]!.cc;
}

describe("循環的複雑度", () => {
  it("分岐が無ければ 1", () => {
    expect(ccOf("function f() { return 1; }")).toBe(1);
  });

  it.each([
    ["if", "function f(a) { if (a) return 1; return 2; }", 2],
    ["if/else は else を数えない", "function f(a) { if (a) return 1; else return 2; }", 2],
    ["else if は 2 つ目の if を数える", "function f(a) { if (a) return 1; else if (a) return 2; return 3; }", 3],
    ["for", "function f() { for (let i = 0; i < 3; i++) {} }", 2],
    ["for-of", "function f(xs) { for (const x of xs) {} }", 2],
    ["while", "function f(a) { while (a) {} }", 2],
    ["do-while", "function f(a) { do {} while (a); }", 2],
    ["三項演算子", "function f(a) { return a ? 1 : 2; }", 2],
    ["&&", "function f(a, b) { return a && b; }", 2],
    ["||", "function f(a, b) { return a || b; }", 2],
    ["??", "function f(a, b) { return a ?? b; }", 2],
    ["catch", "function f() { try {} catch (e) {} }", 2],
    ["case は数え、default は数えない", "function f(a) { switch (a) { case 1: break; default: break; } }", 2],
  ])("%s", (_label, source, expected) => {
    expect(ccOf(source)).toBe(expected);
  });

  // 入れ子の関数が外側の CC を押し上げると、小さな関数がコールバックのせいで赤くなる。
  it("入れ子の関数の分岐は外側に算入されない", () => {
    const found = extractFunctions("t.ts", "function outer(xs) { return xs.map((x) => (x ? 1 : 2)); }");
    expect(found.map((f) => f.cc)).toEqual([1, 2]);
  });

  it("入れ子の関数はそれぞれ別に数える", () => {
    const found = extractFunctions("t.ts", "function outer(a) { if (a) {} return () => { if (a) {} }; }");
    expect(found).toHaveLength(2);
    expect(found[0]!.cc).toBe(2);
    expect(found[1]!.cc).toBe(2);
  });
});

describe("関数の名前とスコープ", () => {
  function describeAll(source: string): string[] {
    return extractFunctions("t.ts", source).map((f) => describeLocation(f.location));
  }

  it.each([
    ["関数宣言", "function fetchUser() {}", "fetchUser"],
    ["変数に入れたアロー", "const fetchUser = () => {};", "fetchUser"],
    ["オブジェクトのプロパティ", "const o = { fetchUser() {} };", "fetchUser"],
    ["クラスのメソッド", "class S { fetchUser() {} }", "S > fetchUser"],
    ["export default", "export default function () {}", "default"],
  ])("%s", (_label, source, expected) => {
    expect(describeAll(source)[0]).toContain(expected);
  });

  // 実コードでは名前が直接取れる関数は 2〜3 割。残りを名指しできないと違反報告が使えない。
  it("無名のコールバックを囲うスコープで名指しする", () => {
    const found = describeAll("class S { load(xs) { return xs.map((x) => x); } }");
    expect(found[1]).toBe("t.ts:1 S > load > (anonymous)");
  });

  it("計算プロパティは名前にしない", () => {
    expect(describeAll("const k = 'a'; const o = { [k]() {} };")[0]).toContain("(anonymous)");
  });

  it("行番号は 1 始まり", () => {
    expect(describeAll("\n\nfunction f() {}")[0]).toBe("t.ts:3 f");
  });

  // 日本語のコメントや文字列が入ると、オフセットの単位を誤ると行がずれる。
  it("日本語があっても行番号がずれない", () => {
    expect(describeAll("// 日本語のコメント\nfunction f() {}")[0]).toBe("t.ts:2 f");
  });
});

describe("パース失敗", () => {
  // 読めないコードを黙って飛ばすと、そのファイルだけ無検査で緑になる。
  it("落ちる", () => {
    expect(() => extractFunctions("t.ts", "function ( {")).toThrow(ParseError);
  });

  it("ファイル名を含む", () => {
    expect(() => extractFunctions("src/bad.ts", "function ( {")).toThrow(/src\/bad\.ts/);
  });
});
