import { describe, expect, it } from "vitest";
import { countErrors, parseLintOutput } from "./lint.ts";

describe("parseLintOutput", () => {
  it("eslint の JSON を数に直す", () => {
    const stdout = JSON.stringify([{ filePath: "/repo/src/a.ts", errorCount: 2 }]);
    expect(parseLintOutput(stdout, "/repo")).toEqual({ scanned: 1, counts: { "src/a.ts": 2 } });
  });

  // scope が言うのは「見たファイル数」。エラーのあった数だと、綺麗なリポジトリで
  // 「対象 0」になり、何も見ていないのと区別できない（hono の 309 ファイル 0 エラーで実測）。
  it("エラー 0 のファイルも scanned に数える", () => {
    const stdout = JSON.stringify([
      { filePath: "/repo/src/a.ts", errorCount: 0 },
      { filePath: "/repo/src/b.ts", errorCount: 0 },
    ]);
    expect(parseLintOutput(stdout, "/repo")).toEqual({ scanned: 2, counts: {} });
  });

  // 出力が読めないまま 0 件として通すと、lint が実質無効になっても緑になる。
  it.each([
    ["空", ""],
    ["JSON でない", "Error: cannot find config"],
  ])("%s なら落ちる", (_label, stdout) => {
    expect(() => parseLintOutput(stdout, "/repo")).toThrow(/eslint の出力を読めません/);
  });

  it("落ちるときに出力を添える", () => {
    expect(() => parseLintOutput("Oops: no config", "/repo")).toThrow(/Oops: no config/);
  });

  // 出力を丸ごと載せると、巨大なスタックトレースで本当の原因が埋もれる。
  it("添える出力を切り詰める", () => {
    const huge = `x${"y".repeat(2000)}`;
    expect(() => parseLintOutput(huge, "/repo")).toThrow(/y{499}$/);
  });
});

const ROOT = "/repo";

describe("countErrors", () => {
  it("ファイルごとにエラー数を返す", () => {
    expect(
      countErrors(
        [
          { filePath: "/repo/src/a.ts", errorCount: 3 },
          { filePath: "/repo/src/b.ts", errorCount: 1 },
        ],
        ROOT,
      ),
    ).toEqual({ "src/a.ts": 3, "src/b.ts": 1 });
  });

  // warning は「直すかどうかを書き手が決める」印として設定されている。
  // ゲートに混ぜると設定の意図を壊す。
  it("エラーが 0 のファイルは載せない", () => {
    expect(countErrors([{ filePath: "/repo/src/clean.ts", errorCount: 0 }], ROOT)).toEqual({});
  });

  it("パスをリポジトリ相対に直す", () => {
    expect(Object.keys(countErrors([{ filePath: "/repo/deep/nest/c.ts", errorCount: 1 }], ROOT))).toEqual([
      "deep/nest/c.ts",
    ]);
  });

  // 区切りを揃えないと、Windows と macOS で baseline のキーが食い違う。
  it("区切りを / に揃える", () => {
    expect(Object.keys(countErrors([{ filePath: "/repo/src\\win\\d.ts", errorCount: 1 }], ROOT))).toEqual([
      "src/win/d.ts",
    ]);
  });

  it("何も無ければ空", () => {
    expect(countErrors([], ROOT)).toEqual({});
  });
});

describe("parseLintOutput の原因表示", () => {
  // 原因は標準エラーにしか出ないことがある。stdout だけ見せると空の報告になる。
  it("detail があればそちらを見せる", () => {
    expect(() => parseLintOutput("", "/repo", "No files matching the pattern")).toThrow(/No files matching/);
  });

  it("detail が空なら stdout を見せる", () => {
    expect(() => parseLintOutput("broken", "/repo", "")).toThrow(/broken/);
  });
});
