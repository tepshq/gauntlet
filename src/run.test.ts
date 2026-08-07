import { describe, expect, it } from "vitest";
import { ConfigError } from "./config.ts";
import { formatResult, parseTier } from "./run.ts";
import type { CheckResult, TierResult } from "./tier.ts";

describe("parseTier", () => {
  it.each([
    ["--tier=turn", "turn"],
    ["--tier=pr", "pr"],
  ] as const)("%s を読む", (arg, expected) => {
    expect(parseTier([arg])).toBe(expected);
  });

  it.each([
    ["指定が無い", []],
    ["値が空", ["--tier="]],
    ["未対応の tier", ["--tier=commit"]],
  ])("%s なら落ちる", (_label, argv) => {
    expect(() => parseTier(argv)).toThrow(ConfigError);
  });

  it("落ちるときに選べる値を示す", () => {
    expect(() => parseTier(["--tier=commit"])).toThrow(/turn \| pr/);
  });
});

function check(name: CheckResult["name"], status: CheckResult["status"], message?: string): CheckResult {
  return {
    name,
    status,
    durationMs: 12,
    violations: message === undefined ? [] : [{ message }],
  };
}

function result(checks: CheckResult[]): TierResult {
  return { tier: "turn", status: "fail", checks, durationMs: 34 };
}

describe("formatResult", () => {
  it("落ちたチェックとその理由を出す", () => {
    const output = formatResult(result([check("crap", "fail", "CRAP 30.0 ... a.ts:10 f")]));
    expect(output).toContain("gauntlet turn: fail");
    expect(output).toContain("✗ crap");
    expect(output).toContain("a.ts:10 f");
  });

  it("通ったチェックも出す", () => {
    expect(formatResult(result([check("typecheck", "pass")]))).toContain("✓ typecheck");
  });

  // どのチェックが予算を食っているか分からないと turn を速く保てない。
  it("各チェックの所要時間を出す", () => {
    expect(formatResult(result([check("tests", "pass")]))).toContain("(12ms)");
  });
});
