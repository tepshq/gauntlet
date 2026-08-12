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
    // case と default が 1 つずつだと、どちらを数えるか入れ替えても合計が同じになる
    // （実測: `!=` を `==` にしても 2 のままで通っていた）。case を 2 つにして数を割る。
    [
      "case は数え、default は数えない",
      "function f(a) { switch (a) { case 1: break; case 2: break; default: break; } }",
      3,
    ],
  ])("%s", (_label, source, expected) => {
    expect(ccOf(source)).toBe(expected);
  });

  // 関数の外の分岐を拾うと、囲む関数が無い場所で数えようとして落ちるか、
  // 無関係な関数の CC が上がる。どちらも「触った関数」の判定を狂わせる。
  it("関数の外の分岐はどの関数にも算入しない", () => {
    const found = extractFunctions("t.ts", "const ok = a || b;\nfunction f() { return 1; }");
    expect(found.map((fn) => fn.cc)).toEqual([1]);
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
    // 識別子にできない名前は文字列キーで書かれる。Identifier と同じ扱いにすると
    // `key.name` が undefined になり、名前が "undefined" になる。
    ["文字列キーのメソッド", `const o = { "fetch-user"() {} };`, "fetch-user"],
    // private メソッドは `(anonymous)` になっていた（mutation の生き残りから発覚）。
    // 名指しできない違反報告は使えないので、`#` ごと名前にする。
    ["private メソッド", "class S { #load() {} }", "S > #load"],
  ])("%s", (_label, source, expected) => {
    expect(describeAll(source)[0]).toContain(expected);
  });

  // クラス式にも名前が付く。宣言だけを見ていると、この形の中の関数が
  // クラス名を失って `load` とだけ名乗る（同名メソッドが並ぶと見分けられない）。
  it("名前つきクラス式もスコープに積む", () => {
    expect(describeAll("const S = class Inner { load() {} };")[0]).toBe("t.ts:1 Inner > load");
  });

  // 関数でも クラスでもないものをスコープに積むと、名前が実在しない階層で伸びる。
  // `toContain` では増えた分を見逃すので、ここは全体を固定する。
  it("入れ物の変数名はスコープに積まない", () => {
    expect(describeAll("const holder = { run: () => {} };")[0]).toBe("t.ts:1 run");
  });

  // 積んだ名前を戻し忘れると、後ろに並んだものが前の名前を引き継ぐ。
  it("スコープを抜けたら名前を戻す", () => {
    const found = describeAll("class A { load() {} }\nclass B { save() {} }");
    expect(found[1]).toBe("t.ts:2 B > save");
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

  // 型では ParseError でも、表示に出るのは name。既定の "Error" のままだと
  // 出力を読む側が「gauntlet が落ちた」と「ソースが読めない」を区別できない。
  it("名前を名乗る", () => {
    let thrown: Error | null = null;
    try {
      extractFunctions("t.ts", "function ( {");
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.name).toBe("ParseError");
  });

  it("ファイル名を含む", () => {
    expect(() => extractFunctions("src/bad.ts", "function ( {")).toThrow(/src\/bad\.ts/);
  });
});
