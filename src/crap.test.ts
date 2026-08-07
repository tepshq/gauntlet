import { describe, expect, it } from "vitest";
import { CRAP_THRESHOLD, crap, withinThreshold } from "./crap.ts";

describe("crap", () => {
  it("完全にカバーされていれば CRAP は CC そのもの", () => {
    expect(crap(1, 1)).toBe(1);
    expect(crap(8, 1)).toBe(8);
    expect(crap(20, 1)).toBe(20);
  });

  it("カバレッジ 0 なら CC² + CC", () => {
    expect(crap(2, 0)).toBe(6);
    expect(crap(3, 0)).toBe(12);
  });

  it("カバレッジが下がると単調に増える", () => {
    const scores = [1, 0.8, 0.5, 0.2, 0].map((c) => crap(5, c));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });
});

// DESIGN.md §3 の表がそのままここに写っている。
// 閾値 8 の意味は「未テストなら CC 2 まで、50% で 4、80% で 7、100% で 8」。
describe("閾値 8 が許す複雑度", () => {
  it.each([
    [1, 8, true],
    [1, 9, false],
    [0.8, 7, true],
    [0.8, 8, false],
    [0.5, 4, true],
    [0.5, 5, false],
    [0, 2, true],
    [0, 3, false],
  ])("coverage %s / CC %i → %s", (coverage, cc, expected) => {
    expect(withinThreshold(cc, coverage)).toBe(expected);
  });

  it("閾値は 8", () => {
    expect(CRAP_THRESHOLD).toBe(8);
  });
});
