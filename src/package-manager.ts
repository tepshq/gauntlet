/**
 * 対象リポジトリのパッケージマネージャを言い当てる。
 *
 * 「入っていません。次で入れてください」系のメッセージが npm 固定だと、
 * pnpm のリポジトリで従った人の lockfile を汚す（h3 の導入で気づいた小骨）。
 * gauntlet は依存を勝手に入れない — 正しいコマンドを言うためだけに使う。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** `packageManager` フィールド（"pnpm@11.15.1" 形式）から名前だけ取り出す。 */
export function fromPackageManagerField(value: string): PackageManager | null {
  const name = value.split("@")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" || name === "npm" ? name : null;
}

const LOCKFILES: readonly [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

/**
 * `packageManager` フィールドが正、無ければ lockfile から推定、どちらも無ければ npm。
 *
 * フィールドを優先するのは、それが Corepack の宣言 = リポジトリの明示的な意思だから。
 * lockfile は複数共存しうる（移行の残骸）。
 */
export function detectPackageManager(root: string): PackageManager {
  const declared = packageManagerField(root);
  if (declared !== null) return declared;
  const found = LOCKFILES.find(([file]) => existsSync(join(root, file)));
  return found === undefined ? "npm" : found[1];
}

function packageManagerField(root: string): PackageManager | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager?: string };
    return pkg.packageManager === undefined ? null : fromPackageManagerField(pkg.packageManager);
  } catch {
    return null;
  }
}

/** 開発依存を入れる 1 行。メッセージに埋め込んで、そのまま実行できる形で見せる。 */
export function installDevCommand(pm: PackageManager, packages: readonly string[]): string {
  const verb: Record<PackageManager, string> = {
    npm: "npm i -D",
    pnpm: "pnpm add -D",
    yarn: "yarn add -D",
    bun: "bun add -d",
  };
  return `${verb[pm]} ${packages.join(" ")}`;
}
