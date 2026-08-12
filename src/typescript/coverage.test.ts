import { describe, expect, it } from "vitest";
import { type ExtractedFunction, extractFunctions } from "./complexity.ts";
import { type IstanbulFileCoverage, coverageByFunction } from "./coverage.ts";

type Statement = [line: number, column: number, hits: number];

/** Istanbul のファイル被覆データを組み立てる。 */
function fileCoverage(statements: readonly Statement[]): IstanbulFileCoverage {
  const statementMap: IstanbulFileCoverage["statementMap"] = {};
  const s: IstanbulFileCoverage["s"] = {};
  statements.forEach(([line, column, hits], index) => {
    statementMap[String(index)] = { start: { line, column } };
    s[String(index)] = hits;
  });
  // f は coveredFiles だけが読む（網羅率は文で測る）。ここでは要らないので空。
  return { statementMap, s, f: {} };
}

function rates(source: string, statements: readonly Statement[]): [string, number][] {
  const functions = extractFunctions("t.ts", source);
  const map = coverageByFunction(functions, fileCoverage(statements));
  return functions.map((fn: ExtractedFunction) => [fn.location.name ?? "(anonymous)", map.get(fn)!]);
}

const NESTED = `function outer(xs) {
  const a = 1;
  return xs.map((x) => {
    const b = 2;
    return b;
  });
}`;

describe("coverageByFunction", () => {
  it("全て通っていれば 1", () => {
    expect(rates("function f() {\n  const a = 1;\n}", [[2, 2, 3]])).toEqual([["f", 1]]);
  });

  it("全く通っていなければ 0", () => {
    expect(rates("function f() {\n  const a = 1;\n}", [[2, 2, 0]])).toEqual([["f", 0]]);
  });

  it("半分なら 0.5", () => {
    const source = "function f() {\n  const a = 1;\n  const b = 2;\n}";
    expect(rates(source, [[2, 2, 1], [3, 2, 0]])).toEqual([["f", 0.5]]);
  });

  // 入れ子の網羅率が外側に混ざると、どちらの数字も意味を失う。
  it("入れ子のステートメントは内側の関数に属する", () => {
    expect(rates(NESTED, [[2, 2, 1], [3, 2, 1], [4, 4, 0], [5, 4, 0]])).toEqual([
      ["outer", 1],
      ["(anonymous)", 0],
    ]);
  });

  // 3 行目の `return xs.map((x) => {` は outer のもの。行だけで見るとアローに吸われる。
  it("関数の開始行にある外側のステートメントを内側に吸わない", () => {
    const map = new Map(rates(NESTED, [[3, 2, 1], [4, 4, 0]]));
    expect(map.get("outer")).toBe(1);
    expect(map.get("(anonymous)")).toBe(0);
  });

  it("ステートメントを持たない関数は 1", () => {
    expect(rates("function f() {}", [])).toEqual([["f", 1]]);
  });

  // 新しく足された未テストのファイルが無検査で緑になるのを防ぐ。
  // 「覆うものが無い（1）」と「誰も触れていない（0）」は別物。
  it("coverage にファイルが無ければ 0", () => {
    const functions = extractFunctions("t.ts", "function f() {}");
    const map = coverageByFunction(functions, undefined);
    expect(map.get(functions[0]!)).toBe(0);
  });

  it("関数の外のステートメントはどこにも数えない", () => {
    const source = "const top = 1;\nfunction f() {\n  const a = 1;\n}";
    expect(rates(source, [[1, 0, 0], [3, 2, 1]])).toEqual([["f", 1]]);
  });
});

/**
 * 範囲の端。**ここを 1 つ間違えると全関数の網羅率が静かにずれ、CRAP の数字が全部狂う。**
 *
 * 上の describe は「典型的な形で正しく割り当たるか」を見ている。端は行と列の
 * 両方に 4 つ（開始行・開始列・終了行・終了列）あり、どれも「1 つ内側」と
 * 「1 つ外側」で答えが変わらないと検査になっていない。
 */
describe("coverageByFunction の境界", () => {
  // 1 行に収まった関数。開始行の内側にある文を落とすと、その関数は
  // 「覆うものが無い（= 1）」に化けて、網羅率 0% が満点として通る。
  it("開始行の内側にある文を数える", () => {
    expect(rates("function f() { const a = 1; }", [[1, 15, 0]])).toEqual([["f", 0]]);
  });

  // 後ろの文を吸うと、無関係な行の実行・未実行がその関数の網羅率を動かす。
  it("終了行より後ろの文は数えない", () => {
    const source = "function f() {\n  const a = 1;\n}\nconst tail = 2;";
    expect(rates(source, [[2, 2, 1], [4, 0, 0]])).toEqual([["f", 1]]);
  });

  // 閉じ括弧と同じ行に続く文。行だけで見ると内側と区別がつかない。
  it("終了行の、終了列より後ろの文は数えない", () => {
    const source = "function f() {\n  const a = 1;\n} const tail = 2;";
    expect(rates(source, [[2, 2, 1], [3, 2, 0]])).toEqual([["f", 1]]);
  });

  // 入れ子が同じ行から始まる形。行が同じなので、内外は列でしか決められない。
  it("同じ行から始まる入れ子は、開始列で内側を選ぶ", () => {
    const source = "function outer() { return [1].map((x) => { const c = 3; return c; }); }";
    expect(rates(source, [[1, 19, 1], [1, 43, 0]])).toEqual([
      ["outer", 1],
      ["(anonymous)", 0],
    ]);
  });

  // 逆に、行が違えば列は見てはいけない。外側が長い名前の代入で右に寄ると、
  // **内側の方が左から始まる**。列で決めると外側を内側と取り違える。
  it("行が違えば、内側が左にあっても行で内側を選ぶ", () => {
    const source = "const someLongVariableName = () => {\nconst g = (x) => x;\nreturn g;\n};";
    expect(rates(source, [[2, 0, 1], [3, 0, 1], [2, 17, 0]])).toEqual([
      ["someLongVariableName", 1],
      ["g", 0],
    ]);
  });
});
