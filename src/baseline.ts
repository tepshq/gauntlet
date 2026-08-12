/**
 * ラチェット。
 *
 * 既存リポジトリを一括で赤にせず、触った箇所だけ確実に良くなる方向へ動かす。
 * 記録するのは「リポジトリ全体で許容する違反数」ひとつだけ。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BASELINE_FILENAME = "gauntlet.baseline.json";

export interface Baseline {
  /**
   * リポジトリ全体で許容する CRAP 違反の数。
   *
   * **無いのと 0 は違う。** 0 は「測って違反ゼロだった」で、そのまま最も厳しい基準として
   * 噛む。計測が完了しなかった回に 0 を書くと、次の完走が「0 → 772 に増えました」に
   * なって恒久的な赤になり、guard が記録の書き換えを止めるのでエージェントには
   * 出口が無い（#28 で実測）。だから測れなかったゲートの欄は無いままにする — optional。
   */
  crap?: number;
  /**
   * リポジトリ全体で許容する重複トークンの数。
   *
   * 0.11.0 で追加。それ以前の baseline には無いので optional — 無ければ
   * 種を置いて落とす（「種を置いた回は通さない」は crap と同じ）。
   */
  duplication?: number;
  /**
   * ファイルごとに許容する「生き残った変異」。
   *
   * CRAP と違って単一の数にできない。mutation は差分に関係するファイルだけを
   * 対象にするので、件数は差分の大きさで変わり、リポジトリ全体の 1 つの数と
   * 比べても意味を持たない。今回の対象になったファイルだけを突き合わせる。
   */
  mutation: Record<string, MutationRecord>;
}

/**
 * ファイル 1 つ分の mutation の記録。
 *
 * **生き残りの数は単調ではない。** テストを足すと `--ignoreStatic` で外れていた変異が
 * 測定に入り、触っていないファイルの生き残りが**増える**（39 → 41 で実際に落ちた。
 * テストを足したのに赤くなる、というゲートの動機と逆の向き）。だから測った数も残し、
 * 突き合わせるときに**測定集合が広がった分だけ増加を許す**。assert を消す形の攻撃は
 * 測った数が変わらないので、余裕は生まれず今までどおり落ちる。
 */
export interface MutationRecord {
  /** 生き残った変異の数。 */
  survived: number;
  /** 測った変異の数（Ignored / NoCoverage を除く）。0.22 より前の記録には無い。 */
  measured: number | null;
  /**
   * 打ち切られた変異の数。0.23 より前の記録には無い。
   *
   * **突き合わせは `survived + timeout` で行う。** 打ち切りの閾値は実行速度に比例する
   * （`timeoutFactor × 通常実行時間`）ので、「遅くなるだけの変異」は速い機械では
   * Timeout、遅い CI では Survived になる — 同じコミットで手元と CI の生き残りが
   * 食い違い、**何度締めても CI が通らない**（+3 が常に残る実測がある）。
   * 副作用も正しい向きで、「時計で殺した」変異は借金の返済に数えられなくなる。
   *
   * **ただし和が環境不変なのは 3 通りの入れ替わりのうち 1 つだけ**（#37 / #39 で実測）:
   *
   * | 入れ替わり | `survived + timeout` |
   * | --- | --- |
   * | Survived ↔ Timeout | 不変（#26 が想定したもの） |
   * | Timeout ↔ Killed | 変わる（速いほど小さい） |
   * | Survived ↔ Killed | 変わる（時計に依存するテストがあると起きる） |
   *
   * だから**この数は締める側でも守る** — 打ち切りを下げてよいのは、そのファイルの
   * ソースが差分にある回だけ（`ratchetByFile` の `touched`）。打ち切りはテストでは
   * 減らせないので、下がったのは「コードの形が変わったか、機械が速かったか」の
   * どちらかしかない。
   */
  timeout: number | null;
  /**
   * どのテストも通っていない変異の数。0.24 より前の記録には無い。
   *
   * **`survived + timeout` とは別の軸**として突き合わせる（足し込むと既存リポジトリが
   * 導入初日に赤で埋まる。gauntlet 自身にも 222 件あった）。直し方も違う —
   * 生き残りは assert を強める話、これは**テストから呼べる形にする**話。
   *
   * **「無い」と 0 は違う。** 旧記録を 0 と読むと、初めて測れた回が「0 → 19 に増えました」で
   * 落ちて、全リポジトリが上げた瞬間に赤になる（#28 と同じ形の逆向き）。null は
   * 「まだ測っていない」で、最初に測れた回が種を置く。
   */
  noCoverage: number | null;
}

