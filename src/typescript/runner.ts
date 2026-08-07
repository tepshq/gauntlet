/**
 * vitest の実行。
 *
 * **vitest の exit code は使わない。** プロジェクトが coverage 閾値を設定していると、
 * 部分実行は必ずそれを下回って exit 1 になる（hue で実測）。しきい値の上書きは
 * glob キー付きの設定には効かないので、テスト結果と coverage を別経路で取る。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../exec.ts";
import type { IstanbulCoverage } from "./coverage.ts";

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

/** vitest の JSON reporter が返すもののうち、判定に使う部分。 */
export interface VitestJsonReport {
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

/**
 * 出力が無いときは vitest の出力を添える。
 *
 * 原因はほぼ常にそこに書かれている（依存の欠落、設定の誤りなど）。
 * 握り潰すと「ファイルがありません」だけが残り、辿れなくなる。
 */
function readJson<T>(path: string, what: string, output: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new RunnerError(`${what}を読めません。vitest の出力:\n${lastLines(output, 15)}`);
  }
}

export function lastLines(text: string, count: number): string {
  return text.split("\n").slice(-count).join("\n").trim();
}

/**
 * 外部サービス（DB・ネットワーク・実ファイルシステム）を要するテストを置く vitest project の名前。
 *
 * `turn` はこの project を除外する。開発者の手元に DB が無いだけで毎ターン赤になると、
 * ゲートが環境によって答えを変えることになる（flaky）。`pr` では走らせる。
 *
 * **glob の `--exclude` ではなく project 名で指定する。** `--exclude` は vitest の
 * `projects` に伝わらず、project を使うリポジトリでは黙って無効になる（duct で実測）。
 * `--project=!<name>` は project を使っていないリポジトリでは無害なので、
 * 1 つの仕組みで両方に効く。
 *
 * 設定項目にはしない。リポジトリごとに表現を変えられるようにすると、
 * 「速いループが外部サービスを要さない」という性質が repo ごとに違う意味を持つ。
 */
export const INTEGRATION_PROJECT = "integration";

/** vitest の JSON reporter の出力から、判定に使う部分だけ取り出す。 */
export function toOutcome(report: VitestJsonReport): Omit<TestOutcome, "coverage"> {
  return {
    passed: report.success && report.numFailedTests === 0,
    total: report.numTotalTests,
    failed: report.numFailedTests,
    // Stryker disable next-line ArrayDeclaration: 既定値に何を入れても
    // 直後の filter が status を見て落とすので、区別できる振る舞いが無い。
    failedFiles: (report.testResults ?? []).filter((r) => r.status === "failed").map((r) => r.name),
  };
}

export function vitestArgs(base: string | null, outDir: string, files: readonly string[] = []): string[] {
  const args = ["vitest", "run", "--coverage", "--coverage.provider=v8", "--coverage.reporter=json"];
  if (base !== null) args.push(`--changed=${base}`, `--project=!${INTEGRATION_PROJECT}`);
  args.push(`--coverage.reportsDirectory=${join(outDir, "coverage")}`);
  args.push("--reporter=json", `--outputFile=${join(outDir, "result.json")}`);
  // 位置引数はテストファイルの絞り込み。フラグの後ろに置く。
  args.push(...files);
  return args;
}

/**
 * テストを走らせて、結果と coverage を返す。
 *
 * `base` を渡すとその起点以降の変更に関係するテストだけを走らせる。
 * `--changed` は変更ファイルを import する全テストをモジュールグラフから選ぶので、
 * 変更ファイルの coverage はこれで完全になる。
 *
 * `files` を渡すとそのテストファイルだけを走らせる。どのソースを覆っているかを
 * 知るために使う（`mutationScope`）。`base` とは併用しない。
 */
export function runTests(root: string, base: string | null, files: readonly string[] = []): TestOutcome {
  const outDir = mkdtempSync(join(tmpdir(), "gauntlet-"));
  try {
    // exit code は握り潰す。閾値違反とテスト失敗が区別できないため。
    const { combined } = capture("npx", vitestArgs(base, outDir, files), root);
    const report = readJson<VitestJsonReport>(join(outDir, "result.json"), "vitest の実行結果", combined);
    const outcome = toOutcome(report);

    // **テストが落ちていれば coverage は無い。** vitest はテストが落ちると
    // coverage を書き出さない。ここで coverage の不在を報告すると、
    // 本当の原因（テストが落ちた）が見えなくなる。
    if (!outcome.passed) return { ...outcome, coverage: {} };

    const path = join(outDir, "coverage", "coverage-final.json");
    return { ...outcome, coverage: readJson<IstanbulCoverage>(path, "coverage-final.json", combined) };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
