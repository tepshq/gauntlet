import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_FILENAME, loadBaseline, ratchet, ratchetByFile, saveBaseline } from "./baseline.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gauntlet-baseline-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (contents: string): void => writeFileSync(join(root, BASELINE_FILENAME), contents);

describe("loadBaseline", () => {
  it("記録を読む", () => {
    put('{"crap": 7, "mutation": {"a.ts": 3}}');
    expect(loadBaseline(root)).toEqual({ crap: 7, mutation: { "a.ts": 3 }, lint: {} });
  });

  it("mutation が無ければ空とみなす", () => {
    put('{"crap": 7}');
    expect(loadBaseline(root)).toEqual({ crap: 7, mutation: {}, lint: {} });
  });

  // 0 と混同すると、既存リポジトリが導入初日に赤で埋まる。
  it.each([
    ["ファイルが無い", null],
    ["JSON として壊れている", "{ not json"],
    ["crap が無い", "{}"],
    ["crap が数値でない", '{"crap": "many"}'],
  ])("%s なら null（記録が無い）", (_label, contents) => {
    if (contents !== null) put(contents);
    expect(loadBaseline(root)).toBeNull();
  });

  it("書いたものを読み戻せる", () => {
    saveBaseline(root, { crap: 3, mutation: { "a.ts": 1 }, lint: {} });
    expect(loadBaseline(root)).toEqual({ crap: 3, mutation: { "a.ts": 1 }, lint: {} });
  });

  // 「無い」と 0 は違う — 無ければ種を置く判定（duplicationViolations）に使う。
  it("duplication を読み戻せる", () => {
    saveBaseline(root, { crap: 3, duplication: 1090, mutation: {}, lint: {} });
    expect(loadBaseline(root)?.duplication).toBe(1090);
  });

  it("duplication が無ければ欄ごと無い", () => {
    put('{"crap": 7}');
    expect(loadBaseline(root)).not.toHaveProperty("duplication");
  });

  it("duplication が数値でなければ欄ごと無い", () => {
    put('{"crap": 7, "duplication": "many"}');
    expect(loadBaseline(root)).not.toHaveProperty("duplication");
  });
});

describe("ratchetByFile", () => {
  const allowed = { "a.ts": 2, "b.ts": 5 };

  it("許容数ちょうどなら通す", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": 2 })).toEqual({
      regressed: [],
      updated: { "a.ts": 2, "b.ts": 5 },
    });
  });

  it("増えていたら落とし、記録は上げない", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": 4 })).toEqual({
      regressed: [{ file: "a.ts", allowed: 2, actual: 4 }],
      updated: { "a.ts": 2, "b.ts": 5 },
    });
  });

  it("減っていたら記録を下げる", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": 1 }).updated["a.ts"]).toBe(1);
  });

  it("生き残りが無くなれば 0 にする", () => {
    expect(ratchetByFile(allowed, ["a.ts"], {}).updated["a.ts"]).toBe(0);
  });

  // 既存リポジトリは導入時点で大量に抱えている。0 から始めると誰も入れられない。
  it("記録が無いファイルは実測値を種にする", () => {
    expect(ratchetByFile(allowed, ["c.ts"], { "c.ts": 9 })).toEqual({
      regressed: [],
      updated: { "a.ts": 2, "b.ts": 5, "c.ts": 9 },
    });
  });

  // 対象外のファイルまで書き換えると、差分と無関係な記録が動いて追えなくなる。
  it("今回の対象でないファイルの記録は動かさない", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": 0, "b.ts": 99 }).updated["b.ts"]).toBe(5);
  });
});

describe("ratchet", () => {
  it("許容値ちょうどなら通す", () => {
    expect(ratchet({ crap: 5, mutation: {}, lint: {} }, 5)).toEqual({ kind: "ok" });
  });

  it("許容値を超えたら落とす", () => {
    expect(ratchet({ crap: 5, mutation: {}, lint: {} }, 6)).toEqual({ kind: "regressed", allowed: 5, actual: 6 });
  });

  // 改善を記録し損ねると許容値が緩いまま残り、後で同じだけ悪化させても通る。
  it("改善したら新しい値を返す", () => {
    expect(ratchet({ crap: 5, mutation: {}, lint: {} }, 3)).toEqual({ kind: "improved", from: 5, to: 3 });
  });

  it("0 まで下がりきったら ok", () => {
    expect(ratchet({ crap: 0, mutation: {}, lint: {} }, 0)).toEqual({ kind: "ok" });
  });
});
