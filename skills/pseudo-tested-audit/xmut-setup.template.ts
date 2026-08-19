/**
 * 対象リポジトリのルートに xmut-setup.ts として置くテンプレート。
 * __SW__ を <対象リポジトリ>/.xmut-switch の絶対パスに置換してから置くこと。
 * vitest.config の全 project の setupFiles に "./xmut-setup.ts" を足して配線する。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect } from "vitest";

let id = "";
try { id = readFileSync("__SW__/active-id", "utf8").trim(); } catch {}
(globalThis as any).__XMUT__ = id;
if (id === "") {
  const trace = new Set<string>();
  (globalThis as any).__XMUT_TRACE__ = trace;
  afterAll(() => {
    const testPath = String((expect.getState() as any).testPath ?? "unknown");
    if (trace.size === 0) return;
    // ファイル名はハッシュにする。パスをそのまま使うと ENAMETOOLONG（実測で踏んだ）。
    const name = createHash("sha1").update(testPath).digest("hex");
    mkdirSync("__SW__/trace", { recursive: true });
    writeFileSync(join("__SW__/trace", name + ".json"), JSON.stringify({ testPath, ids: [...trace] }));
  });
}