/** 数でなければ「その欄は無い」。**0 に丸めない** — 無いのと 0 は別物（#28 / #31）。 */
function toCount(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** 0.22 より前は生き残りの数だけを記録していた。読める形は全部受ける。 */
function toRecord(value: unknown): MutationRecord | null {
  if (typeof value === "number") return { survived: value, measured: null, timeout: null, noCoverage: null };
  if (typeof value === "object" && value !== null && "survived" in value) {
    const { survived, measured, timeout, noCoverage } = value as Record<string, unknown>;
    if (typeof survived !== "number") return null;
    return { survived, measured: toCount(measured), timeout: toCount(timeout), noCoverage: toCount(noCoverage) };
  }
  return null;
}

/**
 * 読める形なら Baseline に、そうでなければ null。読み込みと衝突解決が共有する。
 *
 * **「無い」はゲートごとに読む。** 記録は 1 ファイルだが、そこに値を置くゲートは 3 つ
 * あって、片方だけが完走する回がある（crap が計測を中断し、duplication は完走した —
 * #28 の形）。ファイルがあることと、そのゲートの値があることは別。混ぜて欠けた欄に
 * 0 を埋めると、測っていないゲートに最も厳しい基準が入る。
 */
export function parseBaseline(text: string): Baseline | null {
  try {
    const data = JSON.parse(text) as unknown;
    // オブジェクトでなければ記録ではない（「欄が 1 つも無い記録」とは別物）。
    if (typeof data !== "object" || data === null) return null;
    return toBaseline(data as Partial<Baseline>);
  } catch {
    return null;
  }
}

/** 読める欄だけを拾う。**読めない欄は落とし、0 で埋めない。** */
function toBaseline(data: Partial<Baseline>): Baseline {
  const mutation: Record<string, MutationRecord> = {};
  for (const [file, value] of Object.entries(data.mutation ?? {})) {
    const record = toRecord(value);
    if (record !== null) mutation[file] = record;
  }
  // 無いのと 0 は違う。無ければ欄ごと無し（種を置く判定に使う）。
  return {
    ...(typeof data.crap === "number" ? { crap: data.crap } : {}),
    ...(typeof data.duplication === "number" ? { duplication: data.duplication } : {}),
    mutation,
  };
}

/**
 * まだ記録が無ければ null。
 *
 * 呼び出し側は最初の実測値でそこに種を置く。0 から始めると、既存リポジトリは
 * 導入した瞬間に赤で埋まって誰も入れられない。ラチェットは「今より悪くしない」
 * ための仕組みであって、導入初日に借金を返させるものではない。
 */
export function loadBaseline(root: string): Baseline | null {
  try {
    return parseBaseline(readFileSync(join(root, BASELINE_FILENAME), "utf8"));
  } catch {
    return null;
  }
}

export function saveBaseline(root: string, baseline: Baseline): void {
  // measured が無い（旧形式から読んだ）記録は survived だけで書く。null を書くと
  // 「測って 0 だった」と区別できない。
  const mutation = Object.fromEntries(
    Object.entries(baseline.mutation).map(([file, record]) => [
      file,
      Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null)),
    ]),
  );
  writeFileSync(join(root, BASELINE_FILENAME), `${JSON.stringify({ ...baseline, mutation }, null, 2)}\n`);
}

