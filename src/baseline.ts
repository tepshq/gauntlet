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
}

/**
 * 読める形なら Baseline に、そうでなければ null。読み込みと衝突解決が共有する。
 *
 * **「無い」はゲートごとに読む。** 記録は 1 ファイルだが、そこに値を置くゲートは複数
 * あって、片方だけが完走する回がある（crap が計測を中断し、duplication は完走した —
 * #28 の形）。ファイルがあることと、そのゲートの値があることは別。混ぜて欠けた欄に
 * 0 を埋めると、測っていないゲートに最も厳しい基準が入る。
 *
 * 知らない欄は黙って落とす。0.27.0 より前の記録が持つ `mutation` の欄はここで消え、
 * 次に記録を書く回にファイルからも消える（mutation ゲートは 0.27.0 で外した）。
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
  // 無いのと 0 は違う。無ければ欄ごと無し（種を置く判定に使う）。
  return {
    ...(typeof data.crap === "number" ? { crap: data.crap } : {}),
    ...(typeof data.duplication === "number" ? { duplication: data.duplication } : {}),
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
  writeFileSync(join(root, BASELINE_FILENAME), `${JSON.stringify(baseline, null, 2)}\n`);
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
 */
export function mergeBaselines(ours: Baseline, theirs: Baseline): Baseline {
  const crap = tighterCount(ours.crap, theirs.crap);
  const duplication = tighterCount(ours.duplication, theirs.duplication);
  return {
    ...(crap === undefined ? {} : { crap }),
    ...(duplication === undefined ? {} : { duplication }),
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
