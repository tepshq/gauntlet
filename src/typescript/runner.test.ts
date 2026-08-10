import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunnerError,
  coverageInstallCommand,
  installedVitestVersion,
  requireCoverageProvider,
  toOutcome,
  vitestArgs,
} from "./runner.ts";

/** node_modules の一部を作る。gauntlet は「実際に入っている版」を読むので実物が要る。 */
function withModules(body: (root: string) => void, modules: Record<string, string> = {}): void {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-runner-"));
  try {
    for (const [name, version] of Object.entries(modules)) {
      mkdirSync(join(root, "node_modules", name), { recursive: true });
      writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("coverageInstallCommand", () => {
  // coverage-v8 は vitest の完全一致を peer に要求する（peer vitest@"3.2.7"）。
  // 版無しで入れると最新が来て ERESOLVE で install ごと失敗する（実測）。
  it("入っている vitest の版に固定する", () => {
    expect(coverageInstallCommand("pnpm", "3.2.7")).toBe("pnpm add -D @vitest/coverage-v8@3.2.7");
  });

  it("PM に合わせた動詞を使う", () => {
    expect(coverageInstallCommand("npm", "4.1.10")).toBe("npm i -D @vitest/coverage-v8@4.1.10");
  });

  // vitest が読めないなら版を騙らない。嘘の版を書いたコマンドを渡すより無指定の方がまし。
  it("版が読めなければ固定しない", () => {
    expect(coverageInstallCommand("pnpm", null)).toBe("pnpm add -D @vitest/coverage-v8");
  });
});

describe("installedVitestVersion", () => {
  // package.json の指定（^3.2.4）ではなく解決後の実物（3.2.7）が要る。
  it("node_modules の実物を読む", () => {
    withModules((root) => expect(installedVitestVersion(root)).toBe("3.2.7"), { vitest: "3.2.7" });
  });

  it("入っていなければ null", () => {
    withModules((root) => expect(installedVitestVersion(root)).toBe(null));
  });
});

describe("requireCoverageProvider", () => {
  it("入っていれば通す", () => {
    withModules((root) => expect(() => requireCoverageProvider(root)).not.toThrow(), {
      "@vitest/coverage-v8": "3.2.7",
    });
  });

  // 無いまま走らせると vitest の「MISSING DEPENDENCY」が下位ツールの生エラーとして出る。
  // 原因と直し方を先に言う。
  it("無ければ版込みのコマンドを添えて落とす", () => {
    withModules(
      (root) => expect(() => requireCoverageProvider(root)).toThrow(/@vitest\/coverage-v8@3\.2\.7$/),
      { vitest: "3.2.7" },
    );
  });

  it("落ちるときは RunnerError", () => {
    withModules((root) => expect(() => requireCoverageProvider(root)).toThrow(RunnerError));
  });
});

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
  it("宣言が無ければ全部走らせる", () => {
    expect(vitestArgs(null, "/tmp/out", [])).toEqual([
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

  // 宣言は正の選択。宣言に無い project は gauntlet の世界に存在しない。
  it("宣言された project だけを走らせる", () => {
    expect(vitestArgs(null, "/tmp/out", ["node", "dom"])).toEqual([
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      "--project=node",
      "--project=dom",
      "--coverage.reportsDirectory=/tmp/out/coverage",
      "--reporter=json",
      "--outputFile=/tmp/out/result.json",
    ]);
  });

  it("turn は差分に絞る", () => {
    expect(vitestArgs("abc123", "/tmp/out", ["node"])).toEqual([
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      "--project=node",
      "--changed=abc123",
      "--coverage.reportsDirectory=/tmp/out/coverage",
      "--reporter=json",
      "--outputFile=/tmp/out/result.json",
    ]);
  });

  // 位置引数がフラグの前に来ると vitest が読み取れない。
  // 選択が 0 件になる組み合わせ（全部宣言外の project 等）に特別なフラグは要らない —
  // 呼び出し元（mutationScope）は coverage しか読まず、coverage は空に潰れる。
  it("指定したテストファイルだけに絞る", () => {
    expect(vitestArgs(null, "/tmp/out", [], ["a.test.ts", "b.test.ts"])).toEqual([
      "vitest",
      "run",
      "--coverage",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      "--coverage.reportsDirectory=/tmp/out/coverage",
      "--reporter=json",
      "--outputFile=/tmp/out/result.json",
      "a.test.ts",
      "b.test.ts",
    ]);
  });

  it("ファイル指定が無ければ位置引数を足さない", () => {
    expect(vitestArgs(null, "/tmp/out", [])).toEqual(vitestArgs(null, "/tmp/out", [], []));
  });
});

describe("toOutcome", () => {
  const base = { success: true, numTotalTests: 10, numFailedTests: 0 };
  const ROOT = "/repo";

  it("通っていれば passed", () => {
    expect(toOutcome(base, ROOT)).toEqual({ passed: true, total: 10, failed: 0, failures: [] });
  });

  // success と numFailedTests のどちらかが異常なら通さない。
  it.each([
    ["success が false", { ...base, success: false }],
    ["失敗件数がある", { ...base, numFailedTests: 2 }],
  ])("%s なら passed にしない", (_label, report) => {
    expect(toOutcome(report, ROOT).passed).toBe(false);
  });

  // ファイル名だけだと、読み手は理由を知るためにテストをもう一周回すしかない。
  // テスト名と失敗の本文まで揃って初めて、出力だけで直せる。
  it("落ちたテストを名前と理由つきで挙げる", () => {
    const report = {
      ...base,
      success: false,
      numFailedTests: 1,
      testResults: [
        { name: "/repo/a.test.ts", status: "passed", assertionResults: [{ fullName: "a > ok", status: "passed" }] },
        {
          name: "/repo/b.test.ts",
          status: "failed",
          assertionResults: [
            { fullName: "b > ok", status: "passed" },
            { fullName: "b > 落ちる", status: "failed", failureMessages: ["expected 1 to be 2"] },
          ],
        },
      ],
    };
    expect(toOutcome(report, ROOT).failures).toEqual([
      { file: "b.test.ts", test: "b > 落ちる", message: "expected 1 to be 2" },
    ]);
  });

  // vitest は絶対パスで報告する。差分や baseline と同じリポジトリ相対に揃える。
  it("相対パスの報告はそのまま使う", () => {
    const report = {
      ...base,
      success: false,
      testResults: [{ name: "b.test.ts", status: "failed", assertionResults: [] }],
    };
    expect(toOutcome(report, ROOT).failures[0]!.file).toBe("b.test.ts");
  });

  // 区切りを揃えないと、Windows と macOS で違反の場所が別のファイルに見える。
  it("区切りを / に揃える", () => {
    const report = {
      ...base,
      success: false,
      testResults: [{ name: "/repo/src\\win\\a.test.ts", status: "failed", assertionResults: [] }],
    };
    expect(toOutcome(report, ROOT).failures[0]!.file).toBe("src/win/a.test.ts");
  });

  // 落ちた assert が無いのに failed なのは、ファイル自体が落ちた形（import エラー等）。
  // そのときの本文はファイル側の message にしか無い。
  it("ファイル自体が落ちたら、その本文を失敗として返す", () => {
    const report = {
      ...base,
      success: false,
      testResults: [
        { name: "/repo/broken.test.ts", status: "failed", message: "Cannot find module './x'", assertionResults: [] },
      ],
    };
    expect(toOutcome(report, ROOT).failures).toEqual([
      { file: "broken.test.ts", test: null, message: "Cannot find module './x'" },
    ]);
  });

  it("ファイル自体の失敗に本文が無ければ空文字", () => {
    const report = { ...base, success: false, testResults: [{ name: "/repo/x.test.ts", status: "failed" }] };
    expect(toOutcome(report, ROOT).failures).toEqual([{ file: "x.test.ts", test: null, message: "" }]);
  });

  // 名前や本文が欠けた JSON でも undefined を漏らさない。表示側が形を当てにする。
  it("assert の失敗に名前と本文が無ければ null と空文字", () => {
    const report = {
      ...base,
      success: false,
      testResults: [{ name: "/repo/y.test.ts", status: "failed", assertionResults: [{ status: "failed" }] }],
    };
    expect(toOutcome(report, ROOT).failures).toEqual([{ file: "y.test.ts", test: null, message: "" }]);
  });

  // 既定を空配列にしないと、testResults の無い出力で中身のある配列が返る。
  it("testResults が無ければ空", () => {
    expect(toOutcome(base, ROOT).failures).toEqual([]);
  });
});
