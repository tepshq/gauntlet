/**
 * 抽象 2 枚目 — tier の契約。
 *
 * どの tier が何を走らせ、何を返し、どの exit code を出すか。
 * フックも CI も同じコマンドを呼ぶので、この契約が両者の唯一の接点になる。
 */

/** 起動点で呼ぶ。番号は使わない（中間の tier を作らないため）。 */
export type TierName = "turn" | "pr";

export type CheckName = "typecheck" | "tests" | "crap" | "lint" | "mutation";

/**
 * 各 tier が走らせるチェック。
 *
 * `turn` は「壊していないか」、`pr` は「壊していないか + 危なくないか」。
 * mutation はエージェントが自分のテストで自分を採点する構造の穴を塞ぐため、
 * `pr` にのみ置く（`turn` の予算に収まらない）。
 */
export const TIER_CHECKS: Record<TierName, readonly CheckName[]> = {
  turn: ["typecheck", "tests", "crap"],
  pr: ["typecheck", "tests", "crap", "lint", "mutation"],
};

export interface Violation {
  /** 一行で、それだけ読めば直せる形に。関数の違反なら `describeLocation` の出力を含める。 */
  message: string;
  file?: string;
  line?: number;
}

/**
 * チェック 1 つの結果。
 *
 * `skip` が無いのは意図的。走らなかったチェックがあると、緑の意味が
 * 実行ごとに変わって flaky になる。走れないなら fail させる。
 */
export interface CheckResult {
  name: CheckName;
  status: "pass" | "fail";
  durationMs: number;
  violations: Violation[];
  /**
   * このチェックが**何を見たか**。緑のときにこそ要る。
   *
   * 「対象 0 件で緑」と「見て問題なし」は、違反が無いという結果だけでは区別できない。
   * 判定を足すのではなく、数を出して読み手が確かめられるようにする。
   * 任意にしない。出し忘れたチェックが「何も見ていない」と区別できなくなる。
   */
  scope: string;
}

export interface TierResult {
  tier: TierName;
  status: "pass" | "fail";
  checks: CheckResult[];
  durationMs: number;
}

/** 全チェック通過。 */
export const EXIT_PASS = 0;

/**
 * 違反があった、または gauntlet 自身が走れなかった。
 *
 * 両方を同じ code にしているのは、Claude Code の `Stop` フックが
 * exit 2 のみを「停止を阻止」として扱い、それ以外を非ブロックとして
 * 素通しするため。走れなかった gauntlet が黙って緑になると flaky になる。
 * 違反と内部エラーの区別は code ではなくメッセージで伝える。
 */
export const EXIT_BLOCKED = 2;

export function tierStatus(checks: readonly CheckResult[]): "pass" | "fail" {
  return checks.every((check) => check.status === "pass") ? "pass" : "fail";
}

export function exitCodeFor(result: TierResult): number {
  return result.status === "pass" ? EXIT_PASS : EXIT_BLOCKED;
}
