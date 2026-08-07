import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBaseline, saveBaseline } from "./baseline.ts";
import { ConfigError } from "./config.ts";
import { REPORT_SCHEMA_VERSION, type AdapterReport, type FunctionReport } from "./report.ts";
import { applyRatchet, BASELINE_NOT_COMMITTED, countByFile, isTestFile, mutationScope, CRAP_NEEDS_TESTS, crapCheckViolations, crapViolations, formatResult, mutationTargets, parseTier, testsCheck, typecheckViolations, DEFAULT_TYPECHECK } from "./run.ts";
import type { CheckResult, TierResult } from "./tier.ts";

describe("parseTier", () => {
  it.each([
    ["--tier=turn", "turn"],
    ["--tier=pr", "pr"],
  ] as const)("%s を読む", (arg, expected) => {
    expect(parseTier([arg])).toBe(expected);
  });

  // 他の引数に紛れていても拾えないと、`gauntlet run --tier=turn` が動かない。
  it("tier 以外の引数は読み飛ばす", () => {
    expect(parseTier(["run", "--tier=pr"])).toBe("pr");
  });

  // 「無い」と「知らない値」を同じ扱いにすると、原因の違う 2 つが同じ文言になる。
  it.each([
    ["指定が無い", []],
    ["値が空", ["--tier="]],
  ])("%s なら「必要です」と落ちる", (_label, argv) => {
    expect(() => parseTier(argv)).toThrow(/--tier が必要です（turn \| pr）/);
  });

  it("未対応の tier なら「未対応」と落ちる", () => {
    expect(() => parseTier(["--tier=commit"])).toThrow(/--tier=commit は未対応です（turn \| pr）/);
  });

  it("落ちるときは ConfigError", () => {
    expect(() => parseTier([])).toThrow(ConfigError);
  });
});

function check(name: CheckResult["name"], status: CheckResult["status"], message?: string): CheckResult {
  return {
    name,
    status,
    durationMs: 12,
    violations: message === undefined ? [] : [{ message }],
  };
}

function result(checks: CheckResult[]): TierResult {
  return { tier: "turn", status: "fail", checks, durationMs: 34 };
}

describe("applyRatchet", () => {
  // CRAP 8 の意味: 網羅率 0 なら CC 2 まで。CC 5 で網羅率 0 は必ず違反。
  function violating(count: number, root: string): AdapterReport {
    const functions: FunctionReport[] = Array.from({ length: count }, (_, index) => ({
      location: { file: "a.ts", name: "f", scope: [], startLine: index + 1, startColumn: 0, endLine: index + 1, endColumn: 0 },
      cc: 5,
      coverage: 0,
    }));
    return { schemaVersion: REPORT_SCHEMA_VERSION, adapter: { name: "typescript", version: "0" }, root, functions, excluded: [] };
  }

  function withRoot(body: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-ratchet-"));
    try {
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 種を置くのは通すためではない。CI だけで回すとコンテナに書かれて捨てられ、
  // 毎回いまの状態が許容値になる。落として、コミットさせる。
  it("記録が無ければ種を置いて落とす", () => {
    withRoot((root) => {
      expect(applyRatchet(violating(3, root))).toEqual([BASELINE_NOT_COMMITTED]);
      expect(loadBaseline(root)).toEqual({ crap: 3, mutation: {}, lint: {} });
    });
  });

  // 落としてもファイルを残さないと、コミットするものが無くて詰む。
  it("落とした回のファイルは残す", () => {
    withRoot((root) => {
      applyRatchet(violating(3, root));
      expect(applyRatchet(violating(3, root))).toEqual([]);
    });
  });

  // 文言はエージェントへのフィードバックそのもの。理由が落ちると
  // 「コミットしろと言われたから baseline を触る」だけが伝わる。
  it("コミットを促す文言を丸ごと固定する", () => {
    expect(BASELINE_NOT_COMMITTED).toEqual({
      message:
        "gauntlet.baseline.json を作りました。コミットしてください。" +
        "履歴に無いと毎回いまの状態が許容値として置き直され、ラチェットが噛みません",
    });
  });

  // ファイルに書き出す時点で全ゲート分の枠が無いと、次のゲートが記録を失う。
  it("種を置くとき全ゲート分の枠を書く", () => {
    withRoot((root) => {
      applyRatchet(violating(1, root));
      const written = JSON.parse(readFileSync(join(root, "gauntlet.baseline.json"), "utf8")) as object;
      expect(Object.keys(written).sort()).toEqual(["crap", "lint", "mutation"]);
    });
  });

  it("増えていたら落とし、記録は変えない", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 1, mutation: {}, lint: {} });
      expect(applyRatchet(violating(4, root))[0]!.message).toContain("1 → 4");
      expect(loadBaseline(root)).toEqual({ crap: 1, mutation: {}, lint: {} });
    });
  });

  // 記録し損ねると許容値が緩いまま残り、後で同じだけ悪化させても通る。
  it("減っていたら通し、記録を下げる", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 5, mutation: {}, lint: {} });
      expect(applyRatchet(violating(2, root))).toEqual([]);
      expect(loadBaseline(root)).toEqual({ crap: 2, mutation: {}, lint: {} });
    });
  });

  it("同じなら通し、記録も変わらない", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 2, mutation: {}, lint: {} });
      expect(applyRatchet(violating(2, root))).toEqual([]);
      expect(loadBaseline(root)).toEqual({ crap: 2, mutation: {}, lint: {} });
    });
  });
});

