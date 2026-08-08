import { describe, expect, it } from "vitest";
import { INTEGRATION_PROJECT, RunnerError, toOutcome, vitestArgs } from "./runner.ts";

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

// 呼び出しは必ず it の中で行う。describe の直下で値を作ると、
// 変異が有効になる前に計算が終わっていて、テストが変異を検知できない。
describe("vitestArgs", () => {
  // 引数は丸ごと固定する。部分一致で見ると、コマンド名や出力先が変わっても気づかない。
  // integration project は pr でも除外する。gauntlet はこの project を一切見ない。
  it("pr は integration project 以外を全部走らせる", () => {
    expect(vitestArgs(null, "/tmp/out")).toEqual([
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      `--project=!${INTEGRATION_PROJECT}`,
      "--coverage.reportsDirectory=/tmp/out/coverage",
      "--reporter=json",
      "--outputFile=/tmp/out/result.json",
    ]);
  });

  // 手元に DB が無いだけで毎ターン赤になると、環境によって答えが変わる（flaky）。
  it("turn は差分に絞り、integration project を除外する", () => {
    expect(vitestArgs("abc123", "/tmp/out")).toEqual([
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      `--project=!${INTEGRATION_PROJECT}`,
      "--changed=abc123",
      "--coverage.reportsDirectory=/tmp/out/coverage",
      "--reporter=json",
      "--outputFile=/tmp/out/result.json",
    ]);
  });

  // 位置引数がフラグの前に来ると vitest が読み取れない。
  // 選択が 0 件になる組み合わせ（全部 integration 等）に特別なフラグは要らない —
  // 呼び出し元（mutationScope）は coverage しか読まず、coverage は空に潰れる。
  it("指定したテストファイルだけに絞る", () => {
    expect(vitestArgs(null, "/tmp/out", ["a.test.ts", "b.test.ts"])).toEqual([
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      `--project=!${INTEGRATION_PROJECT}`,
      "--coverage.reportsDirectory=/tmp/out/coverage",
      "--reporter=json",
      "--outputFile=/tmp/out/result.json",
      "a.test.ts",
      "b.test.ts",
    ]);
  });

  it("ファイル指定が無ければ位置引数を足さない", () => {
    expect(vitestArgs(null, "/tmp/out")).toEqual(vitestArgs(null, "/tmp/out", []));
  });

  it("規約は integration という project 名", () => {
    expect(INTEGRATION_PROJECT).toBe("integration");
  });
});

describe("toOutcome", () => {
  const base = { success: true, numTotalTests: 10, numFailedTests: 0 };

  it("通っていれば passed", () => {
    expect(toOutcome(base)).toEqual({ passed: true, total: 10, failed: 0, failedFiles: [] });
  });

  // success と numFailedTests のどちらかが異常なら通さない。
  it.each([
    ["success が false", { ...base, success: false }],
    ["失敗件数がある", { ...base, numFailedTests: 2 }],
  ])("%s なら passed にしない", (_label, report) => {
    expect(toOutcome(report).passed).toBe(false);
  });

  it("落ちたファイルだけを挙げる", () => {
    const report = {
      ...base,
      success: false,
      numFailedTests: 1,
      testResults: [
        { name: "a.test.ts", status: "passed" },
        { name: "b.test.ts", status: "failed" },
      ],
    };
    expect(toOutcome(report).failedFiles).toEqual(["b.test.ts"]);
  });

  // 既定を空配列にしないと、testResults の無い出力で中身のある配列が返る。
  it("testResults が無ければ空", () => {
    expect(toOutcome(base).failedFiles).toEqual([]);
  });
});