/**
 * 記録の読み書き口。**書いてよい実行かどうかを、この差し替えで表す。**
 *
 * 以前は各ゲートがディスクに直接書き、実行の最後に「clean でなければ書き戻す」形
 * だった。それだと**書いた瞬間から書き戻すまでの数十秒〜分単位の窓**があり、そこで
 * プロセスが死ぬと（Ctrl-C、CI の timeout、使用量上限での kill — 実際に報告がある）
 * 作業途中の値がディスクに残る。防ごうとした事故がそのまま起きる。
 * 書けない実行ではメモリに逸らせば、窓ごと消える。
 */
export interface BaselineStore {
  load(): Baseline | null;
  save(baseline: Baseline): void;
}

export function diskStore(root: string): BaselineStore {
  return { load: () => loadBaseline(root), save: (baseline) => saveBaseline(root, baseline) };
}

/** ディスクには触れない。ゲートは普段どおり書き、結果は知らせ（notes）にだけ使われる。 */
export function memoryStore(initial: Baseline | null): BaselineStore {
  let current = initial;
  return {
    load: () => current,
    save: (baseline) => {
      current = baseline;
    },
  };
}

export type RatchetOutcome =
  | { kind: "ok" }
  | { kind: "seeded"; to: number }
  | { kind: "improved"; from: number; to: number }
  | { kind: "regressed"; allowed: number; actual: number };

/**
 * 実測を許容値と突き合わせる。単一の数の ratchet で、crap と duplication が共有する。
 *
 * 改善は自動で固定し、後退だけを落とす。改善を記録し損ねると許容値が緩いまま残り、
 * あとで同じだけ悪化させても通ってしまう。
 *
 * 「記録が無いなら種を置く」の判定はここには無い。許容値のあるなしを知っているのは
 * 呼び出し側（`gateRepository` / `duplicationViolations`）で、そこに 1 つずつある。
 */
export function ratchetNumber(allowed: number, actual: number): RatchetOutcome {
  if (actual > allowed) return { kind: "regressed", allowed, actual };
  if (actual < allowed) return { kind: "improved", from: allowed, to: actual };
  return { kind: "ok" };
}

/**
 * 後退 1 件。**軸を持つ。**
 *
 * mutation は 1 ファイルに 2 つの借金を記録する（殺せなかった変異と、テストが届いて
 * いない変異）。どちらが増えたのかは直し方が違うので、混ぜて 1 種類の文にできない。
 */
export type MutationRegression =
  | {
      kind: "undetected";
      file: string;
      /**
       * **突き合わせた数そのもの**（殺せなかった変異 = 生き残り + 打ち切り。
       * 旧記録で打ち切りを持たない回は生き残りだけ）。
       *
       * ここに生き残りの数を入れていたせいで、打ち切りだけが増えた回に
       * **`0 → 0 に増えました`** という自己矛盾した文が出ていた（#39）。
       * 判定に使った数と読み手に見せる数は同じでなければならない。
       */
      allowed: number;
      actual: number;
      /** 内訳。どれが動いたかで直し方が変わる（打ち切りはテストでは減らせない）。 */
      survivedBefore: number;
      survivedNow: number;
      /** 旧記録（0.23 より前）は null。 */
      timeoutBefore: number | null;
      timeoutNow: number | null;
      /** 旧記録（0.22 より前）は null。突き合わせの条件が読み手に見えるように残す。 */
      measuredBefore: number | null;
      measuredNow: number | null;
    }
  | { kind: "noCoverage"; file: string; allowed: number; actual: number };

export interface FileRatchet {
  regressed: MutationRegression[];
  updated: Record<string, MutationRecord>;
}

/**
 * ファイルごとに件数を突き合わせる。mutation が使う。
 *
 * 記録が無いファイルは今の実測値を種にする。既存リポジトリは導入時点で
 * 大量に抱えているので、0 から始めると誰も入れられない。
 */