describe("countByFile", () => {
  it("ファイルごとに数える", () => {
    expect(countByFile([{ file: "a.ts" }, { file: "b.ts" }, { file: "a.ts" }])).toEqual({ "a.ts": 2, "b.ts": 1 });
  });

  // 生き残りが 0 のファイルは記録側で 0 として扱う。ここには現れない。
  it("何も無ければ空", () => {
    expect(countByFile([])).toEqual({});
  });

  it("1 件なら 1", () => {
    expect(countByFile([{ file: "a.ts" }])).toEqual({ "a.ts": 1 });
  });
});

describe("isTestFile", () => {
  it.each(["a.test.ts", "a.test.tsx", "a.spec.ts", "a.spec.tsx", "a.integration.test.ts"])(
    "%s はテスト",
    (file) => {
      expect(isTestFile(file)).toBe(true);
    },
  );

  // ここを取りこぼすとテストファイル自身を変異させ、それを守るテストは無いので必ず生き残る。
  // 末尾で判定しないと、スナップショットや sourcemap の隣接ファイルまで拾う。
  it.each(["a.ts", "a.tsx", "testing.ts", "spec.ts", "a.test.md", "a.test.ts.snap"])(
    "%s はテストではない",
    (file) => {
      expect(isTestFile(file)).toBe(false);
    },
  );
});

describe("mutationScope", () => {
  const never = (): string[] => {
    throw new Error("呼ばれてはいけない");
  };

  // 変更されたテストが無ければ、覆っているソースを調べる実行そのものが要らない。
  // ここで余分に走らせると、設定ファイルだけの差分でも全テストが走る。
  it("変更されたテストが無ければ調べに行かない", () => {
    expect(mutationScope(["a.ts", "package.json"], never)).toEqual(["a.ts", "package.json"]);
  });

  it("何も変わっていなければ空", () => {
    expect(mutationScope([], never)).toEqual([]);
  });

  // assert を消しただけの差分でも、そのテストが覆うソースが対象に入らないと素通りできる。
  it("変更されたテストが覆うソースを足す", () => {
    expect(mutationScope(["a.test.ts"], () => ["a.ts", "b.ts"])).toEqual(["a.test.ts", "a.ts", "b.ts"]);
  });

  it("調べに行くのは変更されたテストだけ", () => {
    const asked: string[][] = [];
    mutationScope(["a.ts", "b.test.ts"], (tests) => {
      asked.push(tests);
      return [];
    });
    expect(asked).toEqual([["b.test.ts"]]);
  });

  it("重複は畳む", () => {
    expect(mutationScope(["a.ts", "a.test.ts"], () => ["a.ts"])).toEqual(["a.ts", "a.test.ts"]);
  });
});

