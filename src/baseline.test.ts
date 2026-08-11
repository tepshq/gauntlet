import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const read = (): string => readFileSync(join(root, BASELINE_FILENAME), "utf8");

describe("loadBaseline", () => {
  it("記録を読む", () => {
    put('{"crap": 7, "mutation": {"a.ts": 3}}');
    expect(loadBaseline(root)).toEqual({ crap: 7, mutation: { "a.ts": { survived: 3, measured: null } } });
  });

  it("mutation が無ければ空とみなす", () => {
    put('{"crap": 7}');
    expect(loadBaseline(root)).toEqual({ crap: 7, mutation: {} });
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
    saveBaseline(root, { crap: 3, mutation: { "a.ts": { survived: 1, measured: 12 } } });
    expect(loadBaseline(root)).toEqual({ crap: 3, mutation: { "a.ts": { survived: 1, measured: 12 } } });
  });

  // 読めない値を黙って数に変えると、壊れた記録が「生き残り 0」に化ける。欄ごと落とす。
  it.each([
    ['{"crap": 3, "mutation": {"a.ts": "many"}}', "文字列"],
    ['{"crap": 3, "mutation": {"a.ts": null}}', "null"],
    ['{"crap": 3, "mutation": {"a.ts": {"survived": "x"}}}', "survived が数でない"],
    ['{"crap": 3, "mutation": {"a.ts": {"measured": 5}}}', "survived 欠落"],
  ])("読めない記録は欄ごと落とす（%s）", (contents) => {
    put(contents);
    expect(loadBaseline(root)?.mutation).toEqual({});
  });

  // measured が数でなければ「無い」として読む（null と書かれた旧試行を許す）。
  it("measured が数でなければ null として読む", () => {
    put('{"crap": 3, "mutation": {"a.ts": {"survived": 2, "measured": "x"}}}');
    expect(loadBaseline(root)?.mutation).toEqual({ "a.ts": { survived: 2, measured: null } });
  });

  // 0.22 より前は生き残りの数だけを記録していた。読めなくなると全リポジトリの記録が消える。
  it("旧形式（数だけ）を読める", () => {
    put('{"crap": 3, "mutation": {"a.ts": 7}}');
    expect(loadBaseline(root)?.mutation).toEqual({ "a.ts": { survived: 7, measured: null } });
  });

  // null を書くと「測って 0 だった」と区別できない。measured が無いまま保存するときは欄ごと省く。
  it("measured の無い記録は survived だけで書く", () => {
    saveBaseline(root, { crap: 3, mutation: { "a.ts": { survived: 7, measured: null } } });
    expect(read()).not.toContain("null");
    expect(loadBaseline(root)?.mutation).toEqual({ "a.ts": { survived: 7, measured: null } });
  });

  // 「無い」と 0 は違う — 無ければ種を置く判定（duplicationViolations）に使う。
  it("duplication を読み戻せる", () => {
    saveBaseline(root, { crap: 3, duplication: 1090, mutation: {} });
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
  const record = (survived: number, measured: number | null = null) => ({ survived, measured });
  const allowed = { "a.ts": record(2, 10), "b.ts": record(5, 20) };

  it("許容数ちょうどなら通す", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(2, 10) })).toEqual({
      regressed: [],
      updated: { "a.ts": record(2, 10), "b.ts": record(5, 20) },
    });
  });

  it("増えていたら落とし、記録は上げない", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(4, 10) })).toEqual({
      regressed: [{ file: "a.ts", allowed: 2, actual: 4, measuredBefore: 10, measuredNow: 10 }],
      updated: { "a.ts": record(2, 10), "b.ts": record(5, 20) },
    });
  });

  // **生き残りの数は単調ではない。** テストを足すと ignoreStatic で外れていた変異が
  // 測定に入り、触っていないファイルの生き残りが増える（39 → 41 で実際に落ちた）。
  // 測定集合が広がった分だけ増加を許す。
  it("測った数が増えた分だけは、生き残りの増加を許す", () => {
    const outcome = ratchetByFile(allowed, ["a.ts"], { "a.ts": record(4, 12) });
    expect(outcome.regressed).toEqual([]);
    expect(outcome.updated["a.ts"]).toEqual(record(4, 12));
  });

  it("測った数の増加を超える分は落とす", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(5, 12) }).regressed).toEqual([
      { file: "a.ts", allowed: 2, actual: 5, measuredBefore: 10, measuredNow: 12 },
    ]);
  });

  // assert を消す形の攻撃は測った数が変わらない。余裕は生まれず、今までどおり落ちる。
  it("測った数が同じなら 1 件の増加も許さない", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(3, 10) }).regressed).toHaveLength(1);
  });

  // 旧記録には測った数が無いので、余裕を作れない。従来どおり厳格に比べる。
  it("旧記録（measured 無し）は厳格に比べる", () => {
    const legacy = { "a.ts": record(2) };
    expect(ratchetByFile(legacy, ["a.ts"], { "a.ts": record(3, 12) }).regressed).toEqual([
      { file: "a.ts", allowed: 2, actual: 3, measuredBefore: null, measuredNow: 12 },
    ]);
  });

  // 旧記録でも、通った回に measured 付きへ書き換わる（記録が徐々に新形式へ移る）。
  it("通った回に measured を記録する", () => {
    const legacy = { "a.ts": record(2) };
    expect(ratchetByFile(legacy, ["a.ts"], { "a.ts": record(1, 12) }).updated["a.ts"]).toEqual(record(1, 12));
  });

  it("減っていたら記録を下げる", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(1, 10) }).updated["a.ts"]).toEqual(record(1, 10));
  });

  it("生き残りが無くなれば 0 にする", () => {
    expect(ratchetByFile(allowed, ["a.ts"], {}).updated["a.ts"]).toEqual(record(0, 0));
  });

  // 既存リポジトリは導入時点で大量に抱えている。0 から始めると誰も入れられない。
  it("記録が無いファイルは実測値を種にする", () => {
    expect(ratchetByFile(allowed, ["c.ts"], { "c.ts": record(9, 30) }).updated["c.ts"]).toEqual(record(9, 30));
  });

  // 対象外のファイルまで書き換えると、差分と無関係な記録が動いて追えなくなる。
  it("今回の対象でないファイルの記録は動かさない", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(0, 10), "b.ts": record(99, 20) }).updated["b.ts"]).toEqual(
      record(5, 20),
    );
  });
});

describe("ratchet", () => {
  it("許容値ちょうどなら通す", () => {
    expect(ratchet({ crap: 5, mutation: {} }, 5)).toEqual({ kind: "ok" });
  });

  it("許容値を超えたら落とす", () => {
    expect(ratchet({ crap: 5, mutation: {} }, 6)).toEqual({ kind: "regressed", allowed: 5, actual: 6 });
  });

  // 改善を記録し損ねると許容値が緩いまま残り、後で同じだけ悪化させても通る。
  it("改善したら新しい値を返す", () => {
    expect(ratchet({ crap: 5, mutation: {} }, 3)).toEqual({ kind: "improved", from: 5, to: 3 });
  });

  it("0 まで下がりきったら ok", () => {
    expect(ratchet({ crap: 0, mutation: {} }, 0)).toEqual({ kind: "ok" });
  });
});
