import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_FILENAME, conflictSides, hasConflictMarkers, loadBaseline, mergeBaselines, ratchetNumber, resolveConflictedBaseline, saveBaseline } from "./baseline.ts";

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
    put('{"crap": 7, "duplication": 1090}');
    expect(loadBaseline(root)).toEqual({ crap: 7, duplication: 1090 });
  });

  // 0.27.0 より前の記録が持つ mutation の欄は、読める欄だけを拾う方針でそのまま消える。
  it("旧記録の mutation の欄は黙って落とす", () => {
    put('{"crap": 7, "mutation": {"a.ts": 3}}');
    expect(loadBaseline(root)).toEqual({ crap: 7 });
  });

  // 0 と混同すると、既存リポジトリが導入初日に赤で埋まる。
  it.each([
    ["ファイルが無い", null],
    ["JSON として壊れている", "{ not json"],
    ["オブジェクトでない", "29482"],
    ["null が書かれている", "null"],
  ])("%s なら null（記録が無い）", (_label, contents) => {
    if (contents !== null) put(contents);
    expect(loadBaseline(root)).toBeNull();
  });

  // #28: crap が計測を中断した回は、完走した duplication だけが種を置く。その記録を
  // 「crap = 0」として読むと、次に完走した回が「0 → 772 に増えました」で落ちる。
  // 欠けているのは値であってファイルではないので、欄ごと無いまま読む。
  it("crap が無ければ欄ごと無い（0 にしない）", () => {
    put('{"duplication": 29482}');
    expect(loadBaseline(root)).toEqual({ duplication: 29482 });
  });

  // 読めない値を 0 に丸めるのは、上と同じ事故（測っていないゲートに最も厳しい値が入る）。
  it("crap が数値でなければ欄ごと無い", () => {
    put('{"crap": "many", "duplication": 1090}');
    expect(loadBaseline(root)).toEqual({ duplication: 1090 });
  });

  it("書いたものを読み戻せる", () => {
    saveBaseline(root, { crap: 3, duplication: 12 });
    expect(loadBaseline(root)).toEqual({ crap: 3, duplication: 12 });
  });

  // 「無い」と 0 は違う — 無ければ種を置く判定（duplicationViolations）に使う。
  it("duplication を読み戻せる", () => {
    saveBaseline(root, { crap: 3, duplication: 1090 });
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

// 複数ブランチが両方で記録を締めると、マージ時の衝突は構造的に必ず起きる。
// guard が書き換えを止めているので、解決は gauntlet 自身の仕事になる。
describe("hasConflictMarkers", () => {
  it("3 種のマーカーが揃っていれば衝突", () => {
    expect(hasConflictMarkers('<<<<<<< HEAD\n"crap": 1,\n=======\n"crap": 2,\n>>>>>>> feature')).toBe(true);
  });

  it("普通の記録は衝突ではない", () => {
    expect(hasConflictMarkers('{"crap": 7, "duplication": 30}')).toBe(false);
  });

  // 1 種だけの一致で解決を走らせると、手で千切られた断片まで「解決」してしまう。
  it.each([
    ["開始だけ", '<<<<<<< HEAD\n"crap": 1'],
    ["区切りだけ", '=======\n"crap": 1'],
    ["終了だけ", '"crap": 1\n>>>>>>> feature'],
    ["行頭でない", ' <<<<<<< HEAD\n =======\n >>>>>>> feature'],
    // 3 種それぞれの行頭判定を別々に確かめる。1 つの入力で全部字下げすると、
    // && の短絡で最初の判定しか観測できない。
    ["開始だけ字下げ", " <<<<<<< HEAD\na\n=======\nb\n>>>>>>> f"],
    ["区切りだけ字下げ", "<<<<<<< HEAD\na\n =======\nb\n>>>>>>> f"],
    ["終了だけ字下げ", "<<<<<<< HEAD\na\n=======\nb\n >>>>>>> f"],
    // 区切りは行として完全一致。後ろに何か付いた行はマーカーではない。
    ["区切りに続きがある", "<<<<<<< HEAD\na\n=======x\nb\n>>>>>>> f"],
  ])("マーカーが揃っていなければ衝突ではない（%s）", (_label, text) => {
    expect(hasConflictMarkers(text)).toBe(false);
  });
});

describe("conflictSides", () => {
  it("共有行は両側に、衝突区間はそれぞれの側に入る", () => {
    const text = ["{", "<<<<<<< HEAD", '  "crap": 1,', "=======", '  "crap": 2,', ">>>>>>> feature", '  "duplication": 30', "}"].join("\n");
    expect(conflictSides(text)).toEqual({
      ours: ['{', '  "crap": 1,', '  "duplication": 30', "}"].join("\n"),
      theirs: ['{', '  "crap": 2,', '  "duplication": 30', "}"].join("\n"),
    });
  });

  // merge.conflictStyle = diff3 / zdiff3 は共通祖先の区間を挟む。どちらの側でもない。
  it("diff3 の base 区間は捨てる", () => {
    const text = ["<<<<<<< HEAD", "a", "||||||| merged common ancestors", "base", "=======", "b", ">>>>>>> feature"].join("\n");
    expect(conflictSides(text)).toEqual({ ours: "a", theirs: "b" });
  });

  it("衝突区間が複数あっても読める", () => {
    const text = ["<<<<<<< HEAD", "a1", "=======", "b1", ">>>>>>> f", "shared", "<<<<<<< HEAD", "a2", "=======", "b2", ">>>>>>> f"].join("\n");
    expect(conflictSides(text)).toEqual({ ours: ["a1", "shared", "a2"].join("\n"), theirs: ["b1", "shared", "b2"].join("\n") });
  });

  // 千切られた断片を JSON.parse に回すより、「読めない」に落とす方が安全。
  it.each([
    ["終了マーカーが無い", "<<<<<<< HEAD\na\n=======\nb"],
    ["開始の入れ子", "<<<<<<< HEAD\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> f"],
    ["区切りが先に来る", "=======\nb\n>>>>>>> f"],
    ["base 区間が衝突の外", "||||||| base\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> f"],
  ])("マーカーの対応が崩れていれば null（%s）", (_label, text) => {
    expect(conflictSides(text)).toBeNull();
  });

  // マーカーに似ているだけの行は内容。行頭からの完全な形だけをマーカーとして扱う。
  it("マーカーに続きや字下げのある行は内容として両側に残る", () => {
    const text = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> f", "=======x", " >>>>>>> f"].join("\n");
    expect(conflictSides(text)).toEqual({
      ours: ["a", "=======x", " >>>>>>> f"].join("\n"),
      theirs: ["b", "=======x", " >>>>>>> f"].join("\n"),
    });
  });
});

describe("mergeBaselines", () => {
  it("crap は小さい方", () => {
    expect(mergeBaselines({ crap: 5 }, { crap: 3 }).crap).toBe(3);
  });

  // #28 で crap も optional になった。`Math.min(undefined, 3)` は NaN で、それが記録に
  // 書かれると以降どんな実測とも比べられない。duplication と同じ扱いに揃える。
  it("crap は片方だけでもその値を残す", () => {
    expect(mergeBaselines({}, { crap: 3 }).crap).toBe(3);
    expect(mergeBaselines({ crap: 3 }, {}).crap).toBe(3);
  });

  it("crap は両方無ければ欄ごと無し", () => {
    expect(mergeBaselines({}, {})).not.toHaveProperty("crap");
  });

  it("duplication は両方有れば小さい方", () => {
    expect(mergeBaselines({ crap: 0, duplication: 200 }, { crap: 0, duplication: 100 }).duplication).toBe(100);
  });

  // 無い方は「まだゲートが無い」。有る方が常に厳しい。
  it("duplication は片方だけでもその値を残す", () => {
    expect(mergeBaselines({ crap: 0 }, { crap: 0, duplication: 100 }).duplication).toBe(100);
    expect(mergeBaselines({ crap: 0, duplication: 100 }, { crap: 0 }).duplication).toBe(100);
  });

  it("duplication は両方無ければ欄ごと無し", () => {
    expect(mergeBaselines({ crap: 0 }, { crap: 0 })).not.toHaveProperty("duplication");
  });
});

describe("resolveConflictedBaseline", () => {
  const conflicted = [
    "{",
    "<<<<<<< HEAD",
    '  "crap": 1,',
    "=======",
    '  "crap": 2,',
    ">>>>>>> feature",
    '  "duplication": 30',
    "}",
  ].join("\n");

  it("両側を読んで厳しい側でマージする", () => {
    expect(resolveConflictedBaseline(conflicted)).toEqual({ crap: 1, duplication: 30 });
  });

  // theirs 側が厳しい例も要る。ours 側が厳しい例だけだと、
  // 「マージせず常に ours を返す」形とマージの区別がつかない。
  it("theirs 側が厳しければそちらを取る", () => {
    const text = ["{", "<<<<<<< HEAD", '  "crap": 2,', "=======", '  "crap": 1,', ">>>>>>> feature", '  "duplication": 30', "}"].join("\n");
    expect(resolveConflictedBaseline(text)).toEqual({ crap: 1, duplication: 30 });
  });

  // 衝突でないものに触ると、正常な読み込みまでこの経路に乗ってしまう。
  it("マーカーが無ければ null", () => {
    expect(resolveConflictedBaseline('{"crap": 7, "duplication": 30}')).toBeNull();
  });

  // 種置き（負債の記録が全部消える）に落とすより、どちらかの実測が残る方が近い。
  it("片側だけ読めるなら読める側", () => {
    const text = ["<<<<<<< HEAD", '{"crap": 4}', "=======", "{ not json", ">>>>>>> feature"].join("\n");
    expect(resolveConflictedBaseline(text)).toEqual({ crap: 4 });
  });

  it("両側とも読めなければ null", () => {
    const text = ["<<<<<<< HEAD", "{ not json", "=======", "{ also broken", ">>>>>>> feature"].join("\n");
    expect(resolveConflictedBaseline(text)).toBeNull();
  });

  it("マーカーの対応が崩れていれば null", () => {
    const text = ["<<<<<<< HEAD", '{"crap": 1}', "=======", '{"crap": 2}'].join("\n");
    expect(resolveConflictedBaseline(text)).toBeNull();
  });

  // 3 種が揃っていても順序が崩れている形。マーカー検出は通り、再構成で落ちる —
  // その経路（conflictSides が null）を resolveConflictedBaseline 越しに確かめる。
  it("マーカーが揃っていても順序が崩れていれば null", () => {
    const text = [">>>>>>> f", "<<<<<<< HEAD", '{"crap": 1}', "=======", '{"crap": 2}'].join("\n");
    expect(resolveConflictedBaseline(text)).toBeNull();
  });
});

describe("ratchetNumber", () => {
  it("許容値ちょうどなら通す", () => {
    expect(ratchetNumber(5, 5)).toEqual({ kind: "ok" });
  });

  it("許容値を超えたら落とす", () => {
    expect(ratchetNumber(5, 6)).toEqual({ kind: "regressed", allowed: 5, actual: 6 });
  });

  // 改善を記録し損ねると許容値が緩いまま残り、後で同じだけ悪化させても通る。
  it("改善したら新しい値を返す", () => {
    expect(ratchetNumber(5, 3)).toEqual({ kind: "improved", from: 5, to: 3 });
  });

  // 許容 0 は「測って違反ゼロだった」。記録が無いのとは別物で、そのまま噛む。
  it("0 まで下がりきったら ok", () => {
    expect(ratchetNumber(0, 0)).toEqual({ kind: "ok" });
  });
});
