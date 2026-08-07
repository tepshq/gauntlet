/**
 * レポートに閾値を当てる。言語に依らない。
 *
 * `turn` は触った関数だけを見る。部分実行の coverage は触っていないファイルを
 * 網羅率 0 として報告するので、全体に当てると偽陽性が大量に出る（hue で 201 件）。
 * リポジトリ全体のラチェットはフル実行のある `pr` でだけ判定する。
 */

import { type RatchetOutcome, ratchet } from "./baseline.ts";
import type { Baseline } from "./baseline.ts";
import { CRAP_THRESHOLD, crap } from "./crap.ts";
import { type AdapterReport, type FunctionLocation, type FunctionReport, describeLocation } from "./report.ts";
import type { Violation } from "./tier.ts";

function isTouched(location: FunctionLocation, changed: Map<string, Set<number>>): boolean {
  const lines = changed.get(location.file);
  if (lines === undefined) return false;
  for (const line of lines) {
    if (line >= location.startLine && line <= location.endLine) return true;
  }
  return false;
}

function violatesThreshold(fn: FunctionReport): boolean {
  return crap(fn.cc, fn.coverage) > CRAP_THRESHOLD;
}

function toViolation(fn: FunctionReport): Violation {
  const score = crap(fn.cc, fn.coverage).toFixed(1);
  const coverage = (fn.coverage * 100).toFixed(0);
  return {
    message: `CRAP ${score} (> ${CRAP_THRESHOLD})  複雑度 ${fn.cc} / 網羅率 ${coverage}%  ${describeLocation(fn.location)}`,
    file: fn.location.file,
    line: fn.location.startLine,
  };
}

export interface GateResult {
  violations: Violation[];
  /** `pr` でだけ判定する。`turn` では null。 */
  ratchet: RatchetOutcome | null;
}

/** 触った関数に絶対閾値を当てる。 */
export function gateTouched(report: AdapterReport, changed: Map<string, Set<number>>): Violation[] {
  return report.functions
    .filter((fn) => isTouched(fn.location, changed))
    .filter(violatesThreshold)
    .map(toViolation);
}

/** リポジトリ全体の違反数を許容値と突き合わせる。フル実行の結果にだけ当てる。 */
export function gateRepository(report: AdapterReport, baseline: Baseline): RatchetOutcome {
  return ratchet(baseline, report.functions.filter(violatesThreshold).length);
}
