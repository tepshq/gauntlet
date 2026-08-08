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

/**
 * 測れていないのに緑を出さないための検査。
 *
 * 設定が現実とずれると、gauntlet は「違反ゼロ」を報告する。走らなかったゲートが
 * 緑に見えるのは、設計で `flaky` として避けた形そのもの。落として理由を言う。
 *
 * `coverageExpected` — vitest は `--changed` のとき coverage を**変更ファイルだけに絞る**
 * （hue の実測。unchanged は丸ごと欠落する）。だから触った関数が 0 の `turn` では、
 * テストが何千件走っても coverage が空なのが正常で、設定のずれとは区別できる。
 * フル実行の `pr` では常に true（hono で誤検知して入れた。設定だけの差分で全テストが
 * 選ばれ、正しく空の coverage を「噛み合っていない」と誤認して落ちた）。
 */
export function measurementFaults(report: AdapterReport, testsRan: number, coverageExpected: boolean): Violation[] {
  if (report.functions.length === 0) {
    return [
      {
        message:
          "測る対象が 1 つもありません。gauntlet.config.json の source.include が" +
          "実在しないパスを指している可能性があります",
      },
    ];
  }
  // テストが走ったのに 1 関数も覆われていないなら、coverage の設定が噛み合っていない。
  // 「テストが無いから 0%」と区別がつかないまま全関数を違反にしてはいけない。
  if (coverageExpected && testsRan > 0 && report.functions.every((fn) => fn.coverage === 0)) {
    return [
      {
        message:
          `テストが ${testsRan} 件走ったのに、どの関数も覆われていません。` +
          "vitest の coverage.include が測る対象と噛み合っていない可能性があります",
      },
    ];
  }
  return [];
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

/** 差分に含まれる関数。何件見たかを言うために、違反かどうかとは別に数えられるようにする。 */
export function touchedFunctions(report: AdapterReport, changed: Map<string, Set<number>>): FunctionReport[] {
  return report.functions.filter((fn) => isTouched(fn.location, changed));
}

/** 触った関数に絶対閾値を当てる。 */
export function gateTouched(report: AdapterReport, changed: Map<string, Set<number>>): Violation[] {
  return touchedFunctions(report, changed).filter(violatesThreshold).map(toViolation);
}

/**
 * リポジトリ全体の違反数を許容値と突き合わせる。フル実行の結果にだけ当てる。
 *
 * 記録が無ければ今の実測値を種にする（`seeded`）。既存リポジトリを導入初日に
 * 赤で埋めないため。以降はそこから下げる方向にしか動かない。
 */
export function gateRepository(report: AdapterReport, baseline: Baseline | null): RatchetOutcome {
  const actual = report.functions.filter(violatesThreshold).length;
  if (baseline === null) return { kind: "seeded", to: actual };
  return ratchet(baseline, actual);
}
