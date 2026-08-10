import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPackageManager, fromPackageManagerField, installDevCommand } from "./package-manager.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gauntlet-pm-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("fromPackageManagerField", () => {
  it.each([
    ["pnpm@11.15.1", "pnpm"],
    ["yarn@4.0.0", "yarn"],
    ["bun@1.2.0", "bun"],
    ["npm@11.0.0", "npm"],
  ] as const)("%s → %s", (value, expected) => {
    expect(fromPackageManagerField(value)).toBe(expected);
  });

  // 知らない PM を npm と誤断すると、間違ったコマンドを断言することになる。
  it("知らない名前は null", () => {
    expect(fromPackageManagerField("deno@2.0.0")).toBe(null);
  });
});

describe("detectPackageManager", () => {
  // Corepack の宣言はリポジトリの明示的な意思。lockfile（移行の残骸が共存しうる）より強い。
  it("packageManager フィールドが lockfile より優先", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.15.1" }));
    writeFileSync(join(root, "package-lock.json"), "{}");
    expect(detectPackageManager(root)).toBe("pnpm");
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const)("%s から %s を推定", (lockfile, expected) => {
    writeFileSync(join(root, lockfile), "");
    expect(detectPackageManager(root)).toBe(expected);
  });

  it("手がかりが無ければ npm", () => {
    expect(detectPackageManager(root)).toBe("npm");
  });

  it("package.json が壊れていても落ちず lockfile に進む", () => {
    writeFileSync(join(root, "package.json"), "{ broken");
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(root)).toBe("pnpm");
  });

  it("フィールドが知らない PM なら lockfile に進む", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "deno@2.0.0" }));
    writeFileSync(join(root, "yarn.lock"), "");
    expect(detectPackageManager(root)).toBe("yarn");
  });
});

describe("installDevCommand", () => {
  // メッセージに埋めてそのまま実行される 1 行。動詞を間違えると従った人の lockfile を汚す。
  it.each([
    ["npm", "npm i -D eslint"],
    ["pnpm", "pnpm add -D eslint"],
    ["yarn", "yarn add -D eslint"],
    ["bun", "bun add -d eslint"],
  ] as const)("%s の動詞", (pm, expected) => {
    expect(installDevCommand(pm, ["eslint"])).toBe(expected);
  });

  it("複数パッケージを空白で並べる", () => {
    expect(installDevCommand("pnpm", ["@stryker-mutator/core", "@stryker-mutator/vitest-runner"])).toBe(
      "pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner",
    );
  });
});
