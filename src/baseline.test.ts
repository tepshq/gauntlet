import { describe, expect, it } from "vitest";
import { ratchet } from "./baseline.ts";

describe("ratchet", () => {
  it("許容値ちょうどなら通す", () => {
    expect(ratchet({ crap: 5 }, 5)).toEqual({ kind: "ok" });
  });

  it("許容値を超えたら落とす", () => {
    expect(ratchet({ crap: 5 }, 6)).toEqual({ kind: "regressed", allowed: 5, actual: 6 });
  });

  // 改善を記録し損ねると許容値が緩いまま残り、後で同じだけ悪化させても通る。
  it("改善したら新しい値を返す", () => {
    expect(ratchet({ crap: 5 }, 3)).toEqual({ kind: "improved", from: 5, to: 3 });
  });

  it("0 まで下がりきったら ok", () => {
    expect(ratchet({ crap: 0 }, 0)).toEqual({ kind: "ok" });
  });
});