describe("mutationTargets", () => {
  it("TypeScript のソースだけを選ぶ", () => {
    expect(mutationTargets(["a.ts", "b.md", "c.json", "d.tsx"], [])).toEqual(["a.ts"]);
  });

  it("順序を固定する", () => {
    expect(mutationTargets(["b.ts", "a.ts"], [])).toEqual(["a.ts", "b.ts"]);
  });

  // テストファイルを変異させても、それを守るテストは無い。
  it("テストファイルを外す", () => {
    expect(mutationTargets(["a.ts", "a.test.ts"], [])).toEqual(["a.ts"]);
  });

  it("除外指定を外す", () => {
    expect(mutationTargets(["a.ts", "b.ts"], ["b.ts"])).toEqual(["a.ts"]);
  });

  it("何も無ければ空", () => {
    expect(mutationTargets([], [])).toEqual([]);
  });
});

describe("testsCheck", () => {
  const green = { passed: true, failed: 0, total: 5, failedFiles: [] };

  it("通っていれば pass", () => {
    expect(testsCheck(green, 100)).toEqual({ name: "tests", status: "pass", durationMs: 100, violations: [] });
  });

  it("落ちていれば fail にして件数と失敗ファイルを出す", () => {
    const red = { passed: false, failed: 2, total: 5, failedFiles: ["a.test.ts", "b.test.ts"] };
    expect(testsCheck(red, 100)).toEqual({
      name: "tests",
      status: "fail",
      durationMs: 100,
      violations: [{ message: "2 / 5 件が失敗: a.test.ts, b.test.ts" }],
    });
  });

  // 実行はチェックの評価より前に済んでいるので、外から渡さないと 0ms と嘘をつく。
  it("渡された所要時間をそのまま持つ", () => {
    expect(testsCheck(green, 632).durationMs).toBe(632);
  });
});

describe("formatResult", () => {
  // 出力そのものがエージェントへのフィードバックなので、体裁ごと固定する。
  // 部分一致で見ると、改行やインデントが崩れても気づかない。
  it("落ちたチェックとその理由を出す", () => {
    expect(formatResult(result([check("crap", "fail", "CRAP 30.0  a.ts:10 f")]))).toBe(
      ["gauntlet turn: fail (34ms)", "  ✗ crap (12ms)", "    CRAP 30.0  a.ts:10 f"].join("\n"),
    );
  });

  it("通ったチェックも出す", () => {
    expect(formatResult(result([check("typecheck", "pass")]))).toBe(
      ["gauntlet turn: fail (34ms)", "  ✓ typecheck (12ms)"].join("\n"),
    );
  });

  it("チェックを 1 行ずつ並べる", () => {
    const output = formatResult(result([check("typecheck", "pass"), check("tests", "pass")]));
    expect(output.split("\n")).toHaveLength(3);
  });

  // 違反が 1 件しか無いと、連結のしかたが間違っていても表に出ない。
  it("違反が複数あれば 1 行ずつ並べる", () => {
    const many: CheckResult = {
      name: "crap",
      status: "fail",
      durationMs: 12,
      violations: [{ message: "一つ目" }, { message: "二つ目" }],
    };
    expect(formatResult(result([many]))).toBe(
      ["gauntlet turn: fail (34ms)", "  ✗ crap (12ms)", "    一つ目", "    二つ目"].join("\n"),
    );
  });
});

describe("typecheckViolations", () => {
  it("診断が無ければ通す", () => {
    expect(typecheckViolations({ stdout: "", combined: "" })).toEqual([]);
  });

  // 既定は tsc。プロジェクトが上書きしなければこれが走る。
  it("既定の型チェックコマンド", () => {
    expect(DEFAULT_TYPECHECK).toBe("tsc --noEmit");
  });

  // 前後の空白を落とさないと、報告に無駄な改行が混ざる。
  it("報告から前後の空白を落とす", () => {
    expect(typecheckViolations({ stdout: "x", combined: "\n  a.ts(1,1): error  \n" })).toEqual([
      { message: "a.ts(1,1): error" },
    ]);
  });

  it("空白だけなら通す", () => {
    expect(typecheckViolations({ stdout: "\n  \n", combined: "" })).toEqual([]);
  });

  // 原因が標準エラーにしか出ないこともあるので、報告には combined を使う。
  it("診断があれば combined を出す", () => {
    const result = { stdout: "a.ts(1,1): error TS1005", combined: "a.ts(1,1): error TS1005\nextra" };
    expect(typecheckViolations(result)).toEqual([{ message: "a.ts(1,1): error TS1005\nextra" }]);
  });
});