/**
 * ファイル 1 つ分の突き合わせ。超えていれば報告の材料を、収まっていれば null を返す。
 *
 * 測定集合が広がった分（テストが増えて static が測定に入った等）は増加を許す。
 * 旧記録（measured 無し）には余裕を作れないので、従来どおり厳格に比べる。
 * 比べる数は「殺せなかった数」= survived + timeout。打ち切りの閾値は実行速度に
 * 比例して動くので、Survived と Timeout の境目は環境で揺れる — 和は揺れない。
 * 旧記録（timeout 無し）は survived だけで比べる（和に混ぜると片側だけ膨らむ）。
 */
function undetectedRegression(
  file: string,
  limit: MutationRecord,
  actual: MutationRecord,
): MutationRegression | null {
  // 二重の歯止め: measured が 0 の記録にも余裕を作らない。0/0/0 の記録に measured の
  // 余裕を与えると ceiling = actual.measured になり、survived + timeout は measured の
  // 部分集合なので**必ず通る** — そのファイルのゲートが恒久的に無効になる（#27 で実測）。
  const slack = !limit.measured ? 0 : Math.max(0, (actual.measured ?? 0) - limit.measured);
  const undetected = limit.timeout == null ? actual.survived : actual.survived + (actual.timeout ?? 0);
  const allowed = limit.survived + (limit.timeout ?? 0);
  if (undetected <= allowed + slack) return null;
  return {
    kind: "undetected",
    file,
    // **判定に使った数をそのまま渡す。** 見出しに生き残りを出すと、打ち切りだけが
    // 増えた回に「0 → 0 に増えました」になる（#39）。余裕（slack）は足さない —
    // 許容値は記録された数で、slack は測定集合が広がった回だけの一時的な緩和。
    allowed,
    actual: undetected,
    survivedBefore: limit.survived,
    survivedNow: actual.survived,
    timeoutBefore: limit.timeout,
    timeoutNow: actual.timeout,
    measuredBefore: limit.measured,
    measuredNow: actual.measured,
  };
}

/**
 * テストが届いていない変異が増えたか。**測定集合の余裕は作らない。**
 *
 * `undetected` 側の slack（measured が増えた分は許す）は「テストを足したら測定に入った」
 * ための緩和だが、こちらにその形は無い — テストを足せば NoCoverage は**減る**方向にしか
 * 動かない。増えるのは未テストのコードが増えたときだけなので、厳密に比べる。
 *
 * 旧記録（欄なし = null）は突き合わせず種を置く。0 と読むと、上げた瞬間に
 * 全リポジトリが「0 → N に増えました」で赤になる（#28 と同じ形の逆向き）。
 */
function noCoverageRegression(
  file: string,
  limit: MutationRecord,
  actual: MutationRecord,
): MutationRegression | null {
  if (limit.noCoverage === null) return null;
  const now = actual.noCoverage ?? 0;
  if (now <= limit.noCoverage) return null;
  return { kind: "noCoverage", file, allowed: limit.noCoverage, actual: now };
}

/** ファイル 1 つ分を全部の軸で突き合わせる。**両方増えたら両方言う** — 直し方が違う。 */
function fileRegressions(
  file: string,
  limit: MutationRecord | undefined,
  actual: MutationRecord,
): MutationRegression[] {
  if (limit === undefined) return [];
  return [undetectedRegression(file, limit, actual), noCoverageRegression(file, limit, actual)].filter(
    (entry): entry is MutationRegression => entry !== null,
  );
}

/**
 * git の衝突マーカー。**行頭の 7 連続文字だけを見る。**
 *
 * 記録は gauntlet が書く JSON（インデント付き）なので、通常の内容が行頭から
 * マーカーで始まることは無い。3 種が揃っているときだけ衝突とみなす —
 * 1 種だけの一致で解決を走らせると、手で千切られた断片まで「解決」してしまう。
 */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7} /m.test(text) && /^={7}$/m.test(text) && /^>{7} /m.test(text);
}

