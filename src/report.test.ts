import { describe, expect, it } from "vitest";
import { type FunctionLocation, describeLocation } from "./report.ts";

function location(overrides: Partial<FunctionLocation> = {}): FunctionLocation {
  return {
    file: "src/user.ts",
    name: "fetchUser",
    scope: [],
    startLine: 47,
    startColumn: 2,
    endLine: 60,
    endColumn: 1,
    ...overrides,
  };
}

describe("describeLocation", () => {
  it("名前があれば名前を出す", () => {
    expect(describeLocation(location())).toBe("src/user.ts:47 fetchUser");
  });

  // 実コードでは名前が直接取れる関数は 2〜3 割しかない。
  // 残りを名指しできないと、CRAP の違反報告が行動可能にならない。
  it("名前が無くても位置と囲うスコープで一意になる", () => {
    expect(describeLocation(location({ name: null, scope: ["fetchUser"] }))).toBe(
      "src/user.ts:47 fetchUser > (anonymous)",
    );
  });

  it("入れ子のスコープを外側から並べる", () => {
    expect(describeLocation(location({ name: null, scope: ["UserService", "fetchUser"] }))).toBe(
      "src/user.ts:47 UserService > fetchUser > (anonymous)",
    );
  });

  it("同じファイルの別の無名関数と衝突しない", () => {
    const a = describeLocation(location({ name: null, startLine: 47 }));
    const b = describeLocation(location({ name: null, startLine: 52 }));
    expect(a).not.toBe(b);
  });
});
