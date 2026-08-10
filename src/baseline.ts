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
   * ファイルごとに許容する「生き残った変異」の数。
   *
   * CRAP と違って単一の数にできない。mutation は差分に関係するファイルだけを
   * 対象にするので、件数は差分の大きさで変わり、リポジトリ全体の 1 つの数と
   * 比べても意味を持たない。今回の対象になったファイルだけを突き合わせる。
   */
  mutation: Record<string, number>;
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
    return {
      crap: data.crap,
      // 無いのと 0 は違う。無ければ欄ごと無し（種を置く判定に使う）。
      ...(typeof data.duplication === "number" ? { duplication: data.duplication } : {}),
      mutation: data.mutation ?? {},
    };
  } catch {
    return null;
  }
}

export function saveBaseline(root: string, baseline: Baseline): void {
  writeFileSync(join(root, BASELINE_FILENAME), `${JSON.stringify(baseline, null, 2)}\n`);
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
  /** 許容数を超えたファイル。 */
  regressed: { file: string; allowed: number; actual: number }[];
  /** 対象になったファイルの新しい許容数。対象外のファイルは元のまま残す。 */
  updated: Record<string, number>;
}

/**
 * ファイルごとに件数を突き合わせる。mutation が使う。
 *
 * 記録が無いファイルは今の実測値を種にする。既存リポジトリは導入時点で
 * 大量に抱えているので、0 から始めると誰も入れられない。
 */
export function ratchetByFile(
  allowed: Record<string, number>,
  scanned: readonly string[],
  counts: Record<string, number>,
): FileRatchet {
  const regressed: FileRatchet["regressed"] = [];
  const updated = { ...allowed };
  for (const file of scanned) {
    const actual = counts[file] ?? 0;
    const limit = allowed[file];
    if (limit !== undefined && actual > limit) regressed.push({ file, allowed: limit, actual });
    else updated[file] = actual;
  }
  return { regressed, updated };
}
