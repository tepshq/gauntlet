import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBaseline, saveBaseline } from "./baseline.ts";
import { ConfigError } from "./config.ts";
import { REPORT_SCHEMA_VERSION, type AdapterReport, type FunctionReport } from "./report.ts";
import { applyRatchet, BASELINE_NOT_COMMITTED, condenseFailure, countByFile, coveredFiles, duplicationViolations, isTestFile, mutationScope, CRAP_NEEDS_TESTS, crapCheckViolations, crapScope, crapViolations, failureReport, formatViolators, lacksReason, needsTestsMessage, scopeText, violatorReport, describeCrash, describeSurvivor, detailLines, formatResult, mutationScopeText, mutationTargets, oneLine, ratchetViolation, testViolation, testViolations, testsCheck, typecheckViolations, withDetails, DEFAULT_TYPECHECK } from "./run.ts";
import { RunnerError } from "./typescript/runner.ts";
import type { CheckResult, TierResult } from "./tier.ts";

function check(name: CheckResult["name"], status: CheckResult["status"], message?: string): CheckResult {
  return {
    name,
    status,
    durationMs: 12,
    violations: message === undefined ? [] : [{ message }],
    scope: "対象 1 件",
  };
}

function result(checks: CheckResult[]): TierResult {
  return { tier: "quick", status: "fail", checks, durationMs: 34 };
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
      expect(applyRatchet(violating(3, root), new Map())).toEqual([BASELINE_NOT_COMMITTED]);
      expect(loadBaseline(root)).toEqual({ crap: 3, mutation: {} });
    });
  });

  // 落としてもファイルを残さないと、コミットするものが無くて詰む。
  it("落とした回のファイルは残す", () => {
    withRoot((root) => {
      applyRatchet(violating(3, root), new Map());
      expect(applyRatchet(violating(3, root), new Map())).toEqual([]);
    });
  });

  // 文言はエージェントへのフィードバックそのもの。理由が落ちると
  // 「コミットしろと言われたから baseline を触る」だけが伝わる。
  // 手段（git add -A）まで言うのは、ファイル名を含む Bash を guard が
  // 止めるから — 名指しの git add は矛盾した 2 つの指示になる。
  it("コミットを促す文言を丸ごと固定する", () => {
    expect(BASELINE_NOT_COMMITTED).toEqual({
      message:
        "gauntlet.baseline.json を作りました。git add -A などでコミットしてください" +
        "（ファイル名を含む Bash コマンドは guard が止めます）。" +
        "履歴に無いと毎回いまの状態が許容値として置き直され、ラチェットが噛みません",
    });
  });

  // ファイルに書き出す時点で全ゲート分の枠が無いと、次のゲートが記録を失う。
  it("種を置くとき全ゲート分の枠を書く", () => {
    withRoot((root) => {
      applyRatchet(violating(1, root), new Map());
      const written = JSON.parse(readFileSync(join(root, "gauntlet.baseline.json"), "utf8")) as object;
      expect(Object.keys(written).sort()).toEqual(["crap", "mutation"]);
    });
  });

  it("増えていたら落とし、記録は変えない", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 1, mutation: {} });
      expect(applyRatchet(violating(4, root), new Map())[0]!.message).toContain("1 → 4");
      expect(loadBaseline(root)).toEqual({ crap: 1, mutation: {} });
    });
  });

  // 記録し損ねると許容値が緩いまま残り、後で同じだけ悪化させても通る。
  it("減っていたら通し、記録を下げる", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 5, mutation: {} });
      expect(applyRatchet(violating(2, root), new Map())).toEqual([]);
      expect(loadBaseline(root)).toEqual({ crap: 2, mutation: {} });
    });
  });

  it("同じなら通し、記録も変わらない", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 2, mutation: {} });
      expect(applyRatchet(violating(2, root), new Map())).toEqual([]);
      expect(loadBaseline(root)).toEqual({ crap: 2, mutation: {} });
    });
  });
});