describe("crapViolations", () => {
  const root = "/repo";
  const bad: FunctionReport = {
    location: { file: "a.ts", name: "f", scope: [], startLine: 10, startColumn: 0, endLine: 20, endColumn: 0 },
    cc: 5,
    coverage: 0,
  };
  const report: AdapterReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    adapter: { name: "typescript", version: "0" },
    root,
    functions: [bad],
    excluded: [],
  };
  const touched = new Map([["a.ts", new Set([15])]]);

  it("触った関数の違反を出す", () => {
    expect(crapViolations("turn", report, touched)[0]!.message).toContain("CRAP 30.0");
  });

  // turn は差分に関係するテストしか走らせないので、全体の数字は当てにならない。
  it("turn ではリポジトリ全体を見ない", () => {
    expect(crapViolations("turn", report, touched)).toHaveLength(1);
  });

  it("触っていなければ turn では何も出ない", () => {
    expect(crapViolations("turn", report, new Map())).toEqual([]);
  });

  // pr はフル実行なのでリポジトリ全体のラチェットも当てる。
  // turn と同じ扱いにすると、全体の悪化が誰にも止められなくなる。
  it("pr ではリポジトリ全体のラチェットも当てる", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-crap-"));
    try {
      saveBaseline(root, { crap: 0, mutation: {}, lint: {} });
      const scoped = { ...report, root };
      const messages = crapViolations("pr", scoped, new Map()).map((v) => v.message);
      expect(messages).toEqual(["リポジトリ全体の違反が 0 → 1 に増えました"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 本当の原因はテストなので、そう言う。偽の CRAP 違反で埋もれさせない。
  it("テストが落ちているときの文言", () => {
    expect(CRAP_NEEDS_TESTS).toEqual({ message: "テストが落ちているため計測できません" });
  });
});

describe("crapCheckViolations", () => {
  const root = "/repo";
  const good: FunctionReport = {
    location: { file: "a.ts", name: "f", scope: [], startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
    cc: 1,
    coverage: 1,
  };
  const report: AdapterReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    adapter: { name: "typescript", version: "0" },
    root,
    functions: [good],
    excluded: [],
  };
  const empty: AdapterReport = { ...report, functions: [] };
  const green = { passed: true, total: 10 };

  it("測れていて違反が無ければ通す", () => {
    expect(crapCheckViolations("turn", report, new Map(), green)).toEqual([]);
  });

  // テストが落ちていれば coverage が無い。偽の違反で本当の原因を埋もれさせない。
  it("テストが落ちていればそう言う", () => {
    expect(crapCheckViolations("turn", report, new Map(), { passed: false, total: 10 })).toEqual([CRAP_NEEDS_TESTS]);
  });

  // 設定が現実とずれていると「違反ゼロ」に見える。走らなかったゲートを緑にしない。
  it("対象が空なら閾値を当てずに落とす", () => {
    const violations = crapCheckViolations("turn", empty, new Map(), green);
    expect(violations[0]!.message).toContain("source.include");
  });

  it("テスト失敗の方が設定のずれより先に出る", () => {
    expect(crapCheckViolations("turn", empty, new Map(), { passed: false, total: 10 })).toEqual([CRAP_NEEDS_TESTS]);
  });

  // 測れていることを確かめたら、次は閾値を当てる。ここを飛ばすと
  // 「測定は健全」を確認した見返りが何も無くなる。
  it("測れているなら閾値の違反を出す", () => {
    const violating: FunctionReport = { ...good, location: { ...good.location, name: "g" }, cc: 5, coverage: 0 };
    // good（網羅率 1）が居るので「どの関数も覆われていない」には当たらない。
    const mixed: AdapterReport = { ...report, functions: [good, violating] };
    const violations = crapCheckViolations("turn", mixed, new Map([["a.ts", new Set([1])]]), green);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("CRAP 30.0");
  });

  // 設定のずれを見つけたら、閾値の判定はしない。
  // 両方出すと、原因（設定）が結果（大量の違反）に埋もれる。
  it("設定のずれがあれば閾値の違反は出さない", () => {
    const violating: FunctionReport = { ...good, cc: 5, coverage: 0 };
    const broken: AdapterReport = { ...report, functions: [violating] };
    const violations = crapCheckViolations("turn", broken, new Map([["a.ts", new Set([1])]]), green);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("coverage.include");
  });
});
