/**
 * Node のバージョン判定。`cli.ts` が中身を読み込む前に呼ぶ。
 *
 * ここは `node:fs` を含めて何も import しない。古い Node でも必ず動く必要がある。
 */

/** `node:fs` の `globSync` が入ったバージョン。package.json の `engines` と揃える。 */
export const MINIMUM_NODE_MAJOR = 22;

/** 渡すのは `process.versions.node` だけ。読めない値のための分岐は作らない。 */
export function nodeTooOld(version: string): boolean {
  return Number(version.split(".")[0]) < MINIMUM_NODE_MAJOR;
}