describe("ratchetViolation", () => {
  const outcome = { allowed: 1, actual: 2 };
  const bad = (line: number): FunctionReport => ({
    location: { file: "a.ts", name: "f", scope: [], startLine: line, startColumn: 0, endLine: line, endColumn: 0 },
    cc: 5,
    coverage: 0,
  });
  const reportOf = (functions: FunctionReport[]): AdapterReport => ({
    schemaVersion: REPORT_SCHEMA_VERSION,
    adapter: { name: "typescript", version: "0" },
    root: "/repo",
    functions,
    excluded: [],
  });

  // 記録は数だけなので、どれが増えた分かは特定できない。それでも、テストを消して
  // 触っていない関数の網羅率が落ちた後退は、一覧が無いと手がかりがゼロになる。
  it("差分の外にある違反を名指しする", () => {
    expect(ratchetViolation(reportOf([bad(10)]), new Map(), outcome)).toEqual({
      message:
        "リポジトリ全体の違反が 1 → 2 に増えました。差分の外にある違反（増えた分と、以前から許容されている分）:\n" +
        "  CRAP 30.0 (> 8)  複雑度 5 / 網羅率 0%  a.ts:10 f  → 網羅率 51% で通ります",
    });
  });

  // 触った関数の違反は gateTouched が別に出している。二重に並べると同じ違反が 2 回見える。
  it("違反が全部差分の中なら、上の違反を指す", () => {
    expect(ratchetViolation(reportOf([bad(10)]), new Map([["a.ts", new Set([10])]]), outcome)).toEqual({
      message: "リポジトリ全体の違反が 1 → 2 に増えました。増えた分は上の触った関数の違反です",
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
  // 差分には設定ファイルも混ざる。vitest.config.ts を変異させても意味が無い。
  it("測る範囲の外は落とす", () => {
    expect(mutationTargets(["a.ts", "vitest.config.ts"], ["a.ts"])).toEqual(["a.ts"]);
  });

  it("測る範囲にあるものは残す", () => {
    expect(mutationTargets(["a.ts", "b.tsx"], ["a.ts", "b.tsx", "c.ts"])).toEqual(["a.ts", "b.tsx"]);
  });

  // 範囲側にしか無いファイルは、この差分に関係が無い。
  it("差分に出ていないものは足さない", () => {
    expect(mutationTargets(["a.ts"], ["a.ts", "b.ts"])).toEqual(["a.ts"]);
  });

  it("順序を固定する", () => {
    expect(mutationTargets(["b.ts", "a.ts"], ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
  });

  // テストファイルは source.exclude で範囲から外れる。init が既定で書く。
  it("測る範囲が空なら何も変異させない", () => {
    expect(mutationTargets(["a.ts", "a.test.ts"], [])).toEqual([]);
  });

  it("重複は畳む", () => {
    expect(mutationTargets(["a.ts", "a.ts"], ["a.ts"])).toEqual(["a.ts"]);
  });

  it("何も無ければ空", () => {
    expect(mutationTargets([], [])).toEqual([]);
  });
});

describe("testsCheck", () => {
  const green = { passed: true, failed: 0, total: 5, failures: [], output: "" };

  // 0 件で緑なら、テストが 1 つも選ばれていないということ。件数を出さないと区別できない。
  it("通っていれば pass、走った件数を添える", () => {
    expect(testsCheck(green, 100)).toEqual({
      name: "tests",
      status: "pass",
      durationMs: 100,
      violations: [],
      scope: "5 件",
    });
  });

  // ファイル名だけだと、読み手は理由を知るためにテストをもう一周回すしかない。
  it("落ちていれば fail にして、テストごとに理由を出す", () => {
    const red = {
      passed: false,
      failed: 2,
      total: 5,
      failures: [
        { file: "a.test.ts", test: "sum > 足せる", message: "expected 1 to be 2" },
        { file: "b.test.ts", test: null, message: "" },
      ],
      output: "",
    };
    expect(testsCheck(red, 100)).toEqual({
      name: "tests",
      status: "fail",
      durationMs: 100,
      violations: [
        { message: "2 / 5 件が失敗:" },
        { message: "sum > 足せる  a.test.ts\n  expected 1 to be 2", file: "a.test.ts" },
        {
          message: "(テストファイル自体が失敗)  b.test.ts\n  理由が出ていません。npx vitest run b.test.ts で確認してください",
          file: "b.test.ts",
        },
      ],
      scope: "5 件",
    });
  });

  // 実行はチェックの評価より前に済んでいるので、外から渡さないと 0ms と嘘をつく。
  it("渡された所要時間をそのまま持つ", () => {
    expect(testsCheck(green, 632).durationMs).toBe(632);
  });
});

describe("testViolations", () => {
  const failure = (n: number): { file: string; test: string; message: string } => ({
    file: `f${n}.test.ts`,
    test: `t${n}`,
    message: "",
  });

  // vitest が success: false だけ返す形（未処理エラー等）でも、無言で fail にしない。
  it("個別の失敗が取れなければ、確認の仕方を言う", () => {
    expect(testViolations({ failed: 0, total: 5, failures: [], output: "" })).toEqual([
      { message: "0 / 5 件が失敗: 詳細を取れませんでした。npx vitest run で確認してください" },
    ]);
  });

  // JSON 側は timeout の理由を STACK_TRACE_ERROR に差し替えることがある（h3 で実測）。
  // 空でないが手掛かりが 0 なので、人向けに印字された方から理由を取る。
  it("JSON に理由が無ければ、印字された理由を添える", () => {
    const printed = "⎯⎯ Failed Tests 1 ⎯⎯\n FAIL  test/a.test.ts > t\nError: Test timed out in 5000ms.\n    at x (y.ts:1:1)";
    const failures = [{ file: "test/a.test.ts", test: "t", message: "Error: STACK_TRACE_ERROR\n    at task (x.js:1:1)" }];
    const violations = testViolations({ failed: 1, total: 5, failures, output: printed });
    expect(violations.at(-1)!.message).toBe(
      "vitest が印字した理由:\n  Failed Tests 1 ⎯⎯\n   FAIL  test/a.test.ts > t\n  Error: Test timed out in 5000ms.",
    );
  });

  // 1 件でも理由が無ければ添える。全部揃っているときだけ省く。
  it("理由がある失敗に混ざっていても添える", () => {
    const failures = [
      { file: "a.test.ts", test: "t", message: "expected 1 to be 2" },
      { file: "b.test.ts", test: "u", message: "" },
    ];
    const violations = testViolations({ failed: 2, total: 5, failures, output: "⎯ Failed Tests 2 ⎯\n理由" });
    expect(violations.at(-1)!.message).toContain("vitest が印字した理由");
  });

  // 理由が読める普通の失敗で両方出すと、同じ内容が 2 回並ぶ。
  it("JSON に理由があれば添えない", () => {
    const failures = [{ file: "a.test.ts", test: "t", message: "expected 1 to be 2" }];
    const violations = testViolations({ failed: 1, total: 5, failures, output: "⎯⎯ Failed Tests 1 ⎯⎯\n中身" });
    expect(violations).toHaveLength(2);
  });

  // assert が 1 つも落ちずにファイルが落ちる形（import エラー、timeout）では
  // vitest の失敗数が 0 になる。そのまま出すと「何も落ちていない」に読める（h3 で実測）。
  it("失敗 0 件でファイルが落ちていれば、そう数え直す", () => {
    const violations = testViolations({ failed: 0, total: 1668, failures: [failure(1), failure(2)], output: "" });
    expect(violations[0]!.message).toBe("2 ファイルがテストを実行できませんでした（1668 件中の失敗は 0 件）:");
  });

  // 大規模なリファクタで 200 件落ちたとき、全部並べると本当の原因が量に埋もれる。
  it("11 件目からは件数に畳む", () => {
    const failures = Array.from({ length: 12 }, (_, index) => failure(index));
    const violations = testViolations({ failed: 12, total: 20, failures, output: "" });
    expect(violations).toHaveLength(12); // 見出し + 10 件 + 「他 2 件」
    expect(violations[0]!.message).toBe("12 / 20 件が失敗:");
    expect(violations.at(-1)!.message).toBe("…他 2 件の失敗");
  });

  it("上限までは畳まない", () => {
    const failures = Array.from({ length: 10 }, (_, index) => failure(index));
    expect(testViolations({ failed: 10, total: 10, failures, output: "" })).toHaveLength(11); // 見出し + 10 件
  });
});

describe("lacksReason", () => {
  it("空なら理由が無い", () => {
    expect(lacksReason("")).toBe(true);
  });

  // vitest は timeout の理由を内部の置き換え文字列にすることがある（h3 で実測）。
  it("置き換え文字列だけなら理由が無い", () => {
    expect(lacksReason("Error: STACK_TRACE_ERROR\n    at task (x.js:1:1)")).toBe(true);
  });

  // 1 行でも読める理由があれば、それを見せる方がよい。
  it("読める行が混ざっていれば理由がある", () => {
    expect(lacksReason("Error: STACK_TRACE_ERROR\nexpected 1 to be 2")).toBe(false);
  });

  it("普通の理由は理由がある", () => {
    expect(lacksReason("expected 1 to be 2")).toBe(false);
  });
});

describe("failureReport", () => {
  it("印字された失敗の節から先を取る", () => {
    expect(failureReport("前置き\n⎯ Failed Tests 1 ⎯\nFAIL a.test.ts")).toBe("Failed Tests 1 ⎯\nFAIL a.test.ts");
  });

  // 節が無い出力（vitest が起動すらしなかった等）で切り出すと、前置きを理由として見せてしまう。
  it("節が無ければ空", () => {
    expect(failureReport("何も落ちていない出力")).toBe("");
  });
});

describe("needsTestsMessage", () => {
  // `list` はこの 1 行で終わるので、ファイル名が無いと切り分けの起点が無い。
  it("落ちたファイルを並べる", () => {
    const failures = [
      { file: "a.test.ts", test: null, message: "" },
      { file: "b.test.ts", test: null, message: "" },
      { file: "a.test.ts", test: "t", message: "" },
    ];
    expect(needsTestsMessage(failures)).toBe("テストが落ちているため計測できません: a.test.ts、b.test.ts");
  });

  it("取れていなければ理由だけ言う", () => {
    expect(needsTestsMessage([])).toBe(CRAP_NEEDS_TESTS.message);
  });
});

describe("testViolation", () => {
  it("テスト名・ファイル・理由を出し、ファイルを違反の場所にする", () => {
    expect(testViolation({ file: "a.test.ts", test: "sum > 足せる", message: "expected 1 to be 2" })).toEqual({
      message: "sum > 足せる  a.test.ts\n  expected 1 to be 2",
      file: "a.test.ts",
    });
  });

  // vitest が本文を持たないことがある（h3 では並列負荷の timeout）。名前だけ出すと
  // 「落ちた」以外の情報がゼロになり、手で切り分ける以外になくなる。
  it("理由が無ければ、次に打つコマンドを出す", () => {
    expect(testViolation({ file: "a.test.ts", test: null, message: "" })).toEqual({
      message: "(テストファイル自体が失敗)  a.test.ts\n  理由が出ていません。npx vitest run a.test.ts で確認してください",
      file: "a.test.ts",
    });
  });

  it("テスト名が無ければファイル自体の失敗と言う", () => {
    expect(testViolation({ file: "a.test.ts", test: null, message: "boom" }).message).toBe(
      "(テストファイル自体が失敗)  a.test.ts\n  boom",
    );
  });
});

describe("condenseFailure", () => {
  // 理由（期待値と実際）を残せば、場所はテスト名で足りる。
  it("スタックトレースの行を削る", () => {
    const raw = "AssertionError: expected 1 to be 2\n    at file.ts:10:5\n    at run (x.ts:1:1)";
    expect(condenseFailure(raw, 10)).toBe("AssertionError: expected 1 to be 2");
  });

  // vitest は端末でない出力にも色コードを混ぜることがある。
  it("色コードを落とす", () => {
    expect(condenseFailure("\u001b[31mexpected\u001b[39m 1 to be 2", 10)).toBe("expected 1 to be 2");
  });

  it("末尾の空行を削る", () => {
    expect(condenseFailure("expected\n\n\n", 10)).toBe("expected");
  });

  // 行頭アンカーが無いと、本文中の「 at 」を含む行（期待値の説明など）まで消える。
  it("行の途中の at はスタックと見なさない", () => {
    expect(condenseFailure("expected item at index 3 to be 4", 10)).toBe("expected item at index 3 to be 4");
  });

  // trim しないと、空白だけの行が「空行ではない」扱いで末尾に残る。
  it("末尾の空白だけの行も削る", () => {
    expect(condenseFailure("expected\n   ", 10)).toBe("expected");
  });

  // assert の diff が長いときも、頭に理由が来る前提で先頭を残す。
  it("上限を超えた行は件数に畳む", () => {
    const raw = Array.from({ length: 5 }, (_, index) => `行${index}`).join("\n");
    expect(condenseFailure(raw, 3)).toBe("行0\n行1\n行2\n…他 2 件");
  });

  it("空なら空", () => {
    expect(condenseFailure("", 10)).toBe("");
  });
});

describe("detailLines", () => {
  it("上限以下ならそのまま", () => {
    expect(detailLines(["a", "b"], 3)).toEqual(["a", "b"]);
  });

  // 黙って切ると「これで全部」に読める。切った分は件数で言う。
  it("上限を超えた分は件数に畳む", () => {
    expect(detailLines(["a", "b", "c"], 2)).toEqual(["a", "b", "…他 1 件"]);
  });

  it("ちょうど上限なら畳まない", () => {
    expect(detailLines(["a", "b"], 2)).toEqual(["a", "b"]);
  });

  it("空なら空", () => {
    expect(detailLines([], 3)).toEqual([]);
  });
});

describe("withDetails", () => {
  // formatResult が全体を 4 字下げるので、ここは見出しからの相対で 2 字。
  it("見出しの下に 2 字下げでぶら下げる", () => {
    expect(withDetails("見出し", ["一つ目", "二つ目"])).toBe("見出し\n  一つ目\n  二つ目");
  });

  it("詳細が無ければ見出しだけ", () => {
    expect(withDetails("見出し", [])).toBe("見出し");
  });

  it("11 件目からは件数に畳む", () => {
    const items = Array.from({ length: 12 }, (_, index) => `i${index}`);
    const lines = withDetails("見出し", items).split("\n");
    expect(lines).toHaveLength(12); // 見出し + 10 件 + 「他 2 件」
    expect(lines.at(-1)).toBe("  …他 2 件");
  });
});

describe("mutationScopeText の除外表示", () => {
  // 黙って落とすと、緑が「弱いテストが無い」ではなく「そこは見ていない」を意味していることが
  // 伝わらない（--ignoreStatic の件数を出しているのと同じ理由）。
  it("外した mutator を並べる", () => {
    expect(mutationScopeText(3, 0, 0, ["StringLiteral"])).toBe(
      "変異対象 3 ファイル（StringLiteral の変異は Stryker が置けないので測っていません）",
    );
  });

  it("外していなければ何も足さない", () => {
    expect(mutationScopeText(3, 0, 0, [])).toBe("変異対象 3 ファイル");
  });

  it("複数なら並べる", () => {
    expect(mutationScopeText(3, 0, 0, ["A", "B"])).toContain("A、B の変異は");
  });
});

describe("oneLine", () => {
  it("複数行を空白 1 つで繋ぐ", () => {
    expect(oneLine("a\n  b\nc", 60)).toBe("a b c");
  });

  it("上限を超えたら切って印をつける", () => {
    expect(oneLine("abcdef", 3)).toBe("abc…");
  });

  it("上限ちょうどは切らない", () => {
    expect(oneLine("abc", 3)).toBe("abc");
  });
});

describe("describeSurvivor", () => {
  // 位置と種類と変異後のコードが揃えば、Stryker の再実行（分単位）なしで直せる。
  it("行・mutator・変異後のコードを一行に", () => {
    expect(describeSurvivor({ file: "a.ts", line: 47, mutator: "EqualityOperator", replacement: "<=" })).toBe(
      "L47 EqualityOperator  → <=",
    );
  });

  it("変異後のコードが無ければ行と mutator だけ", () => {
    expect(describeSurvivor({ file: "a.ts", line: 3, mutator: "BlockStatement", replacement: null })).toBe(
      "L3 BlockStatement",
    );
  });

  it("複数行の置換は 1 行に潰す", () => {
    expect(describeSurvivor({ file: "a.ts", line: 1, mutator: "M", replacement: "{\n}" })).toBe("L1 M  → { }");
  });
});

describe("describeCrash", () => {
  // 既知のエラー（設定・git・道具）はメッセージが説明そのもの。スタックは雑音になる。
  it("既知のエラーはメッセージだけ", () => {
    expect(describeCrash(new ConfigError("--tier が必要です"))).toBe("--tier が必要です");
    expect(describeCrash(new RunnerError("Stryker が入っていません"))).toBe("Stryker が入っていません");
  });

  // 未知のエラーは gauntlet 自身のバグ。メッセージだけだと読み手は直しようがない。
  it("未知のエラーは場所（スタック）ごと出す", () => {
    const described = describeCrash(new TypeError("x is not a function"));
    expect(described).toContain("TypeError: x is not a function");
    expect(described).toContain("at ");
  });

  it("Error でないものは文字列にする", () => {
    expect(describeCrash("boom")).toBe("boom");
  });
});

describe("formatResult", () => {
  // 出力そのものがエージェントへのフィードバックなので、体裁ごと固定する。
  // 部分一致で見ると、改行やインデントが崩れても気づかない。
  it("落ちたチェックとその理由を出す", () => {
    expect(formatResult(result([check("crap", "fail", "CRAP 30.0  a.ts:10 f")]))).toBe(
      ["gauntlet quick: fail (34ms)", "  ✗ crap (12ms)  対象 1 件", "    CRAP 30.0  a.ts:10 f"].join("\n"),
    );
  });

  // 「対象 0 件で緑」と「見て問題なし」は、違反が無いという結果だけでは区別できない。
  it("通ったチェックも、何を見たかを添えて出す", () => {
    const scoped: CheckResult = { ...check("mutation", "pass"), scope: "変異対象 0 ファイル" };
    expect(formatResult(result([scoped]))).toBe(
      ["gauntlet quick: fail (34ms)", "  ✓ mutation (12ms)  変異対象 0 ファイル"].join("\n"),
    );
  });

  // scope も複数行になりうる（マッチ 0 件の include）。段に入れないとチェックの木から外れる。
  it("複数行の scope も段に入れる", () => {
    const scoped: CheckResult = { ...check("crap", "pass"), scope: "触った関数 0 / 測る対象 5 関数\n続き" };
    expect(formatResult(result([scoped]))).toBe(
      ["gauntlet quick: fail (34ms)", "  ✓ crap (12ms)  触った関数 0 / 測る対象 5 関数", "    続き"].join("\n"),
    );
  });

  it("チェックを 1 行ずつ並べる", () => {
    const output = formatResult(result([check("typecheck", "pass"), check("tests", "pass")]));
    expect(output.split("\n")).toHaveLength(3);
  });

  // 違反が 1 件しか無いと、連結のしかたが間違っていても表に出ない。
  it("違反が複数あれば 1 行ずつ並べる", () => {
    const many: CheckResult = { ...check("crap", "fail"), violations: [{ message: "一つ目" }, { message: "二つ目" }] };
    expect(formatResult(result([many]))).toBe(
      ["gauntlet quick: fail (34ms)", "  ✗ crap (12ms)  対象 1 件", "    一つ目", "    二つ目"].join("\n"),
    );
  });

  // tsc の診断や詳細つきの違反は複数行になる。先頭行しか下げないと、
  // 2 行目以降がチェックの木から外れて見える。
  it("複数行の違反は全行を段に入れる", () => {
    const multiline: CheckResult = { ...check("tests", "fail"), violations: [{ message: "見出し\n  詳細" }] };
    expect(formatResult(result([multiline]))).toBe(
      ["gauntlet quick: fail (34ms)", "  ✗ tests (12ms)  対象 1 件", "    見出し", "      詳細"].join("\n"),
    );
  });
});

describe("crapScope", () => {
  function report(count: number): AdapterReport {
    const functions: FunctionReport[] = Array.from({ length: count }, (_, index) => ({
      location: { file: "a.ts", name: "f", scope: [], startLine: index + 1, startColumn: 0, endLine: index + 1, endColumn: 0 },
      cc: 1,
      coverage: 1,
    }));
    return { schemaVersion: REPORT_SCHEMA_VERSION, adapter: { name: "typescript", version: "0" }, root: "/repo", functions, excluded: [] };
  }

  it("触った数と測る対象の数を出す", () => {
    expect(crapScope(report(5), new Map([["a.ts", new Set([2, 3])]]))).toBe("触った関数 2 / 測る対象 5 関数（1 ファイル）");
  });

  // ここが 0 / 0 なら、緑は「良い」ではなく「何も測っていない」を意味する。
  it("触っていなければ 0 と出す", () => {
    expect(crapScope(report(5), new Map())).toBe("触った関数 0 / 測る対象 5 関数（1 ファイル）");
  });

  it("測る対象が無ければ両方 0", () => {
    expect(crapScope(report(0), new Map())).toBe("触った関数 0 / 測る対象 0 関数（0 ファイル）");
  });

  // 落とさないが黙らない。綴りを 1 文字誤った include は、他が生きていれば
  // 緑のまま半分が測られない状態を作る（h3 で実測）。
  it("1 件もマッチしない include を続けて言う", () => {
    expect(crapScope(report(5), new Map(), ["testt/**/*.ts", "libb"])).toBe(
      "触った関数 0 / 測る対象 5 関数（1 ファイル）\n" +
        "source.include の `testt/**/*.ts`、`libb` は 1 件もマッチしていません（意図した書き方なら無視してください）",
    );
  });
});

// 範囲を決めるとき人間が数えるのはファイル。関数の数だけでは突き合わせられない（h3 で実測）。
describe("scopeText", () => {
  function reportOfFiles(files: readonly string[], excluded: readonly string[]): AdapterReport {
    const functions: FunctionReport[] = files.map((file) => ({
      location: { file, name: "f", scope: [], startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
      cc: 1,
      coverage: 1,
    }));
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      adapter: { name: "typescript", version: "0" },
      root: "/repo",
      functions,
      excluded: excluded.map((file) => ({ file, reason: "関数がありません" })),
    };
  }

  it("同じファイルの関数は 1 ファイルと数える", () => {
    expect(scopeText(reportOfFiles(["a.ts", "a.ts", "b.ts"], []))).toBe("3 関数（2 ファイル）");
  });

  // 関数が無くて外したファイルも glob は掴んでいる。落とすと数え上げと合わなくなる。
  it("関数が無いファイルも数に入れる", () => {
    expect(scopeText(reportOfFiles(["a.ts"], ["types.ts", "const.ts"]))).toBe("1 関数（3 ファイル）");
  });
});

// ratchet は数しか記録しないので、`{ "crap": 35 }` から「どの 35 件か」に辿れなかった
// （h3 の導入報告）。赤を減らす作業に取りかかるための出力。
describe("formatViolators", () => {
  const violator = (cc: number, line: number): FunctionReport => ({
    location: { file: "a.ts", name: "f", scope: [], startLine: line, startColumn: 0, endLine: line, endColumn: 0 },
    cc,
    coverage: 0,
  });

  it("件数と範囲と許容値を見出しに置く", () => {
    expect(formatViolators([violator(5, 1)], "411 関数（50 ファイル）", 35)).toBe(
      "CRAP 違反 1 件 / 測る対象 411 関数（50 ファイル）（gauntlet.baseline.json の許容 35）\n" +
        "  CRAP 30.0 (> 8)  複雑度 5 / 網羅率 0%  a.ts:1 f  → 網羅率 51% で通ります",
    );
  });

  // 導入前でも走らせられる。数字が無いのに「許容 0」と出すと嘘になる。
  it("baseline がまだ無ければそう言う", () => {
    expect(formatViolators([], "1 関数（1 ファイル）", null)).toBe(
      "CRAP 違反 0 件 / 測る対象 1 関数（1 ファイル）（gauntlet.baseline.json はまだありません）",
    );
  });

  // 手を付ける順番がそのまま出る。
  it("悪い順に並べる", () => {
    const listed = formatViolators([violator(3, 1), violator(9, 2), violator(5, 3)], "x", 3);
    expect(listed.split("\n").slice(1).map((line) => line.trim().split(" ")[1])).toEqual(["90.0", "30.0", "12.0"]);
  });

  // 10 件で切ると baseline の数と合わなくなり、何のための一覧か分からなくなる。
  it("件数を切らない", () => {
    const many = Array.from({ length: 12 }, (_, index) => violator(5, index + 1));
    expect(formatViolators(many, "x", 12).split("\n")).toHaveLength(13);
  });
});

describe("violatorReport", () => {
  const reportOf = (functions: FunctionReport[]): AdapterReport => ({
    schemaVersion: REPORT_SCHEMA_VERSION,
    adapter: { name: "typescript", version: "0" },
    root: "/repo",
    functions,
    excluded: [],
  });
  const violator: FunctionReport = {
    location: { file: "a.ts", name: "f", scope: [], startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
    cc: 5,
    coverage: 0,
  };
  // 覆われた関数を 1 つ混ぜる。全員 0% だと「測れていない」の方に当たる。
  const covered: FunctionReport = { ...violator, cc: 1, coverage: 1 };
  const green = { passed: true, total: 10, failures: [] };

  it("違反を数えて並べる", () => {
    expect(violatorReport(reportOf([violator, covered]), green, 1)).toContain("CRAP 違反 1 件");
  });

  // テストが落ちていると coverage が無く、全関数が網羅率 0 に見える。
  // その一覧を出すと、直す相手を丸ごと取り違える。
  it("テストが落ちていれば一覧を出さない", () => {
    const red = { passed: false, total: 10, failures: [] };
    expect(() => violatorReport(reportOf([violator, covered]), red, 1)).toThrow(RunnerError);
    expect(() => violatorReport(reportOf([violator, covered]), red, 1)).toThrow(CRAP_NEEDS_TESTS.message);
  });

  // `list` の出力はこの 1 行で終わる。ファイル名が無いと切り分けの起点が無い（h3 が指摘）。
  it("落ちたファイルを名指しする", () => {
    const red = { passed: false, total: 10, failures: [{ file: "test/a.test.ts", test: null, message: "" }] };
    expect(() => violatorReport(reportOf([violator, covered]), red, 1)).toThrow(
      `${CRAP_NEEDS_TESTS.message}: test/a.test.ts`,
    );
  });

  it("測れていなければ一覧を出さない", () => {
    expect(() => violatorReport(reportOf([]), green, 1)).toThrow(/source.include/);
  });

  // list は必ずフル実行なので、全関数 0% は配線が壊れている合図。
  // ここを部分実行扱いにすると、全員 0% の一覧を「これが違反です」と出してしまう。
  it("全関数が 0% なら一覧を出さない", () => {
    expect(() => violatorReport(reportOf([violator]), green, 1)).toThrow(/coverage.include/);
  });
});

describe("typecheckViolations", () => {
  it("診断が無ければ通す", () => {
    expect(typecheckViolations({ stdout: "", combined: "", code: 0 })).toEqual([]);
  });

  // 既定は tsc。プロジェクトが上書きしなければこれが走る。
  // --incremental はキャッシュで速くするだけで診断は変えない。pr は CI で
  // 毎回コールドに走るので、緑の意味も変わらない（duct 実測 8.5s → 1.9s）。
  it("既定の型チェックコマンド", () => {
    expect(DEFAULT_TYPECHECK).toBe("tsc --noEmit --incremental");
  });

  // 前後の空白を落とさないと、報告に無駄な改行が混ざる。
  it("報告から前後の空白を落とす", () => {
    expect(typecheckViolations({ stdout: "x", combined: "\n  a.ts(1,1): error  \n", code: 0 })).toEqual([
      { message: "a.ts(1,1): error" },
    ]);
  });

  it("空白だけなら通す", () => {
    expect(typecheckViolations({ stdout: "\n  \n", combined: "", code: 0 })).toEqual([]);
  });

  // 原因が標準エラーにしか出ないこともあるので、報告には combined を使う。
  it("診断があれば combined を出す", () => {
    const result = { stdout: "a.ts(1,1): error TS1005", combined: "a.ts(1,1): error TS1005\nextra", code: 2 };
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
    expect(crapViolations("quick", report, touched)[0]!.message).toContain("CRAP 30.0");
  });

  // quick は差分に関係するテストしか走らせないので、全体の数字は当てにならない。
  it("quick ではリポジトリ全体を見ない", () => {
    expect(crapViolations("quick", report, touched)).toHaveLength(1);
  });

  it("触っていなければ quick では何も出ない", () => {
    expect(crapViolations("quick", report, new Map())).toEqual([]);
  });

  // full はフル実行なのでリポジトリ全体のラチェットも当てる。
  // turn と同じ扱いにすると、全体の悪化が誰にも止められなくなる。
  it("full ではリポジトリ全体のラチェットも当てる", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-crap-"));
    try {
      saveBaseline(root, { crap: 0, mutation: {} });
      const scoped = { ...report, root };
      const messages = crapViolations("full", scoped, new Map()).map((v) => v.message);
      expect(messages).toEqual([
        "リポジトリ全体の違反が 0 → 1 に増えました。差分の外にある違反（増えた分と、以前から許容されている分）:\n" +
          "  CRAP 30.0 (> 8)  複雑度 5 / 網羅率 0%  a.ts:10 f  → 網羅率 51% で通ります",
      ]);
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
    expect(crapCheckViolations("quick", report, new Map(), green)).toEqual([]);
  });

  // テストが落ちていれば coverage が無い。偽の違反で本当の原因を埋もれさせない。
  it("テストが落ちていればそう言う", () => {
    expect(crapCheckViolations("quick", report, new Map(), { passed: false, total: 10 })).toEqual([CRAP_NEEDS_TESTS]);
  });

  // 設定が現実とずれていると「違反ゼロ」に見える。走らなかったゲートを緑にしない。
  it("対象が空なら閾値を当てずに落とす", () => {
    const violations = crapCheckViolations("quick", empty, new Map(), green);
    expect(violations[0]!.message).toContain("source.include");
  });

  it("テスト失敗の方が設定のずれより先に出る", () => {
    expect(crapCheckViolations("quick", empty, new Map(), { passed: false, total: 10 })).toEqual([CRAP_NEEDS_TESTS]);
  });

  // 測れていることを確かめたら、次は閾値を当てる。ここを飛ばすと
  // 「測定は健全」を確認した見返りが何も無くなる。
  it("測れているなら閾値の違反を出す", () => {
    const violating: FunctionReport = { ...good, location: { ...good.location, name: "g" }, cc: 5, coverage: 0 };
    // good（網羅率 1）が居るので「どの関数も覆われていない」には当たらない。
    const mixed: AdapterReport = { ...report, functions: [good, violating] };
    const violations = crapCheckViolations("quick", mixed, new Map([["a.ts", new Set([1])]]), green);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("CRAP 30.0");
  });

  // 設定のずれを見つけたら、閾値の判定はしない。
  // 両方出すと、原因（設定）が結果（大量の違反）に埋もれる。
  it("設定のずれがあれば閾値の違反は出さない", () => {
    const violating: FunctionReport = { ...good, cc: 5, coverage: 0 };
    const broken: AdapterReport = { ...report, functions: [violating] };
    const violations = crapCheckViolations("full", broken, new Map([["a.ts", new Set([1])]]), green);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("coverage.include");
  });

  // vitest は `--changed` のとき coverage を変更ファイルだけに絞るので、quick で
  // 全関数 0% は「変更したファイルにテストが届いていない」だけのことがある。
  // h3 では新規の未テストファイルを 1 つ足した差分がこれに当たり、正しい CRAP 違反が
  // 「設定のずれ」に化けて関数名もスコアも消えていた。
  it("quick では coverage が空でも設定のずれと言わない", () => {
    const violating: FunctionReport = { ...good, cc: 5, coverage: 0 };
    const untested: AdapterReport = { ...report, functions: [violating] };
    const violations = crapCheckViolations("quick", untested, new Map([["a.ts", new Set([1])]]), green);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("CRAP 30.0");
  });

  // 触った関数が 0 の quick も同じ扱い。hono（4795 テスト）で誤検知して落ちた形。
  it("quick で触った関数が 0 なら、coverage が空でも通す", () => {
    const untouched: AdapterReport = { ...report, functions: [{ ...good, coverage: 0 }] };
    expect(crapCheckViolations("quick", untouched, new Map(), { passed: true, total: 4795 })).toEqual([]);
  });

  // full はフル実行なので、触った関数が 0 でも coverage が空なのは設定のずれ。
  it("full では触った関数が 0 でも coverage の空を咎める", () => {
    const untouched: AdapterReport = { ...report, functions: [{ ...good, coverage: 0 }] };
    const violations = crapCheckViolations("full", untouched, new Map(), { passed: true, total: 4795 });
    expect(violations[0]!.message).toContain("coverage.include");
  });
});

describe("duplicationViolations", () => {
  function withRoot(body: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-dup-"));
    try {
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 0.11.0 より前の baseline にはこの欄が無い。種を置いた回は通さない（crap と同じ）。
  it("欄が無ければ種を置いて落とす", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 5, mutation: {} });
      expect(duplicationViolations(root, 1090)).toEqual([BASELINE_NOT_COMMITTED]);
      expect(loadBaseline(root)).toEqual({ crap: 5, mutation: {}, duplication: 1090 });
    });
  });

  // baseline ファイル自体が無いリポジトリでも落ちずに種を置く。
  it("記録ファイルそのものが無くても種を置いて落とす", () => {
    withRoot((root) => {
      expect(duplicationViolations(root, 42)).toEqual([BASELINE_NOT_COMMITTED]);
      expect(loadBaseline(root)?.duplication).toBe(42);
    });
  });

  it("増えていたら落とし、記録は変えない", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 0, mutation: {}, duplication: 100 });
      expect(duplicationViolations(root, 150)).toEqual([
        { message: "重複が 100 → 150 トークンに増えました" },
      ]);
      expect(loadBaseline(root)?.duplication).toBe(100);
    });
  });

  // 記録し損ねると許容値が緩いまま残り、後で同じだけコピペしても通る。
  it("減っていたら通し、記録を下げる", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 0, mutation: {}, duplication: 100 });
      expect(duplicationViolations(root, 60)).toEqual([]);
      expect(loadBaseline(root)?.duplication).toBe(60);
    });
  });

  it("同じなら通し、記録も変わらない", () => {
    withRoot((root) => {
      saveBaseline(root, { crap: 0, mutation: {}, duplication: 100 });
      expect(duplicationViolations(root, 100)).toEqual([]);
      expect(loadBaseline(root)?.duplication).toBe(100);
    });
  });
});

