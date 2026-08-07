/**
 * 抽象 1 枚目 — 言語アダプタが吐く JSON の形。
 *
 * アダプタの責務は「この言語のソースから、関数単位の複雑度と網羅率を出す」ことだけ。
 * git の差分も閾値も CRAP の式も知らない。それらは core 側にあり、
 * 2 言語目のアダプタがどれも再実装せずに済むようにしてある。
 */

/** アダプタが吐く JSON の版。破壊的変更でのみ上げる。 */
export const REPORT_SCHEMA_VERSION = 1;

/**
 * 関数の識別子。
 *
 * 実コードでは名前が直接取れる関数は 2〜3 割で、残りはアロー関数のコールバック。
 * 名前だけでは一意にならないので、位置と囲っているスコープを併せて持つ。
 */
export interface FunctionLocation {
  /** リポジトリルートからの相対パス。区切りは常に `/`。 */
  file: string;
  /** 直接取れた名前。取れなければ `null`。 */
  name: string | null;
  /** 囲っている名前付きスコープを外側から。`["UserService", "fetchUser"]` */
  scope: string[];
  /** 1 始まり。 */
  startLine: number;
  /** 0 始まり。 */
  startColumn: number;
  /** 1 始まり。差分との交差判定に使う。 */
  endLine: number;
  /**
   * 0 始まり。
   *
   * 行だけで包含を判定すると、関数の開始行にある外側のステートメントが
   * 内側の関数に吸われる（`return xs.map((x) => {` の `return` など）。
   */
  endColumn: number;
}

/** 関数 1 つ分の計測結果。CRAP は core が式を持つのでここには無い。 */
export interface FunctionReport {
  location: FunctionLocation;
  /** 循環的複雑度。1 以上。 */
  cc: number;
  /** 0..1。 */
  coverage: number;
}

/** 計測から外したファイルとその理由。黙って落とすと flaky になるので必ず載せる。 */
export interface ExcludedFile {
  file: string;
  reason: string;
}

export interface AdapterReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  adapter: { name: string; version: string };
  /** 計測したリポジトリルートの絶対パス。 */
  root: string;
  functions: FunctionReport[];
  excluded: ExcludedFile[];
}

/**
 * 関数を人間とエージェントに向けて一意に名指しする。
 *
 * 名前が無い関数が過半数なので、`file:line` を常に含める。
 * 例: `src/user.ts:47 fetchUser > (anonymous)`
 */
export function describeLocation(location: FunctionLocation): string {
  const path = `${location.file}:${location.startLine}`;
  const trail = [...location.scope, location.name ?? "(anonymous)"];
  return `${path} ${trail.join(" > ")}`;
}
