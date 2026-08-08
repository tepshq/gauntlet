/**
 * 重複（コピペ）の測定。jscpd を叩いて、リポジトリ全体の重複トークン数を 1 つ返す。
 *
 * **jscpd は gauntlet が同梱してバージョンを固定する。** 対象リポジトリごとに版が
 * ずれると、同じコードで数字が変わる（flaky）。eslint や Stryker と違って対象側の
 * 何にも合わせる必要が無いので、同梱できる。
 *
 * **単位はトークン。** 行だと整形（改行位置の変更）だけで数字が動く。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capture } from "../exec.ts";
import { RunnerError, lastLines } from "./runner.ts";

/** 全社で 1 つ。リポジトリごとに変えると「重複」の意味が repo ごとに違ってしまう。 */
export const MIN_TOKENS = 50;

export interface DuplicationResult {
  /** 重複しているトークンの総数。ratchet が持つ数。 */
  duplicatedTokens: number;
  /** 解析したファイル数。scope の報告用。 */
  sources: number;
}

/**
 * 対象は解決済みのファイル一覧を位置引数で渡す。glob を渡すと jscpd の glob 実装と
 * `listSourceFiles` の解決がずれうる — CRAP が測るのと同一の集合であることを保証する。
 */
export function jscpdArgs(files: readonly string[], outDir: string): string[] {
  return [
    ...files,
    "--min-tokens",
    String(MIN_TOKENS),
    "--reporters",
    "json",
    "--output",
    outDir,
    "--silent",
  ];
}

/** レポートの形が想定とずれたとき、黙って 0 と読まない。 */
export function parseDuplication(text: string, detail: string): DuplicationResult {
  let total: { duplicatedTokens?: unknown; sources?: unknown };
  try {
    total = (JSON.parse(text) as { statistics: { total: typeof total } }).statistics.total;
  } catch {
    throw new RunnerError(`jscpd のレポートを読めません:\n${lastLines(detail, 15)}`);
  }
  const { duplicatedTokens, sources } = total;
  if (typeof duplicatedTokens !== "number" || typeof sources !== "number") {
    throw new RunnerError(`jscpd のレポートに statistics.total がありません:\n${lastLines(detail, 15)}`);
  }
  return { duplicatedTokens, sources };
}

/**
 * 同梱した jscpd の実体。`exports` が bin への subpath 解決を塞ぐので package.json から辿り、
 * bin の場所も決め打ちしない — 5.x はプラットフォーム別実装へのラッパー（`run-jscpd.js`）で、
 * 置き場所はパッケージの都合で変わる。宣言（`bin.jscpd`）だけを信じる。
 */
function jscpdBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("jscpd/package.json");
  const declared = (require(pkgPath) as { bin: { jscpd: string } }).bin.jscpd;
  return join(dirname(pkgPath), declared);
}

/** 対象が 1 つ以上あることは呼び出し側が保証する。 */
export function runDuplication(root: string, files: readonly string[]): DuplicationResult {
  const outDir = mkdtempSync(join(tmpdir(), "gauntlet-jscpd-"));
  try {
    const { combined } = capture("node", [jscpdBin(), ...jscpdArgs(files, outDir)], root);
    let text: string;
    try {
      text = readFileSync(join(outDir, "jscpd-report.json"), "utf8");
    } catch {
      throw new RunnerError(`jscpd がレポートを出しませんでした:\n${lastLines(combined, 15)}`);
    }
    return parseDuplication(text, combined);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
