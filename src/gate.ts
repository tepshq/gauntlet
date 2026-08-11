/**
 * レポートに閾値を当てる。言語に依らない。
 *
 * `quick` は触った関数だけを見る。部分実行の coverage は触っていないファイルを
 * 網羅率 0 として報告するので、全体に当てると偽陽性が大量に出る（hue で 201 件）。
 * リポジトリ全体のラチェットはフル実行のある `full` でだけ判定する。
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
 * **判定できるのはフル実行（`full`）だけ。** vitest は `--changed` のとき coverage を
 * 変更ファイルだけに絞る（hue の実測。unchanged は丸ごと欠落する）ので、`quick` では
 * 「変更したファイルがテストに触られていない」だけで全関数 0% になる。新規の未テスト
 * ファイルを 1 つ足した差分がまさにそれで、正しい CRAP 違反が「設定のずれ」に化けて
 * 関数名もスコアも消えていた（h3 で実測）。`quick` のこの条件には識別力が無い。
 *
 * 配線が壊れていれば `full` が落とす。`quick` では網羅率 0% の違反として出る。
 */
export function measurementFaults(
  report: AdapterReport,
  testsRan: number,
  fullRun: boolean,
  deadIncludes: readonly string[] = [],
): Violation[] {
  // 他の include が生きていても落とす。そこだけ抜けた範囲で緑になるのが一番危ない。
  if (deadIncludes.length > 0) {
    const named = deadIncludes.map((pattern) => `\`${pattern}\``).join("、");
    return [
      {
        message:
          `gauntlet.config.json の source.include の ${named} は、` +
          "ディレクトリなど計測できないものにだけマッチしています。" +
          "`src/**/*.ts` のようにファイルを名指しする形で書いてください",
      },
    ];
  }
  if (report.functions.length === 0) {
    return [
      {
        message:
          "測る対象が 1 つもありません。gauntlet.config.json の source.include が" +
          "実在しないパスを指している可能性があります",
      },
    ];
  }
  // 全テストが走ったのに 1 関数も覆われていないなら、coverage の設定が噛み合っていない。
  // 「テストが無いから 0%」と区別がつかないまま全関数を違反にしてはいけない。
  if (fullRun && testsRan > 0 && report.functions.every((fn) => fn.coverage === 0)) {
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

/**
 * その複雑度が閾値を通るのに要る網羅率（%）。**通せないなら null。**
 *
 * 網羅率 100% では `CRAP = 複雑度` なので、閾値 8 は高複雑度側では複雑度の上限として
 * 働く。複雑度 9 以上はどれだけテストを足しても通らない。
 * 式を解くと `c = 1 − ∛((閾値 − 複雑度) / 複雑度²)`。
 */
export function requiredCoverage(cc: number): number | null {
  const room = (CRAP_THRESHOLD - cc) / (cc * cc);
  if (room < 0) return null;
  // 複雑度が小さいと解が負になる（そもそもどの網羅率でも閾値を超えない）。
  return Math.max(0, Math.ceil((1 - Math.cbrt(room)) * 100));
}

/**
 * 違反 1 件に次の一手を添える。
 *
 * 数字だけ出すと「テストを足す」に読まれるが、複雑度が閾値を超えていると
 * それでは永遠に通らない（h3 では違反 35 件のうち 25 件が網羅率 90〜100% だった）。
 * どちらなのかは複雑度から一意に決まるので、読み手に逆算させない。
 */
export function crapAdvice(cc: number): string {
  const required = requiredCoverage(cc);
  return required === null
    ? `複雑度 ${CRAP_THRESHOLD + 1} 以上はテストでは通りません。関数を割ってください`
    : `網羅率 ${required}% で通ります`;
}

/** 違反の説明。gateTouched の違反にも、pr のラチェット報告の一覧にも同じ形で載る。 */
export function crapText(fn: FunctionReport): string {
  const score = crap(fn.cc, fn.coverage).toFixed(1);
  const coverage = (fn.coverage * 100).toFixed(0);
  const where = describeLocation(fn.location);
  return `CRAP ${score} (> ${CRAP_THRESHOLD})  複雑度 ${fn.cc} / 網羅率 ${coverage}%  ${where}  → ${crapAdvice(fn.cc)}`;
}

function toViolation(fn: FunctionReport): Violation {
  return { message: crapText(fn), file: fn.location.file, line: fn.location.startLine };
}

export interface GateResult {
  violations: Violation[];
  /** `full` でだけ判定する。`quick` では null。 */
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

/** 閾値を超えている関数。ラチェットはこの数を数え、後退の報告はこの一覧を名指しする。 */
export function repositoryViolators(report: AdapterReport): FunctionReport[] {
  return report.functions.filter(violatesThreshold);
}

/**
 * リポジトリ全体の違反数を許容値と突き合わせる。フル実行の結果にだけ当てる。
 *
 * 記録が無ければ今の実測値を種にする（`seeded`）。既存リポジトリを導入初日に
 * 赤で埋めないため。以降はそこから下げる方向にしか動かない。
 */
export function gateRepository(report: AdapterReport, baseline: Baseline | null): RatchetOutcome {
  const actual = repositoryViolators(report).length;
  if (baseline === null) return { kind: "seeded", to: actual };
  return ratchet(baseline, actual);
}
