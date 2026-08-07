import { describe, expect, it } from "vitest";
import { REPORT_PATH, type MutationReport, ignoredCount, strykerArgs, survivedFrom } from "./mutation.ts";
import { lastLines } from "./runner.ts";

// レポートが出ていないときは Stryker の出力が唯一の手がかりになる。
// 全部出すと埋もれるので末尾だけ。
describe("lastLines", () => {
  it("末尾から指定した行数だけ返す", () => {
    expect(lastLines("a\nb\nc\nd", 2)).toBe("c\nd");
  });

  it("行数が足りなければ全部返す", () => {
    expect(lastLines("a\nb", 5)).toBe("a\nb");
  });

  it("空なら空", () => {
    expect(lastLines("", 3)).toBe("");
  });

  // 前後の空白を落とさないと、報告の頭に空行が並ぶ。
  it("前後の空白を落とす", () => {
    expect(lastLines("\n  a  \n\n", 5)).toBe("a");
  });
});

// Stryker の json reporter は CLI から出力先を変えられないので、既定値に結合している。
// Stryker 側が変えたらここが最初に壊れる。
describe("REPORT_PATH", () => {
  it("Stryker の既定の出力先を指す", () => {
    expect(REPORT_PATH).toBe("reports/mutation/mutation.json");
  });
});

function report(entries: Record<string, [status: string, line: number][]>): MutationReport {
  return {
    files: Object.fromEntries(
      Object.entries(entries).map(([file, mutants]) => [
        file,
        {
          mutants: mutants.map(([status, line]) => ({
            mutatorName: "ConditionalExpression",
            status,
            location: { start: { line } },
          })),
        },
      ]),
    ),
  };
}

describe("survivedFrom", () => {
  it("生き残った変異を場所つきで返す", () => {
    expect(survivedFrom(report({ "a.ts": [["Survived", 12]] }))).toEqual([
      { file: "a.ts", line: 12, mutator: "ConditionalExpression" },
    ]);
  });

  it("倒された変異は返さない", () => {
    expect(survivedFrom(report({ "a.ts": [["Killed", 1], ["Timeout", 2]] }))).toEqual([]);
  });

  // 網羅率の話は CRAP が見ている。ここで二重に数えると同じ欠陥が 2 回報告される。
  it("NoCoverage は数えない", () => {
    expect(survivedFrom(report({ "a.ts": [["NoCoverage", 1]] }))).toEqual([]);
  });

  it("複数ファイルをまとめる", () => {
    const survived = survivedFrom(report({ "a.ts": [["Survived", 1]], "b.ts": [["Survived", 2]] }));
    expect(survived.map((mutant) => mutant.file)).toEqual(["a.ts", "b.ts"]);
  });

  it("変異が無ければ空", () => {
    expect(survivedFrom(report({}))).toEqual([]);
  });
});

describe("ignoredCount", () => {
  // --ignoreStatic で外した分。黙って落とすと、緑が「弱いテストが無い」ではなく
  // 「そこは見ていない」を意味していることが伝わらない。
  it("Ignored の数を返す", () => {
    expect(ignoredCount(report({ "a.ts": [["Ignored", 1], ["Ignored", 2], ["Killed", 3]] }))).toBe(2);
  });

  it("ファイルを跨いで合計する", () => {
    expect(ignoredCount(report({ "a.ts": [["Ignored", 1]], "b.ts": [["Ignored", 2]] }))).toBe(2);
  });

  it("無ければ 0", () => {
    expect(ignoredCount(report({ "a.ts": [["Killed", 1], ["Survived", 2]] }))).toBe(0);
  });

  it("何も無ければ 0", () => {
    expect(ignoredCount(report({}))).toBe(0);
  });
});

// 呼び出しは必ず it の中で行う。describe の直下で値を作ると、
// 変異が有効になる前に計算が終わっていて、テストが変異を検知できない。
describe("strykerArgs", () => {
  // 引数は丸ごと固定する。1 つ欠けると duct で踏んだ形（退避先をリポジトリ内に作り、
  // その中のテストを vitest が拾って coverage 解析が壊れる）に戻る。
  it("丸ごと固定する", () => {
    expect(strykerArgs(["a.ts", "b.ts"], "/tmp/out")).toEqual([
      "run",
      "--testRunner",
      "vitest",
      "--inPlace",
      "--tempDirName",
      "/tmp/out",
      "--ignoreStatic",
      "--reporters",
      "json",
      "--mutate",
      "a.ts,b.ts",
    ]);
  });

  // 退避先がリポジトリ内だと、対象リポジトリの vitest がコピーをテストとして拾う。
  it("退避先を渡す", () => {
    expect(strykerArgs([], "/elsewhere")).toContain("/elsewhere");
  });
});
