#!/usr/bin/env node
/**
 * 唯一の入口。`Stop` フックも `PreToolUse` フックも CI も、同じこのコマンドを呼ぶ。
 *
 * ここは薄く保つ。判断は run.ts と guard.ts にあり、そちらはテストできる。
 */

import { readFileSync } from "node:fs";
import { GUARD_MESSAGE, shouldBlock } from "./guard.ts";
import { run } from "./run.ts";
import { EXIT_BLOCKED, EXIT_PASS, exitCodeFor } from "./tier.ts";

function guard(): number {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (!shouldBlock(input as Parameters<typeof shouldBlock>[0])) return EXIT_PASS;
  process.stderr.write(`${GUARD_MESSAGE}\n`);
  return EXIT_BLOCKED;
}

function main(argv: readonly string[]): number {
  if (argv[0] === "guard") return guard();
  const { output, result } = run(argv, process.cwd());
  process.stderr.write(`${output}\n`);
  return exitCodeFor(result);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // gauntlet 自身が走れなかった場合も阻止側に倒す。素通しすると flaky になる。
  process.stderr.write(`gauntlet: ${(error as Error).message}\n`);
  process.exitCode = EXIT_BLOCKED;
}