/** マーカー行が区間をどう動かすか。`from` に居ないときの一致は対応の崩れ。 */
type Region = "shared" | "ours" | "base" | "theirs";
const MARKER_TRANSITIONS: readonly { marker: RegExp; from: readonly Region[]; to: Region }[] = [
  { marker: /^<{7} /, from: ["shared"], to: "ours" },
  // diff3 / zdiff3 の base 区間。ラベルは付くことも付かないこともある。
  { marker: /^\|{7}( |$)/, from: ["ours"], to: "base" },
  { marker: /^={7}$/, from: ["ours", "base"], to: "theirs" },
  { marker: /^>{7} /, from: ["theirs"], to: "shared" },
];

/** その区間の行が入る側。base はどちらの側でもない（マージ前の共通祖先）。 */
const REGION_SIDES: Record<Region, readonly ("ours" | "theirs")[]> = {
  shared: ["ours", "theirs"],
  ours: ["ours"],
  base: [],
  theirs: ["theirs"],
};

/**
 * 衝突マーカーから両側の全文を再構成する。
 *
 * git は差分の行だけをマーカーで挟むので、外側の共有行は両側に入れる。
 * マーカーの対応が崩れていれば null — 千切られた断片を JSON.parse に回すより、
 * 「読めない」に落として種置き（それは赤くなる）に任せる方が安全。
 */
export function conflictSides(text: string): { ours: string; theirs: string } | null {
  const sides = { ours: [] as string[], theirs: [] as string[] };
  let region: Region = "shared";
  for (const line of text.split("\n")) {
    const transition = MARKER_TRANSITIONS.find((entry) => entry.marker.test(line));
    if (transition === undefined) {
      for (const side of REGION_SIDES[region]) sides[side].push(line);
    } else if (transition.from.includes(region)) {
      region = transition.to;
    } else {
      return null;
    }
  }
  if (region !== "shared") return null;
  return { ours: sides.ours.join("\n"), theirs: sides.theirs.join("\n") };
}

/**
 * 2 つの記録の厳しい側。
 *
 * 突き合わせが見るのは「殺せなかった数」= survived + timeout なので、その和が
 * 小さい方が厳しい。和が同じなら measured が大きい方 — 測定集合が広がった分だけ
 * 増加を許す（slack）ので、measured が大きいほど将来の余裕が小さい。
 * measured 無し（旧形式）は slack を作れない = 一番厳しいので、和が同じなら勝つ。
 * 2 つの record の欄を混ぜて第 3 の record を合成することはしない —
 * どちらの実測でもない値を記録に書かない。
 */
export function tighterRecord(a: MutationRecord, b: MutationRecord): MutationRecord {
  const undetectedA = a.survived + (a.timeout ?? 0);
  const undetectedB = b.survived + (b.timeout ?? 0);
  if (undetectedA < undetectedB) return a;
  if (undetectedB < undetectedA) return b;
  return (a.measured ?? Infinity) >= (b.measured ?? Infinity) ? a : b;
}

/**
 * 無い方は「まだゲートが無い」なので、有る方が常に厳しい。両方有れば小さい方。
 *
 * crap と duplication が共有する。**`Math.min` で済ませてはいけない** — 片側に欄が
 * 無いと `NaN` が記録に書かれ、以降どんな実測とも比べられなくなる（#28 で crap も
 * optional になったので、crap 側にも同じ穴が開いていた）。
 */
