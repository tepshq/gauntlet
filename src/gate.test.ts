import { describe, expect, it } from "vitest";
import { REPORT_SCHEMA_VERSION, type AdapterReport, type FunctionReport } from "./report.ts";
import { gateRepository, gateTouched } from "./gate.ts";

function fn(file: string, startLine: number, endLine: number, cc: number, coverage: number): FunctionReport {
  return {
    location: { file, name: "f", scope: [], startLine, startColumn: 0, endLine, endColumn: 0 },
    cc,
    coverage,
  };
}

function reportOf(functions: FunctionReport[]): AdapterReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    adapter: { name: "typescript", version: "0" },
    root: "/repo",
    functions,
    excluded: [],
  };
}

// CRAP 8 の意味: 網羅率 0 なら CC 2 まで、100% なら CC 8 まで。
const BAD = fn("a.ts", 10, 20, 5, 0); // CRAP 30
const GOOD = fn("a.ts", 30, 40, 5, 1); // CRAP 5

describe("gateTouched", () => {
  it("触った関数の違反を出す", () => {
    const violations = gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([15])]]));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("CRAP 30.0");
    expect(violations[0]!.line).toBe(10);
  });

  // ファイル単位で見ると、1 行直しただけでそのファイルの全関数が対象になる。
  it("同じファイルでも触っていない関数は見ない", () => {
    expect(gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([35])]]))).toEqual([]);
  });

  it("触っていないファイルは見ない", () => {
    expect(gateTouched(reportOf([BAD]), new Map([["b.ts", new Set([15])]]))).toEqual([]);
  });

  it("閾値内なら触っていても通す", () => {
    expect(gateTouched(reportOf([GOOD]), new Map([["a.ts", new Set([35])]]))).toEqual([]);
  });

  it("関数の端の行も触ったとみなす", () => {
    for (const line of [10, 20]) {
      expect(gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([line])]]))).toHaveLength(1);
    }
  });

  it("違反の理由が読める", () => {
    const [violation] = gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([15])]]));
    expect(violation!.message).toContain("複雑度 5");
    expect(violation!.message).toContain("網羅率 0%");
    expect(violation!.message).toContain("a.ts:10");
  });
});

describe("gateRepository", () => {
  it("違反数が許容値以下なら落とさない", () => {
    expect(gateRepository(reportOf([BAD, GOOD]), { crap: 1 })).toEqual({ kind: "ok" });
  });

  it("許容値を超えたら落とす", () => {
    expect(gateRepository(reportOf([BAD]), { crap: 0 })).toEqual({ kind: "regressed", allowed: 0, actual: 1 });
  });

  it("減っていたら改善として返す", () => {
    expect(gateRepository(reportOf([GOOD]), { crap: 3 })).toEqual({ kind: "improved", from: 3, to: 0 });
  });
});
