/**
 * CRAP の式。gauntlet 全体で唯一の定義。
 *
 * アダプタは cc と coverage を報告するだけで、式は持たない。
 * 2 言語目が来たときに式が 2 つになることを防ぐ。
 */

/**
 * `CRAP = CC² × (1 − coverage)³ + CC`
 *
 * coverage が 1 なら CRAP は CC そのもの。coverage が下がると三乗で効く。
 *
 * @param cc 循環的複雑度（1 以上）
 * @param coverage 0..1
 */
export function crap(cc: number, coverage: number): number {
  const uncovered = 1 - coverage;
  return cc * cc * uncovered * uncovered * uncovered + cc;
}

/**
 * 全社共通の閾値。リポジトリごとに上書きできない。
 *
 * 上書きを許すと共用の意味が消えるため、リポジトリ固有の事情は
 * この数値ではなく baseline ratchet が吸収する。
 *
 * 8 の実質的な意味: coverage 100% なら CC 8 まで、80% で 7、50% で 4、0% で 2。
 */
export const CRAP_THRESHOLD = 8;

/** 触った関数がゲートを通るか。 */
export function withinThreshold(cc: number, coverage: number): boolean {
  return crap(cc, coverage) <= CRAP_THRESHOLD;
}