describe("coveredFiles", () => {
  const entry = (counts: Record<string, number>) => ({ statementMap: {}, s: counts });

  // vitest は coverage.include に合致する未ロードのファイルもゼロ行で載せる。
  // キーの存在で判定すると、mutation の範囲が include の全ファイルに膨張する（実測）。
  it("1 文も実行されていないファイルは触れられていない", () => {
    expect(coveredFiles("/repo", { "/repo/src/main.ts": entry({ "0": 0, "1": 0 }) })).toEqual([]);
  });

  it("1 文でも実行されたファイルをリポジトリ相対で返す", () => {
    expect(
      coveredFiles("/repo", {
        "/repo/src/run.ts": entry({ "0": 3, "1": 0 }),
        "/repo/src/dead.ts": entry({ "0": 0 }),
      }),
    ).toEqual(["src/run.ts"]);
  });

  // Windows の区切りが混ざったキーも POSIX に揃える。
  it("バックスラッシュ区切りを直す", () => {
    expect(coveredFiles("/repo", { "/repo/src\\win\\a.ts": entry({ "0": 1 }) })).toEqual(["src/win/a.ts"]);
  });
});

describe("mutationScopeText", () => {
  it("対象のファイル数を出す", () => {
    expect(mutationScopeText(3, 0)).toBe("変異対象 3 ファイル");
  });

  // 測らなかった分を黙って落とすと、緑が「弱いテストが無い」ではなく
  // 「そこは見ていない」を意味していることが伝わらない。
  it("測らなかった件数があれば添える", () => {
    expect(mutationScopeText(3, 10)).toBe("変異対象 3 ファイル（静的な変異 10 件は測っていません）");
  });

  // テストが触れないファイルは変異させても全部 NoCoverage（数えない）な上、
  // Stryker が「No tests were executed」で落ちる。外すが、外した数は言う。
  it("テストが触れないファイルを外した数を添える", () => {
    expect(mutationScopeText(0, 0, 1)).toBe(
      "変異対象 0 ファイル（テストが触れない 1 ファイルは対象外 — 網羅率 0 は CRAP が見る）",
    );
  });

  it("外した数と静的変異は並ぶ", () => {
    expect(mutationScopeText(2, 5, 1)).toBe(
      "変異対象 2 ファイル（テストが触れない 1 ファイルは対象外 — 網羅率 0 は CRAP が見る）（静的な変異 5 件は測っていません）",
    );
  });

  it("対象が無くても形は同じ", () => {
    expect(mutationScopeText(0, 0)).toBe("変異対象 0 ファイル");
  });
});
