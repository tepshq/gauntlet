/**
 * oxc-parser の AST を歩くための最小限の道具。
 *
 * oxc はオフセット（UTF-16、JS 文字列インデックス）だけを持ち `loc` を持たないので、
 * 行番号はこちらで引く。
 */

export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

/** 子ノードを列挙する。AST の形に依存せず、値を舐めて Node を拾う。 */
export function childrenOf(node: Node): Node[] {
  const children: Node[] = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

/** 各行の開始オフセット。行番号引きの索引。 */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** オフセットから 1 始まりの行番号。 */
export function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** オフセットから 0 始まりの列番号。 */
export function columnAt(starts: readonly number[], offset: number): number {
  return offset - starts[lineAt(starts, offset) - 1]!;
}
