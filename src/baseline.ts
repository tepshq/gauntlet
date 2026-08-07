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
}

/** 無ければ 0 から始める。新規リポジトリは最初から絶対閾値と同じ厳しさになる。 */
export function loadBaseline(root: string): Baseline {
  try {
    const data = JSON.parse(readFileSync(join(root, BASELINE_FILENAME), "utf8")) as Partial<Baseline>;
    return { crap: typeof data.crap === "number" ? data.crap : 0 };
  } catch {
    return { crap: 0 };
  }
}

export function saveBaseline(root: string, baseline: Baseline): void {
  writeFileSync(join(root, BASELINE_FILENAME), `${JSON.stringify(baseline, null, 2)}\n`);
}

export type RatchetOutcome =
  | { kind: "ok" }
  | { kind: "improved"; from: number; to: number }
  | { kind: "regressed"; allowed: number; actual: number };

/**
 * 実測を許容値と突き合わせる。
 *
 * 改善は自動で固定し、後退だけを落とす。改善を記録し損ねると許容値が緩いまま残り、
 * あとで同じだけ悪化させても通ってしまう。
 */
export function ratchet(baseline: Baseline, actual: number): RatchetOutcome {
  if (actual > baseline.crap) return { kind: "regressed", allowed: baseline.crap, actual };
  if (actual < baseline.crap) return { kind: "improved", from: baseline.crap, to: actual };
  return { kind: "ok" };
}
