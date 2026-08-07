import { describe, expect, it } from "vitest";
import { branchCandidates } from "./git.ts";

describe("branchCandidates", () => {
  // CI の checkout は対象ブランチしかローカルに作らないので、`main` は解決できず
  // `origin/main` だけが存在する。手元では逆のこともある。
  it("ローカルとリモート追跡の両方を試す", () => {
    expect(branchCandidates("main")).toEqual(["main", "origin/main"]);
  });

  it("既にリモートを指していれば足さない", () => {
    expect(branchCandidates("origin/main")).toEqual(["origin/main"]);
  });

  it("upstream など別のリモートでもそのまま使う", () => {
    expect(branchCandidates("upstream/trunk")).toEqual(["upstream/trunk"]);
  });
});