function tighterCount(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * 衝突した 2 つの記録を、フィールドごとに厳しい側でマージする。
 *
 * 両側とも「どこかのブランチで実測してコミットされた値」なので、厳しい側を
 * 機械的に取ればエージェントに値を選ばせずに済む（gameable にならない）。
 * 厳しすぎる方向にずれたら、それはラチェットが普段から出す要求
 * （後からマージする側が差を埋める）と同じ形で現れる。
 * mutation はファイルの和集合 — 片側にしか無い記録を落とすと、その負債が消える。
 */
export function mergeBaselines(ours: Baseline, theirs: Baseline): Baseline {
  const mutation: Record<string, MutationRecord> = {};
  for (const file of new Set([...Object.keys(ours.mutation), ...Object.keys(theirs.mutation)])) {
    const a = ours.mutation[file];
    const b = theirs.mutation[file];
    mutation[file] = a === undefined ? b! : b === undefined ? a : tighterRecord(a, b);
  }
  const crap = tighterCount(ours.crap, theirs.crap);
  const duplication = tighterCount(ours.duplication, theirs.duplication);
  return {
    ...(crap === undefined ? {} : { crap }),
    ...(duplication === undefined ? {} : { duplication }),
    mutation,
  };
}

/**
 * 衝突した記録の本文を解決する。衝突でない・読めないなら null（呼び出し側は何もしない）。
 *
 * 片側だけ読めるなら読める側 — 種置き（負債の記録が全部消える）に落とすより、
 * どちらかの実測が残る方が近い。
 */
export function resolveConflictedBaseline(text: string): Baseline | null {
  if (!hasConflictMarkers(text)) return null;
  const sides = conflictSides(text);
  if (sides === null) return null;
  const parsed = [parseBaseline(sides.ours), parseBaseline(sides.theirs)].filter(
    (side): side is Baseline => side !== null,
  );
  if (parsed.length === 0) return null;
  return parsed.length === 1 ? parsed[0]! : mergeBaselines(parsed[0]!, parsed[1]!);
}

/**
 * 記録に書く値。**打ち切りは、そのファイルのソースを触った回だけ締める。**
 *
 * 打ち切りは実行ごとに揺れる（同じコード・同じマシンで 5 → 4 → 3 の実測がある）。
 * ラチェットは締まる方向にしか動かないので、揺らぐ量に当てると**記録が揺らぎの
 * 最小値へ収束し、その後は上振れするたびに落ちる**（#39）。しかもテストでは減らせない
 * ので、落ちても打つ手が無い。
 *
 * **軸を分けられるのは、打ち切りだけが「テストで動かせない」から。** 打ち切りが下がるのは
 * 「コードの形が変わったか、機械が速かったか」のどちらかしかないので、**ソースが差分に
 * ある回だけ締めれば揺らぎは記録に入らない**。生き残りにこの制限を当ててはいけない —
 * 生き残りを減らす標準的なやり方はテストを足すことで、**ソースを触らない改善が普通に
 * ある**（そこを締めないと、いちばん歓迎すべき改善が記録されなくなる。#39 の指摘）。
 *
 * 旧記録（欄なし）への初回の書き込みは「締め」ではないので、触っていなくても入れる。
 */
function recordFor(limit: MutationRecord | undefined, actual: MutationRecord, touched: boolean): MutationRecord {
  const keep = limit?.timeout;
  // 触っていないファイルの打ち切りは**動かさない**（下げない・上げない）。上振れを
  // そのまま書くと記録が緩むので、「締めない」ではなく「凍らせる」が正しい。
  return touched || keep == null ? actual : { ...actual, timeout: keep };
}

export function ratchetByFile(
  allowed: Record<string, MutationRecord>,
  scanned: readonly string[],
  counts: Record<string, MutationRecord>,
  /** ソースが差分にあるファイル。打ち切りを締めてよいのはここだけ（#39）。 */
  touched: ReadonlySet<string> = new Set(scanned),
): FileRatchet {
  const regressed: FileRatchet["regressed"] = [];
  const updated = { ...allowed };
  for (const file of scanned) {
    const actual = counts[file];
    // 測定結果が無いファイルは、突き合わせも更新もしない。0/0/0 を「実測」として
    // 書くと、負債の記録が消える（#27 では 17 件・19 件・2 件の負債が記録上 0 になり、
    // measured の余裕と組み合わさってゲートが外れた）。候補に入っても測られない経路は
    // 普通にある — 型定義だけのファイル、変異の作れないファイル。
    if (actual === undefined) continue;
    // どれか 1 つの軸でも後退していれば記録は動かさない（片方だけ締めると、
    // 後退した軸の許容値が「直った後の実測」で置き直せなくなる）。
    const entries = fileRegressions(file, allowed[file], actual);
    if (entries.length > 0) regressed.push(...entries);
    else updated[file] = recordFor(allowed[file], actual, touched.has(file));
  }
  return { regressed, updated };
}
