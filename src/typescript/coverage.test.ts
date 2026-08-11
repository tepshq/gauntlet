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
