/**
 * Istanbul の coverage-final.json を関数単位に割り当てる。
 *
 * CRAP が要求するのは関数ごとの網羅率。Istanbul が持つ `f`（関数の呼び出し回数）は
 * 「何回呼ばれたか」であって網羅率ではないので使わない。関数の範囲に入る
 * ステートメントの被覆率を数える。
 */

import type { FunctionLocation } from "../report.ts";
import type { ExtractedFunction } from "./complexity.ts";

interface Position {
  line: number;
  column: number;
}

export interface IstanbulFileCoverage {
  statementMap: Record<string, { start: Position }>;
  s: Record<string, number>;
  /**
   * 関数ごとの呼び出し回数。**網羅率には使わない**（回数は被覆率ではない）。
   * 使うのは `coveredFiles` の「このテストはこのファイルの振る舞いを動かしたか」だけで、
   * そこでは 0 か 1 以上かしか見ない。
   */
  f: Record<string, number>;
}

export type IstanbulCoverage = Record<string, IstanbulFileCoverage>;

/**
 * 位置が関数の範囲に入るか。
 *
 * 行だけで見ると、関数の開始行にある外側のステートメントが内側の関数に吸われる。
 * `return xs.map((x) => {` の `return` はアロー関数のものではない。
 */
function contains(location: FunctionLocation, line: number, column: number): boolean {
  const afterStart =
    line > location.startLine || (line === location.startLine && column >= location.startColumn);
  const beforeEnd = line < location.endLine || (line === location.endLine && column <= location.endColumn);
  return afterStart && beforeEnd;
}

function startsLater(a: FunctionLocation, b: FunctionLocation): boolean {
  if (a.startLine !== b.startLine) return a.startLine > b.startLine;
  return a.startColumn > b.startColumn;
}

/**
 * ステートメントを、それを直接囲む関数に割り当てる。
 *
 * 入れ子のとき外側に数えると、コールバックの網羅率が外側に混ざって
 * どちらの数字も意味を失う。入れ子では内側ほど開始位置が後ろになる。
 */
function innermost(functions: readonly ExtractedFunction[], line: number, column: number): ExtractedFunction | null {
  let best: ExtractedFunction | null = null;
  for (const candidate of functions) {
    if (!contains(candidate.location, line, column)) continue;
    if (best === null || startsLater(candidate.location, best.location)) best = candidate;
  }
  return best;
}

interface Tally {
  covered: number;
  total: number;
}

function tally(functions: readonly ExtractedFunction[], file: IstanbulFileCoverage): Map<ExtractedFunction, Tally> {
  const tallies = new Map<ExtractedFunction, Tally>(functions.map((fn) => [fn, { covered: 0, total: 0 }]));
  for (const [id, statement] of Object.entries(file.statementMap)) {
    const owner = innermost(functions, statement.start.line, statement.start.column);
    if (owner === null) continue;
    const entry = tallies.get(owner)!;
    entry.total++;
    if ((file.s[id] ?? 0) > 0) entry.covered++;
  }
  return tallies;
}

/**
 * 関数ごとの網羅率を 0..1 で返す。
 *
 * coverage にファイルが無いのは「どのテストも触れていない」ことを意味するので 0。
 * ステートメントを持たない関数（覆うものが無い）の 1 とは別物なので、分けて扱う。
 * 混ぜると、新しく足された未テストのファイルが無検査で緑になる。
 */
export function coverageByFunction(
  functions: readonly ExtractedFunction[],
  file: IstanbulFileCoverage | undefined,
): Map<ExtractedFunction, number> {
  if (file === undefined) return new Map(functions.map((fn) => [fn, 0]));

  const result = new Map<ExtractedFunction, number>();
  for (const [fn, { covered, total }] of tally(functions, file)) {
    result.set(fn, total === 0 ? 1 : covered / total);
  }
  return result;
}
