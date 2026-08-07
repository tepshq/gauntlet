/**
 * tier の実行。CLI から切り離してテスト可能にしてある。
 */

import { relative } from "node:path";
import { ConfigError, type GauntletConfig, loadConfig } from "./config.ts";
import { loadBaseline, ratchetByFile, saveBaseline } from "./baseline.ts";
import { type Captured, captureShell } from "./exec.ts";
import { gateRepository, gateTouched } from "./gate.ts";
import { changedLines, mergeBase } from "./git.ts";
import {
  type CheckName,
  type CheckResult,
  TIER_CHECKS,
  type TierName,
  type TierResult,
  type Violation,
  tierStatus,
} from "./tier.ts";
import { analyze } from "./typescript/adapter.ts";
import { runLint } from "./typescript/lint.ts";
import { runMutation } from "./typescript/mutation.ts";
import { type TestOutcome, runTests } from "./typescript/runner.ts";

const TIER_NAMES: readonly TierName[] = ["turn", "pr"];

function isTierName(value: string): value is TierName {
  return (TIER_NAMES as readonly string[]).includes(value);
}

export function parseTier(argv: readonly string[]): TierName {
  const flag = argv.find((arg) => arg.startsWith("--tier="));
  const value = flag?.slice("--tier=".length);
  if (value === undefined || value === "") {
    throw new ConfigError(`--tier が必要です（${TIER_NAMES.join(" | ")}）`);
  }
  if (!isTierName(value)) {
    throw new ConfigError(`--tier=${value} は未対応です（${TIER_NAMES.join(" | ")}）`);
  }
  return value;
}

function timed(name: CheckName, body: () => Violation[]): CheckResult {
  const started = performance.now();
  const violations = body();
  return {
    name,
    status: violations.length === 0 ? "pass" : "fail",
    durationMs: performance.now() - started,
    violations,
  };
}

export const DEFAULT_TYPECHECK = "tsc --noEmit";

/** tsc は診断を標準出力に出す。出ていなければ通っている。 */
export function typecheckViolations(result: Captured): Violation[] {
  return result.stdout.trim() === "" ? [] : [{ message: result.combined.trim() }];
}

/** 型エラーの判定はプロジェクトの設定に従う。gauntlet はコマンドを走らせるだけ。 */
function typecheck(root: string, config: GauntletConfig): CheckResult {
  const command = config.commands?.typecheck ?? DEFAULT_TYPECHECK;
  return timed("typecheck", () => typecheckViolations(captureShell(command, root)));
}

/**
 * まだ実装されていないチェックは fail にする。
 *
 * 未実装を pass にすると、チェックが増えるたびに緑の意味が変わる。
 */
function pending(name: CheckName): CheckResult {
  return { name, status: "fail", durationMs: 0, violations: [{ message: `${name} は未実装です` }] };
}

export function runTier(root: string, tier: TierName): TierResult {
  const started = performance.now();
  const config = loadConfig(root);
  const base = mergeBase(root, config.defaultBranch);

  // turn は差分に関係するテストだけ、pr は全体を走らせる。
  const testsStarted = performance.now();
  const outcome = runTests(root, tier === "turn" ? base : null);
  const testsMs = performance.now() - testsStarted;

  const report = analyze(root, config, outcome.coverage);
  const changed = changedLines(root, base);

  const runners: Record<CheckName, () => CheckResult> = {
    typecheck: () => typecheck(root, config),
    tests: () => testsCheck(outcome, testsMs),
    crap: () => crapCheck(tier, report, changed, outcome.passed),
    mutation: () => mutationCheck(root, config, mutationScope(root, base)),
    lint: () => lintCheck(root, config),
  };
  const checks = TIER_CHECKS[tier].map((name) => runners[name]());

  return { tier, status: tierStatus(checks), checks, durationMs: performance.now() - started };
}

/** テストの実行はチェックの評価より前に済んでいるので、所要時間は外から渡す。 */
export function testsCheck(outcome: Pick<TestOutcome, "passed" | "failed" | "total" | "failedFiles">, durationMs: number): CheckResult {
  const violations = outcome.passed
    ? []
    : [{ message: `${outcome.failed} / ${outcome.total} 件が失敗: ${outcome.failedFiles.join(", ")}` }];
  return { name: "tests", status: violations.length === 0 ? "pass" : "fail", durationMs, violations };
}

/**
 * この実行で実際に走ったテストが触れたソース。
 *
 * coverage-final.json は絶対パスをキーに持つので、リポジトリ相対に直す。
 */
function coveredFiles(root: string, coverage: Record<string, unknown>): string[] {
  return Object.keys(coverage).map((absolute) => relative(root, absolute).split("\\").join("/"));
}

/**
 * 変異させる範囲。**差分に関係するテストが触れたソースだけ。**
 *
 * `pr` は全テストを走らせるので、その coverage を使うとリポジトリのほぼ全部が対象になる。
 * teps の実測では 135 ファイル・約 23,000 変異で、ローカル 47 分・CI で数時間になった。
 * 1 変異あたり 124ms のうち約 7 割は変異を差し替える往復のオーバーヘッドで、
 * テスト自体（11 件・38ms）は速い。回数が問題なので、範囲を絞るしかない。
 *
 * そのために `--changed` の実行を 1 回足す（teps で約 8 秒）。分単位と引き換えなら安い。
 * テストファイルを変更すれば `--changed` がそれを選ぶので、
 * assert を消しただけの差分を捕まえる経路は保たれる。
 */
function mutationScope(root: string, base: string): string[] {
  return coveredFiles(root, runTests(root, base).coverage);
}

