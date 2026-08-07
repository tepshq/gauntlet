import { describe, expect, it } from "vitest";
import { MINIMUM_NODE_MAJOR, nodeTooOld } from "./node-version.ts";

describe("nodeTooOld", () => {
  // 22 で node:fs の globSync が入った。ここを下回ると
  // モジュール解決の段階で落ちて、読めるメッセージを出す機会が無い。
  it("要求は 22", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(22);
  });

  it.each(["20.20.2", "18.0.0", "21.7.3"])("v%s は足りない", (version) => {
    expect(nodeTooOld(version)).toBe(true);
  });

  it.each(["22.0.0", "24.16.0", "22.11.0"])("v%s は足りている", (version) => {
    expect(nodeTooOld(version)).toBe(false);
  });

  // 実際に渡すのは process.versions.node。境界を跨いだ判定が本題。
  it("いま走っている Node では止めない", () => {
    expect(nodeTooOld(process.versions.node)).toBe(false);
  });
});
