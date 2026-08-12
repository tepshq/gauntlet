import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_FILENAME, conflictSides, hasConflictMarkers, loadBaseline, mergeBaselines, ratchetByFile, ratchetNumber, resolveConflictedBaseline, saveBaseline, tighterRecord } from "./baseline.ts";

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
    expect(loadBaseline(root)).toEqual({ crap: 7, mutation: { "a.ts": { survived: 3, measured: null, timeout: null, noCoverage: null } } });
  });

  it("mutation が無ければ空とみなす", () => {
    put('{"crap": 7}');
    expect(loadBaseline(root)).toEqual({ crap: 7, mutation: {} });
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
    put('{"duplication": 29482, "mutation": {}}');
    expect(loadBaseline(root)).toEqual({ duplication: 29482, mutation: {} });
  });

  // 読めない値を 0 に丸めるのは、上と同じ事故（測っていないゲートに最も厳しい値が入る）。
  it("crap が数値でなければ欄ごと無い", () => {
    put('{"crap": "many", "duplication": 1090}');
    expect(loadBaseline(root)).toEqual({ duplication: 1090, mutation: {} });
  });

  it("書いたものを読み戻せる", () => {
    saveBaseline(root, { crap: 3, mutation: { "a.ts": { survived: 1, measured: 12, timeout: 2, noCoverage: null } } });
    expect(loadBaseline(root)).toEqual({ crap: 3, mutation: { "a.ts": { survived: 1, measured: 12, timeout: 2, noCoverage: null } } });
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
    expect(loadBaseline(root)?.mutation).toEqual({ "a.ts": { survived: 2, measured: null, timeout: null, noCoverage: null } });
  });

  // 0.22 より前は生き残りの数だけを記録していた。読めなくなると全リポジトリの記録が消える。
  it("旧形式（数だけ）を読める", () => {
    put('{"crap": 3, "mutation": {"a.ts": 7}}');
    expect(loadBaseline(root)?.mutation).toEqual({ "a.ts": { survived: 7, measured: null, timeout: null, noCoverage: null } });
  });

  // null を書くと「測って 0 だった」と区別できない。measured が無いまま保存するときは欄ごと省く。
  it("measured の無い記録は survived だけで書く", () => {
    saveBaseline(root, { crap: 3, mutation: { "a.ts": { survived: 7, measured: null, timeout: null, noCoverage: null } } });
    expect(read()).not.toContain("null");
    expect(loadBaseline(root)?.mutation).toEqual({ "a.ts": { survived: 7, measured: null, timeout: null, noCoverage: null } });
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
  const record = (survived: number, measured: number | null = null, timeout: number | null = null) => ({
    survived,
    measured,
    timeout,
    noCoverage: null,
  });
  const allowed = { "a.ts": record(2, 10), "b.ts": record(5, 20) };

  it("許容数ちょうどなら通す", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(2, 10) })).toEqual({
      regressed: [],
      updated: { "a.ts": record(2, 10), "b.ts": record(5, 20) },
    });
  });

  it("増えていたら落とし、記録は上げない", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(4, 10) })).toEqual({
      regressed: [{ kind: "undetected", file: "a.ts", allowed: 2, actual: 4, survivedBefore: 2, survivedNow: 4, measuredBefore: 10, measuredNow: 10, timeoutBefore: null, timeoutNow: null }],
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
      { kind: "undetected", file: "a.ts", allowed: 2, actual: 5, survivedBefore: 2, survivedNow: 5, measuredBefore: 10, measuredNow: 12, timeoutBefore: null, timeoutNow: null },
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
      { kind: "undetected", file: "a.ts", allowed: 2, actual: 3, survivedBefore: 2, survivedNow: 3, measuredBefore: null, measuredNow: 12, timeoutBefore: null, timeoutNow: null },
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

  // 「全部殺した」と「測られていない」は別物。後者に 0/0/0 を書くと負債の記録が
  // 消え、measured の余裕と組み合わさってゲートが恒久的に外れる（#27 で実測）。
  it("測られなかったファイルの記録は触らない", () => {
    expect(ratchetByFile(allowed, ["a.ts"], {}).updated["a.ts"]).toEqual(record(2, 10));
  });

  it("測って生き残りが無くなれば 0 にする", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(0, 10, 0) }).updated["a.ts"]).toEqual(record(0, 10, 0));
  });

  // 既に 0/0/0 が書かれてしまった記録（#27 の被害）にも余裕を作らない。
  // 静かに通り続けるより、大声で落ちて人の目に入る方が安全側。
  it("measured が 0 の記録には余裕を作らない", () => {
    const poisoned = { "a.ts": record(0, 0, 0) };
    expect(ratchetByFile(poisoned, ["a.ts"], { "a.ts": record(3, 30, 0) }).regressed).toHaveLength(1);
  });

  // 既存リポジトリは導入時点で大量に抱えている。0 から始めると誰も入れられない。
  it("記録が無いファイルは実測値を種にする", () => {
    expect(ratchetByFile(allowed, ["c.ts"], { "c.ts": record(9, 30) }).updated["c.ts"]).toEqual(record(9, 30));
  });

  // #26 の核心。打ち切りの閾値は実行速度に比例するので、「遅くなるだけの変異」は
  // 速い機械で Timeout・遅い CI で Survived になる。和が同じなら環境が違うだけ — 通す。
  it("Timeout が Survived に流れても、和が同じなら通す", () => {
    const limits = { "a.ts": record(66, 414, 4) };
    const outcome = ratchetByFile(limits, ["a.ts"], { "a.ts": record(69, 414, 1) });
    expect(outcome.regressed).toEqual([]);
    expect(outcome.updated["a.ts"]).toEqual(record(69, 414, 1));
  });

  // #39 の核心。打ち切りは実行ごとに揺れる（同じコード・同じマシンで 5 → 4 → 3 の実測）。
  // 締まる方向にしか動かないラチェットを当てると記録が最小値へ収束し、その後は上振れの
  // たびに落ちる — しかもテストでは減らせないので打つ手が無い。
  describe("打ち切りは触ったファイルだけ締める（#39）", () => {
    const limits = { "a.ts": record(0, 91, 5) };

    it("触っていないファイルの打ち切りは下げない", () => {
      const outcome = ratchetByFile(limits, ["a.ts"], { "a.ts": record(0, 91, 3) }, new Set());
      expect(outcome.regressed).toEqual([]);
      expect(outcome.updated["a.ts"]).toEqual(record(0, 91, 5));
    });

    // コードの形が変わったなら、下がったのは実測の成果。締める。
    it("ソースが差分にあれば下げる", () => {
      const outcome = ratchetByFile(limits, ["a.ts"], { "a.ts": record(0, 91, 3) }, new Set(["a.ts"]));
      expect(outcome.updated["a.ts"]).toEqual(record(0, 91, 3));
    });

    // **生き残りには当てない。** 生き残りを減らす標準的なやり方はテストを足すことで、
    // ソースを触らない改善が普通にある。ここを締めないと、いちばん歓迎すべき改善が
    // 記録されなくなる（#39 の指摘）。
    it("触っていなくても生き残りは締める", () => {
      const outcome = ratchetByFile({ "a.ts": record(9, 91, 5) }, ["a.ts"], { "a.ts": record(2, 91, 5) }, new Set());
      expect(outcome.updated["a.ts"]).toEqual(record(2, 91, 5));
    });

    // 旧記録に打ち切りの欄が無い回の初回書き込みは「締め」ではない。
    it("欄が無ければ触っていなくても入れる", () => {
      const legacy = { "a.ts": { survived: 0, measured: 91, timeout: null, noCoverage: null } };
      expect(ratchetByFile(legacy, ["a.ts"], { "a.ts": record(0, 91, 3) }, new Set()).updated["a.ts"]).toEqual(
        record(0, 91, 3),
      );
    });

    // 上振れをそのまま書くと記録が緩む。締めないのではなく、凍らせる。
    it("触っていないファイルの打ち切りが上振れしても記録は緩めない", () => {
      const outcome = ratchetByFile({ "a.ts": record(0, 200, 5) }, ["a.ts"], { "a.ts": record(0, 400, 7) }, new Set());
      expect(outcome.regressed).toEqual([]); // measured が増えた分の余裕で通る
      expect(outcome.updated["a.ts"]!.timeout).toBe(5);
    });
  });

  // #39 の形。生き残りは 0 のまま打ち切りだけが動くと落ちる（測った数が同じなので
  // 余裕も無い）。**このとき見出しに出すのは和** — 生き残りを出すと「0 → 0 に増えました」
  // になる。文は regressionText の仕事だが、渡す数はここで決まる。
  it("生き残りが動かず打ち切りだけ増えた回は、和で報告する", () => {
    const limits = { "a.ts": record(0, 91, 4) };
    expect(ratchetByFile(limits, ["a.ts"], { "a.ts": record(0, 91, 5) }).regressed).toEqual([
      {
        kind: "undetected",
        file: "a.ts",
        allowed: 4,
        actual: 5,
        survivedBefore: 0,
        survivedNow: 0,
        measuredBefore: 91,
        measuredNow: 91,
        timeoutBefore: 4,
        timeoutNow: 5,
      },
    ]);
  });

  it("和が増えたら落とす", () => {
    const limits = { "a.ts": record(66, 414, 4) };
    expect(ratchetByFile(limits, ["a.ts"], { "a.ts": record(70, 414, 1) }).regressed).toEqual([
      {
        kind: "undetected",
        file: "a.ts",
        // 突き合わせるのは「殺せなかった数」= 生き残り + 打ち切り（66+4=70 → 70+1=71）。
        allowed: 70,
        actual: 71,
        survivedBefore: 66,
        survivedNow: 70,
        measuredBefore: 414,
        measuredNow: 414,
        timeoutBefore: 4,
        timeoutNow: 1,
      },
    ]);
  });

  // timeout を持たない 0.22 の記録に打ち切りを混ぜると、片側だけ膨らんで必ず落ちる。
  it("timeout の無い記録には survived だけで比べる", () => {
    const legacy = { "a.ts": { survived: 5, measured: 10, timeout: null, noCoverage: null } };
    expect(ratchetByFile(legacy, ["a.ts"], { "a.ts": record(5, 10, 3) }).regressed).toEqual([]);
  });

  // 対象外のファイルまで書き換えると、差分と無関係な記録が動いて追えなくなる。
  it("今回の対象でないファイルの記録は動かさない", () => {
    expect(ratchetByFile(allowed, ["a.ts"], { "a.ts": record(0, 10), "b.ts": record(99, 20) }).updated["b.ts"]).toEqual(
      record(5, 20),
    );
  });

  // #31: どのテストも通っていない変異は生き残りに足さず（既存リポジトリが赤で埋まる）、
  // 別の軸として「増やさない」だけを課す。直し方が違うので文も分ける。
  describe("どのテストも通っていない変異（noCoverage）", () => {
    const uncovered = (survived: number, noCoverage: number | null) => ({
      survived,
      measured: 100,
      timeout: 0,
      noCoverage,
    });

    it("増えていたら落とす", () => {
      const limits = { "a.ts": uncovered(0, 19) };
      expect(ratchetByFile(limits, ["a.ts"], { "a.ts": uncovered(0, 25) }).regressed).toEqual([
        { kind: "noCoverage", file: "a.ts", allowed: 19, actual: 25 },
      ]);
    });

    it("同じなら通す", () => {
      expect(ratchetByFile({ "a.ts": uncovered(0, 19) }, ["a.ts"], { "a.ts": uncovered(0, 19) }).regressed).toEqual([]);
    });

    // テストから呼べる形にした回に自動で締まらないと、次に緩めても通ってしまう。
    it("減っていたら記録を下げる", () => {
      const limits = { "a.ts": uncovered(0, 19) };
      expect(ratchetByFile(limits, ["a.ts"], { "a.ts": uncovered(0, 2) }).updated["a.ts"]).toEqual(uncovered(0, 2));
    });

    // **旧記録（0.24 より前）は欄を持たない。** 0 と読むと、上げた瞬間に全リポジトリが
    // 「0 → N に増えました」で赤くなる（#28 と同じ形の逆向き）。最初に測れた回が種を置く。
    it("欄の無い記録は突き合わせず種を置く", () => {
      const legacy = { "a.ts": uncovered(0, null) };
      const outcome = ratchetByFile(legacy, ["a.ts"], { "a.ts": uncovered(0, 222) });
      expect(outcome.regressed).toEqual([]);
      expect(outcome.updated["a.ts"]!.noCoverage).toBe(222);
    });

    // 生き残りの側に作った余裕（measured が増えた分）をこちらに流用しない。
    // テストを足せば未計測は減る方向にしか動かないので、緩める理由が無い。
    it("測った数が増えても増加は許さない", () => {
      const limits = { "a.ts": { survived: 0, measured: 100, timeout: 0, noCoverage: 19 } };
      const actual = { "a.ts": { survived: 0, measured: 200, timeout: 0, noCoverage: 20 } };
      expect(ratchetByFile(limits, ["a.ts"], actual).regressed).toHaveLength(1);
    });

    // 直し方が違う 2 つを 1 件に丸めると、読み手はどちらを直すのか分からない。
    it("両方の軸が増えたら両方言う", () => {
      const limits = { "a.ts": { survived: 1, measured: 100, timeout: 0, noCoverage: 5 } };
      const actual = { "a.ts": { survived: 3, measured: 100, timeout: 0, noCoverage: 9 } };
      const kinds = ratchetByFile(limits, ["a.ts"], actual).regressed.map((entry) => entry.kind);
      expect(kinds).toEqual(["undetected", "noCoverage"]);
    });

    // 片方だけ締めると、後退した軸の許容値をあとから置き直せなくなる。
    it("片方が後退していれば記録は動かさない", () => {
      const limits = { "a.ts": { survived: 1, measured: 100, timeout: 0, noCoverage: 5 } };
      const actual = { "a.ts": { survived: 0, measured: 100, timeout: 0, noCoverage: 9 } };
      const outcome = ratchetByFile(limits, ["a.ts"], actual);
      expect(outcome.regressed).toHaveLength(1);
      expect(outcome.updated["a.ts"]).toEqual(limits["a.ts"]);
    });
  });
});

