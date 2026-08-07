/**
 * vitest の実行。
 *
 * **vitest の exit code は使わない。** プロジェクトが coverage 閾値を設定していると、
 * 部分実行は必ずそれを下回って exit 1 になる（hue で実測）。しきい値の上書きは
 * glob キー付きの設定には効かないので、テスト結果と coverage を別経路で取る。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IstanbulCoverage } from "./coverage.ts";

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

/** vitest の JSON reporter が返すもののうち、判定に使う部分。 */
interface VitestJsonReport {
  success: boolean;
  numTotalTests: number;
  numFailedTests: number;
  testResults?: { name: string; status: string }[];
}

export interface TestOutcome {
  passed: boolean;
  total: number;
  failed: number;
  failedFiles: string[];
  coverage: IstanbulCoverage;
}

function readJson<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (cause) {
    throw new RunnerError(`${what} を読めません（vitest が異常終了した可能性）: ${(cause as Error).message}`);
  }
}

function vitestArgs(base: string | null, outDir: string): string[] {
  const args = ["vitest", "run", "--coverage", "--coverage.provider=v8", "--coverage.reporter=json"];
  if (base !== null) args.push(`--changed=${base}`);
  args.push(`--coverage.reportsDirectory=${join(outDir, "coverage")}`);
  args.push("--reporter=json", `--outputFile=${join(outDir, "result.json")}`);
  return args;
}

/**
 * テストを走らせて、結果と coverage を返す。
 *
 * `base` を渡すとその起点以降の変更に関係するテストだけを走らせる。
 * `--changed` は変更ファイルを import する全テストをモジュールグラフから選ぶので、
 * 変更ファイルの coverage はこれで完全になる。
 */
export function runTests(root: string, base: string | null): TestOutcome {
  const outDir = mkdtempSync(join(tmpdir(), "gauntlet-"));
  try {
    // exit code は握り潰す。閾値違反とテスト失敗が区別できないため。
    try {
      execFileSync("npx", vitestArgs(base, outDir), { cwd: root, encoding: "utf8", stdio: "pipe" });
    } catch {
      /* 判定は下の JSON で行う */
    }

    const report = readJson<VitestJsonReport>(join(outDir, "result.json"), "vitest の実行結果");
    const coverage = readJson<IstanbulCoverage>(
      join(outDir, "coverage", "coverage-final.json"),
      "coverage-final.json",
    );

    return {
      passed: report.success && report.numFailedTests === 0,
      total: report.numTotalTests,
      failed: report.numFailedTests,
      failedFiles: (report.testResults ?? []).filter((r) => r.status === "failed").map((r) => r.name),
      coverage,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