/**
 * リポジトリ全体のラチェットを当て、必要なら記録を更新する。
 *
 * 改善と初回の種置きは自動で固定する。記録し損ねると許容値が緩いまま残り、
 * あとで同じだけ悪化させても通ってしまう。
 */
export function applyRatchet(report: ReturnType<typeof analyze>): Violation[] {
  const baseline = loadBaseline(report.root);
  const outcome = gateRepository(report, baseline);
  if (outcome.kind === "regressed") {
    return [{ message: `リポジトリ全体の違反が ${outcome.allowed} → ${outcome.actual} に増えました` }];
  }
  if (outcome.kind !== "ok") saveBaseline(report.root, { ...EMPTY_BASELINE, ...baseline, crap: outcome.to });
  return [];
}

/**
 * テストが落ちていると coverage が無い（vitest は落ちると書き出さない）。
 *
 * そのまま当てると全関数が網羅率 0 と見なされ、偽の違反で本当の原因が埋もれる。
 * 通さないが、理由はテストだと言う。
 */
export const CRAP_NEEDS_TESTS: Violation = { message: "テストが落ちているため計測できません" };

/** リポジトリ全体のラチェットはフル実行のある `pr` でだけ判定する。 */
export function crapViolations(
  tier: TierName,
  report: ReturnType<typeof analyze>,
  changed: Map<string, Set<number>>,
): Violation[] {
  return [...gateTouched(report, changed), ...(tier === "pr" ? applyRatchet(report) : [])];
}

function crapCheck(
  tier: TierName,
  report: ReturnType<typeof analyze>,
  changed: Map<string, Set<number>>,
  testsPassed: boolean,
): CheckResult {
  return timed("crap", () => (testsPassed ? crapViolations(tier, report, changed) : [CRAP_NEEDS_TESTS]));
}

/**
 * 変異させる対象。テストファイルと除外指定は外す。
 *
 * **変更されたファイルではなく、この差分で実際に走ったテストが触れたソースを渡す。**
 * 変更ファイルだけを対象にすると、テストの assert を消しただけの差分では
 * 対応するソースが変異対象から外れ、mutation ゲートを素通りできてしまう（gameable）。
 */
export function mutationTargets(covered: Iterable<string>, exclude: readonly string[]): string[] {
  const excluded = new Set(exclude);
  const isSource = (file: string): boolean => file.endsWith(".ts") && !file.endsWith(".test.ts");
  return [...covered].filter((file) => isSource(file) && !excluded.has(file)).sort();
}

export function countByFile(mutants: readonly { file: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const mutant of mutants) counts[mutant.file] = (counts[mutant.file] ?? 0) + 1;
  return counts;
}

const EMPTY_BASELINE = { crap: 0, mutation: {}, lint: {} };

/**
 * ファイル単位のラチェットを当て、記録を更新する。mutation と lint が共有する。
 *
 * 0 件を要求すると既存リポジトリはどこも導入できない（gauntlet 自身ですら
 * 生き残りが 53 件あった）。CRAP と同じく「増やさない」だけを課す。
 */
function gateByFile(
  root: string,
  key: "mutation" | "lint",
  targets: readonly string[],
  counts: Record<string, number>,
  describe: (entry: { file: string; allowed: number; actual: number }) => string,
): Violation[] {
  const baseline = loadBaseline(root) ?? EMPTY_BASELINE;
  const { regressed, updated } = ratchetByFile(baseline[key], targets, counts);
  saveBaseline(root, { ...baseline, [key]: updated });
  return regressed.map((entry) => ({ message: describe(entry), file: entry.file }));
}

/** 差分に関係するソースだけを変異させる。既存リポジトリ全体を一度に赤にしない。 */
function mutationCheck(root: string, config: GauntletConfig, covered: Iterable<string>): CheckResult {
  const targets = mutationTargets(covered, config.source.exclude ?? []);
  return timed("mutation", () =>
    targets.length === 0
      ? []
      : gateByFile(
          root,
          "mutation",
          targets,
          countByFile(runMutation(root, targets)),
          (entry) => `テストを通り抜ける変異が ${entry.allowed} → ${entry.actual} に増えました  ${entry.file}`,
        ),
  );
}

/** ルールは対象リポジトリが持つ。gauntlet は件数を増やさせないだけ。 */
function lintCheck(root: string, config: GauntletConfig): CheckResult {
  return timed("lint", () => {
    const counts = runLint(root, config.source.include);
    // 対象は「エラーがあったファイル」ではなく「今回 lint したファイル」。
    // 直して 0 件になったファイルの記録も下げる必要がある。
    const scanned = [...new Set([...Object.keys(counts), ...Object.keys(loadBaseline(root)?.lint ?? {})])];
    return gateByFile(root, "lint", scanned, counts, (entry) => {
      return `lint エラーが ${entry.allowed} → ${entry.actual} に増えました  ${entry.file}`;
    });
  });
}

export function formatResult(result: TierResult): string {
  const lines = result.checks.map((check) => {
    const mark = check.status === "pass" ? "✓" : "✗";
    const detail = check.violations.map((violation) => `\n    ${violation.message}`).join("");
    return `  ${mark} ${check.name} (${check.durationMs.toFixed(0)}ms)${detail}`;
  });
  const header = `gauntlet ${result.tier}: ${result.status} (${result.durationMs.toFixed(0)}ms)`;
  return [header, ...lines].join("\n");
}

export function run(argv: readonly string[], cwd: string): { output: string; result: TierResult } {
  const result = runTier(cwd, parseTier(argv));
  return { output: formatResult(result), result };
}
