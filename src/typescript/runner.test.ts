import { describe, expect, it } from "vitest";
import { INTEGRATION_TEST_GLOB, RunnerError, vitestArgs } from "./runner.ts";

// 道具が落ちたのか違反があったのかを、呼び出し側が型で見分けられる必要がある。
describe("RunnerError", () => {
  it("名前で見分けられる", () => {
    expect(new RunnerError("x").name).toBe("RunnerError");
  });

  it("メッセージをそのまま持つ", () => {
    expect(new RunnerError("Stryker が入っていません").message).toBe("Stryker が入っていません");
  });

  it("Error として捕まえられる", () => {
    expect(new RunnerError("x")).toBeInstanceOf(Error);
  });
});

describe("vitestArgs", () => {
  const turn = vitestArgs("abc123", "/tmp/out");
  const pr = vitestArgs(null, "/tmp/out");

  // 引数は丸ごと固定する。部分一致で見ると、コマンド名や出力先が変わっても気づかない。
  it("pr は全部走らせる", () => {
    expect(pr).toEqual([
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      "--coverage.reportsDirectory=/tmp/out/coverage",
      "--reporter=json",
      "--outputFile=/tmp/out/result.json",
    ]);
  });

  // 手元に DB が無いだけで毎ターン赤になると、環境によって答えが変わる（flaky）。
  it("turn は差分に絞り、外部サービスを要するテストを除外する", () => {
    expect(turn).toEqual([
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      "--changed=abc123",
      `--exclude=${INTEGRATION_TEST_GLOB}`,
      "--coverage.reportsDirectory=/tmp/out/coverage",
      "--reporter=json",
      "--outputFile=/tmp/out/result.json",
    ]);
  });

  it("規約は integration の接尾辞", () => {
    expect(INTEGRATION_TEST_GLOB).toBe("**/*.integration.test.*");
  });
});