// 複数ブランチが両方で記録を締めると、マージ時の衝突は構造的に必ず起きる。
// guard が書き換えを止めているので、解決は gauntlet 自身の仕事になる。
describe("hasConflictMarkers", () => {
  it("3 種のマーカーが揃っていれば衝突", () => {
    expect(hasConflictMarkers('<<<<<<< HEAD\n"crap": 1,\n=======\n"crap": 2,\n>>>>>>> feature')).toBe(true);
  });

  it("普通の記録は衝突ではない", () => {
    expect(hasConflictMarkers('{"crap": 7, "mutation": {}}')).toBe(false);
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
    const text = ["{", "<<<<<<< HEAD", '  "crap": 1,', "=======", '  "crap": 2,', ">>>>>>> feature", '  "mutation": {}', "}"].join("\n");
    expect(conflictSides(text)).toEqual({
      ours: ['{', '  "crap": 1,', '  "mutation": {}', "}"].join("\n"),
      theirs: ['{', '  "crap": 2,', '  "mutation": {}', "}"].join("\n"),
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

describe("tighterRecord", () => {
  const record = (survived: number, measured: number | null = null, timeout: number | null = null) => ({
    survived,
    measured,
    timeout,
    noCoverage: null,
  });

  // 突き合わせが見るのは「殺せなかった数」= survived + timeout。
  it("survived + timeout が小さい方を取る", () => {
    expect(tighterRecord(record(3, 10, 0), record(2, 10, 0))).toEqual(record(2, 10, 0));
    expect(tighterRecord(record(2, 10, 0), record(3, 10, 0))).toEqual(record(2, 10, 0));
  });

  // 両側それぞれの timeout が和に入ることを別々に確かめる（片側だけだと
  // もう片方の加算の変異が観測できない）。
  it("timeout も殺せなかった数に入れる", () => {
    expect(tighterRecord(record(2, 10, 3), record(4, 10, 0))).toEqual(record(4, 10, 0));
    expect(tighterRecord(record(4, 10, 0), record(2, 10, 3))).toEqual(record(4, 10, 0));
  });

  // measured が大きいほど、測定集合の拡大で生まれる余裕（slack）が小さい = 厳しい。
  // 引数の順序に依らないことも固定する。
  it("和が同じなら measured が大きい方を取る", () => {
    expect(tighterRecord(record(2, 10, 0), record(2, 30, 0))).toEqual(record(2, 30, 0));
    expect(tighterRecord(record(2, 30, 0), record(2, 10, 0))).toEqual(record(2, 30, 0));
  });

  // 完全な同点はどちらでも同じ値だが、返すのは ours 側と決めて固定する。
  it("完全な同点は ours 側", () => {
    const a = record(2, 10, 0);
    expect(tighterRecord(a, record(2, 10, 0))).toBe(a);
  });

  // 旧形式（measured 無し）は slack を作れない = 一番厳しい。
  it("和が同じなら measured 無しが勝つ", () => {
    expect(tighterRecord(record(2, 10, 0), record(2))).toEqual(record(2));
  });

  // どちらの実測でもない値を合成しない。返るのは必ずどちらか丸ごと（同一の参照）。
  it("欄を混ぜた第 3 の record を作らない", () => {
    const a = record(2, 10, 1);
    const b = record(4, 30, 0);
    expect(tighterRecord(a, b)).toBe(a);
  });
});

describe("mergeBaselines", () => {
  const record = (survived: number) => ({ survived, measured: null, timeout: null, noCoverage: null });

  it("crap は小さい方", () => {
    expect(mergeBaselines({ crap: 5, mutation: {} }, { crap: 3, mutation: {} }).crap).toBe(3);
  });

  // #28 で crap も optional になった。`Math.min(undefined, 3)` は NaN で、それが記録に
  // 書かれると以降どんな実測とも比べられない。duplication と同じ扱いに揃える。
  it("crap は片方だけでもその値を残す", () => {
    expect(mergeBaselines({ mutation: {} }, { crap: 3, mutation: {} }).crap).toBe(3);
    expect(mergeBaselines({ crap: 3, mutation: {} }, { mutation: {} }).crap).toBe(3);
  });

  it("crap は両方無ければ欄ごと無し", () => {
    expect(mergeBaselines({ mutation: {} }, { mutation: {} })).not.toHaveProperty("crap");
  });

  it("duplication は両方有れば小さい方", () => {
    expect(mergeBaselines({ crap: 0, duplication: 200, mutation: {} }, { crap: 0, duplication: 100, mutation: {} }).duplication).toBe(100);
  });

  // 無い方は「まだゲートが無い」。有る方が常に厳しい。
  it("duplication は片方だけでもその値を残す", () => {
    expect(mergeBaselines({ crap: 0, mutation: {} }, { crap: 0, duplication: 100, mutation: {} }).duplication).toBe(100);
    expect(mergeBaselines({ crap: 0, duplication: 100, mutation: {} }, { crap: 0, mutation: {} }).duplication).toBe(100);
  });

  it("duplication は両方無ければ欄ごと無し", () => {
    expect(mergeBaselines({ crap: 0, mutation: {} }, { crap: 0, mutation: {} })).not.toHaveProperty("duplication");
  });

  // 片側にしか無い記録を落とすと、その負債が消える。
  it("mutation はファイルの和集合", () => {
    const merged = mergeBaselines(
      { crap: 0, mutation: { "a.ts": record(1) } },
      { crap: 0, mutation: { "b.ts": record(2) } },
    );
    expect(merged.mutation).toEqual({ "a.ts": record(1), "b.ts": record(2) });
  });

  it("両側に有るファイルは厳しい側", () => {
    const merged = mergeBaselines(
      { crap: 0, mutation: { "a.ts": record(5) } },
      { crap: 0, mutation: { "a.ts": record(2) } },
    );
    expect(merged.mutation["a.ts"]).toEqual(record(2));
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
    '  "mutation": {',
    '    "a.ts": { "survived": 3 }',
    "  }",
    "}",
  ].join("\n");

  it("両側を読んで厳しい側でマージする", () => {
    expect(resolveConflictedBaseline(conflicted)).toEqual({
      crap: 1,
      mutation: { "a.ts": { survived: 3, measured: null, timeout: null, noCoverage: null } },
    });
  });

  // theirs 側が厳しい例も要る。ours 側が厳しい例だけだと、
  // 「マージせず常に ours を返す」形とマージの区別がつかない。
  it("theirs 側が厳しければそちらを取る", () => {
    const text = ["{", "<<<<<<< HEAD", '  "crap": 2,', "=======", '  "crap": 1,', ">>>>>>> feature", '  "mutation": {}', "}"].join("\n");
    expect(resolveConflictedBaseline(text)).toEqual({ crap: 1, mutation: {} });
  });

  // 衝突でないものに触ると、正常な読み込みまでこの経路に乗ってしまう。
  it("マーカーが無ければ null", () => {
    expect(resolveConflictedBaseline('{"crap": 7, "mutation": {}}')).toBeNull();
  });

  // 種置き（負債の記録が全部消える）に落とすより、どちらかの実測が残る方が近い。
  it("片側だけ読めるなら読める側", () => {
    const text = ["<<<<<<< HEAD", '{"crap": 4, "mutation": {}}', "=======", "{ not json", ">>>>>>> feature"].join("\n");
    expect(resolveConflictedBaseline(text)).toEqual({ crap: 4, mutation: {} });
  });

  it("両側とも読めなければ null", () => {
    const text = ["<<<<<<< HEAD", "{ not json", "=======", "{ also broken", ">>>>>>> feature"].join("\n");
    expect(resolveConflictedBaseline(text)).toBeNull();
  });

  it("マーカーの対応が崩れていれば null", () => {
    const text = ["<<<<<<< HEAD", '{"crap": 1, "mutation": {}}', "=======", '{"crap": 2, "mutation": {}}'].join("\n");
    expect(resolveConflictedBaseline(text)).toBeNull();
  });

  // 3 種が揃っていても順序が崩れている形。マーカー検出は通り、再構成で落ちる —
  // その経路（conflictSides が null）を resolveConflictedBaseline 越しに確かめる。
  it("マーカーが揃っていても順序が崩れていれば null", () => {
    const text = [">>>>>>> f", "<<<<<<< HEAD", '{"crap": 1, "mutation": {}}', "=======", '{"crap": 2, "mutation": {}}'].join("\n");
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
