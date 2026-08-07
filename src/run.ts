/**
 * tier の実行。CLI から切り離してテスト可能にしてある。
 */

import { execFileSync } from "node:child_process";
import { ConfigError, type GauntletConfig, loadConfig } from "./config.ts";
import { loadBaseline, saveBaseline } from "./baseline.ts";
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
import { runTests } from "./typescript/runner.ts";

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

function typecheck(root: string, config: GauntletConfig): CheckResult {
  return timed("typecheck", () => {
    try {
      execFileSync("npx", (config.commands?.typecheck ?? "tsc --noEmit").split(" "), {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
      });
      return [];
    } catch (error) {
      const output = String((error as { stdout?: string }).stdout ?? (error as Error).message).trim();
      return [{ message: output }];
    }
  });
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
  const outcome = runTests(root, tier === "turn" ? base : null);
  const report = analyze(root, config, outcome.coverage);

  const checks: CheckResult[] = [];
  for (const name of TIER_CHECKS[tier]) {
    if (name === "typecheck") checks.push(typecheck(root, config));
    else if (name === "tests") checks.push(testsCheck(outcome));
    else if (name === "crap") checks.push(crapCheck(root, tier, report, base));
    else checks.push(pending(name));
  }

  return { tier, status: tierStatus(checks), checks, durationMs: performance.now() - started };
}

function testsCheck(outcome: ReturnType<typeof runTests>): CheckResult {
  return timed("tests", () =>
    outcome.passed ? [] : [{ message: `${outcome.failed} / ${outcome.total} 件が失敗: ${outcome.failedFiles.join(", ")}` }],
  );
}

function crapCheck(root: string, tier: TierName, report: ReturnType<typeof analyze>, base: string): CheckResult {
  return timed("crap", () => {
    const violations = gateTouched(report, changedLines(root, base));
    // リポジトリ全体のラチェットはフル実行のある pr でだけ判定する。
    if (tier !== "pr") return violations;

    const outcome = gateRepository(report, loadBaseline(root));
    if (outcome.kind === "regressed") {
      violations.push({ message: `リポジトリ全体の違反が ${outcome.allowed} → ${outcome.actual} に増えました` });
    }
    // 改善は自動で固定する。記録し損ねると許容値が緩いまま残る。
    if (outcome.kind === "improved") saveBaseline(root, { crap: outcome.to });
    return violations;
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
