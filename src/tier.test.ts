import { describe, expect, it } from "vitest";
import {
  type CheckResult,
  EXIT_BLOCKED,
  EXIT_PASS,
  TIER_CHECKS,
  type TierResult,
  exitCodeFor,
  tierStatus,
} from "./tier.ts";

function check(name: CheckResult["name"], status: CheckResult["status"]): CheckResult {
  return { name, status, durationMs: 0, violations: [], scope: "対象 1 件" };
}

describe("TIER_CHECKS", () => {
  it("quick は壊していないかだけを見る", () => {
    expect(TIER_CHECKS.quick).toEqual(["typecheck", "tests", "crap"]);
  });

  // mutation は quick の予算に収まらないので full にのみ置く。
  it("mutation は full にのみある", () => {
    expect(TIER_CHECKS.full).toContain("mutation");
    expect(TIER_CHECKS.quick).not.toContain("mutation");
  });

  // quick で緑・full で赤が頻発すると quick が信用されなくなる。
  it("quick のチェックは全て full にも含まれる", () => {
    for (const name of TIER_CHECKS.quick) {
      expect(TIER_CHECKS.full).toContain(name);
    }
  });
});

describe("tierStatus", () => {
  it("全て pass なら pass", () => {
    expect(tierStatus([check("typecheck", "pass"), check("tests", "pass")])).toBe("pass");
  });

  it("1 つでも fail なら fail", () => {
    expect(tierStatus([check("typecheck", "pass"), check("crap", "fail")])).toBe("fail");
  });

  it("チェックが 0 件なら pass", () => {
    expect(tierStatus([])).toBe("pass");
  });
});

describe("exitCodeFor", () => {
  // Stop フックは exit 2 のみを「停止を阻止」として扱い、それ以外を素通しする。
  it.each([
    ["pass", EXIT_PASS],
    ["fail", EXIT_BLOCKED],
  ] as const)("%s → %i", (status, expected) => {
    const result: TierResult = { tier: "quick", status, checks: [], durationMs: 0, notes: [] };
    expect(exitCodeFor(result)).toBe(expected);
  });

  it("阻止に使う code は 2", () => {
    expect(EXIT_BLOCKED).toBe(2);
  });
});
