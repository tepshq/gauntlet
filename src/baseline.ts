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
  /** リポジトリ全体で許容する CRAP 違反の数。 */
  crap: number;
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
}

/** 0.22 より前は生き残りの数だけを記録していた。読める形は全部受ける。 */
function toRecord(value: unknown): MutationRecord | null {
  if (typeof value === "number") return { survived: value, measured: null };
  if (typeof value === "object" && value !== null && "survived" in value) {
    const { survived, measured } = value as { survived: unknown; measured?: unknown };
    if (typeof survived !== "number") return null;
    return { survived, measured: typeof measured === "number" ? measured : null };
  }
  return null;
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
    const data = JSON.parse(readFileSync(join(root, BASELINE_FILENAME), "utf8")) as Partial<Baseline>;
    if (typeof data.crap !== "number") return null;
    const mutation: Record<string, MutationRecord> = {};
    for (const [file, value] of Object.entries(data.mutation ?? {})) {
      const record = toRecord(value);
      if (record !== null) mutation[file] = record;
    }
    return {
      crap: data.crap,
      // 無いのと 0 は違う。無ければ欄ごと無し（種を置く判定に使う）。
      ...(typeof data.duplication === "number" ? { duplication: data.duplication } : {}),
      mutation,
    };
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
      record.measured === null ? { survived: record.survived } : record,
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
 * 実測を許容値と突き合わせる。
 *
 * 改善は自動で固定し、後退だけを落とす。改善を記録し損ねると許容値が緩いまま残り、
 * あとで同じだけ悪化させても通ってしまう。
 */
/** 単一の数の ratchet。crap と duplication が共有する。 */
export function ratchetNumber(allowed: number, actual: number): RatchetOutcome {
  if (actual > allowed) return { kind: "regressed", allowed, actual };
  if (actual < allowed) return { kind: "improved", from: allowed, to: actual };
  return { kind: "ok" };
}

export function ratchet(baseline: Baseline, actual: number): RatchetOutcome {
  return ratchetNumber(baseline.crap, actual);
}

export interface FileRatchet {
  regressed: {
    file: string;
    allowed: number;
    actual: number;
    /** 旧記録（0.22 より前）は null。突き合わせの条件が読み手に見えるように残す。 */
    measuredBefore: number | null;
    measuredNow: number | null;
  }[];
  updated: Record<string, MutationRecord>;
}

/**
 * ファイルごとに件数を突き合わせる。mutation が使う。
 *
 * 記録が無いファイルは今の実測値を種にする。既存リポジトリは導入時点で
 * 大量に抱えているので、0 から始めると誰も入れられない。
 */
export function ratchetByFile(
  allowed: Record<string, MutationRecord>,
  scanned: readonly string[],
  counts: Record<string, MutationRecord>,
): FileRatchet {
  const regressed: FileRatchet["regressed"] = [];
  const updated = { ...allowed };
  for (const file of scanned) {
    const actual = counts[file] ?? { survived: 0, measured: 0 };
    const limit = allowed[file];
    // 測定集合が広がった分（テストが増えて static が測定に入った等）は増加を許す。
    // 旧記録（measured 無し）には余裕を作れないので、従来どおり厳格に比べる。
    const slack =
      limit?.measured == null ? 0 : Math.max(0, (actual.measured ?? 0) - limit.measured);
    if (limit !== undefined && actual.survived > limit.survived + slack) {
      regressed.push({
        file,
        allowed: limit.survived,
        actual: actual.survived,
        measuredBefore: limit.measured,
        measuredNow: actual.measured,
      });
    } else updated[file] = actual;
  }
  return { regressed, updated };
}
