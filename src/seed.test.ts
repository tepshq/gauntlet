import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBaseline, saveBaseline } from "./baseline.ts";
import { RunnerError } from "./typescript/runner.ts";
import { parseSeedPattern, recordSeed, seedBaseline, refuseUnless, seedMessage, seedRefusal, seedScope, seedTargets } from "./seed.ts";

// #36: 変異対象は差分から決まるので clean な既定ブランチでは必ず 0。導入時に full を
// 回しても記録は空のままで、最初にそのファイルに触れた PR が自分の新コードの生き残りを
// 許容値にしてしまう。差分に依らず宣言した範囲を測る口。
describe("seedTargets", () => {
  const record = { survived: 1, measured: 10, timeout: 0, noCoverage: 0, unallowed: null };
  const inScope = ["lib/a.ts", "lib/b.ts", "app/c.ts"];
  const tested = new Set(["lib/a.ts", "lib/b.ts", "app/c.ts"]);

  it("範囲の中で、記録が無く、テストが触れるファイルを返す", () => {
    expect(seedTargets(["lib/a.ts", "lib/b.ts"], inScope, tested, {})).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  // **緩める経路を作らない。** 既存の記録を seed で上書きできると、赤いファイルを洗える。
  it("既に記録のあるファイルは測らない", () => {
    expect(seedTargets(["lib/a.ts", "lib/b.ts"], inScope, tested, { "lib/a.ts": record })).toEqual(["lib/b.ts"]);
  });

  // 分割して回せるのはこの性質のおかげ（同じコマンドを繰り返すと残りだけが進む）。
  it("全部記録済みなら空", () => {
    expect(seedTargets(["lib/a.ts"], inScope, tested, { "lib/a.ts": record })).toEqual([]);
  });

  // 測る対象の外を seed で測れると、範囲の宣言が意味を失う。
  it("測る対象の外は入れない", () => {
    expect(seedTargets(["docs/d.ts"], inScope, tested, {})).toEqual([]);
  });

  // テストが 1 つも触れないファイルは Stryker が「No tests were executed」で落ちる。
  it("テストが触れないファイルは入れない", () => {
    expect(seedTargets(["lib/a.ts"], inScope, new Set(), {})).toEqual([]);
  });

  it("重複を潰して並べ替える", () => {
    expect(seedTargets(["lib/b.ts", "lib/a.ts", "lib/b.ts"], inScope, tested, {})).toEqual(["lib/a.ts", "lib/b.ts"]);
  });
});

describe("seedRefusal", () => {
  const green = { passed: true, failures: [] };

  it("clean でテストが通っていれば置ける", () => {
    expect(seedRefusal(true, green)).toBeNull();
  });

  // 記録するのはコミット済みの状態の実測だけ（#23）。種置きも同じ。
  it("clean でなければ断る", () => {
    expect(seedRefusal(false, green)).toContain("作業ツリーが clean ではありません");
  });

  // テストが落ちていると coverage が無く、どのファイルが測れるかも決まらない。
  it("テストが落ちていれば、どのファイルかまで言って断る", () => {
    const red = { passed: false, failures: [{ file: "src/a.test.ts", test: "x", message: "" }] };
    expect(seedRefusal(true, red)).toContain("src/a.test.ts");
  });

  // clean でない かつ テストも赤い回は、先に clean を言う（コミットが先）。
  it("両方だめなら clean を先に言う", () => {
    const red = { passed: false, failures: [] };
    expect(seedRefusal(false, red)).toContain("作業ツリーが clean ではありません");
  });
});

describe("refuseUnless", () => {
  it("理由が無ければ何もしない", () => {
    expect(() => refuseUnless(null)).not.toThrow();
  });

  // 走れなかった回を緑にしない。
  it("理由があれば落とす", () => {
    expect(() => refuseUnless("だめ")).toThrow(RunnerError);
  });
});

describe("seedScope", () => {
  it("渡した範囲を include にする", () => {
    expect(seedScope("lib/**/*.ts", { include: ["src/**/*.ts"] })).toEqual({ include: ["lib/**/*.ts"] });
  });

  // seed だけ広い範囲を測れると、宣言した範囲の外に穴が開く。
  it("除外は設定のものを引き継ぐ", () => {
    expect(seedScope("lib/**/*.ts", { include: ["src/**/*.ts"], exclude: ["**/gen/**"] })).toEqual({
      include: ["lib/**/*.ts"],
      exclude: ["**/gen/**"],
    });
  });
});

describe("seedMessage", () => {
  it("置いた数と生き残りを言い、コミットを促す", () => {
    const records = {
      "lib/a.ts": { survived: 513, measured: 1243, timeout: 0, noCoverage: 0, unallowed: null },
      "lib/b.ts": { survived: 86, measured: 359, timeout: 0, noCoverage: 0, unallowed: null },
    };
    expect(seedMessage(records)).toBe(
      "mutation を記録しました（2 ファイル / 生き残り 599 件）。git add gauntlet.baseline.json でコミットしてください",
    );
  });

  // 0 件で黙ると、範囲の指定ミスと「もう全部ある」が区別できない。**理由と次の手まで
  // 全文で固定する** — 前半だけ見ていると、「なぜ 0 件か」の説明が消えても緑になる。
  it("0 件でも黙らず、理由と次の手を言う", () => {
    expect(seedMessage({})).toBe(
      "記録を置く対象がありませんでした（範囲の中のファイルは、既に記録があるか、" +
        "どのテストも触れていません）。範囲を広げるか、そのままで構いません",
    );
  });
});

describe("parseSeedPattern", () => {
  it("範囲を取り出す", () => {
    expect(parseSeedPattern(["seed", "--mutation=lib/**/*.ts"])).toBe("lib/**/*.ts");
  });

  // 既定を「測る対象すべて」にすると、780 ファイルの実行が事故で始まる。
  it.each([
    ["指定が無い", ["seed"]],
    ["空", ["seed", "--mutation="]],
    ["空白だけ", ["seed", "--mutation=  "]],
  ])("%s なら null", (_label, argv) => {
    expect(parseSeedPattern(argv)).toBeNull();
  });
});

// 記録の書き込みは Stryker 抜きで確かめられる（測るのは呼び出し側）。
// ここが壊れると、種置きが既存の記録を潰したり、測ったのに書かれなかったりする。
describe("recordSeed", () => {
  function withRoot(body: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-seed-"));
    try {
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const mutant = (file: string) => ({ file, line: 1, mutator: "X", replacement: null });
  const outcome = {
    survived: [mutant("a.ts"), mutant("a.ts")],
    noCoverage: [mutant("a.ts")],
    measured: { "a.ts": 20 },
    timeout: { "a.ts": 1 },
  };

  it("測った実測を記録に足す", () => {
    withRoot((root) => {
      recordSeed(root, { mutation: {} }, ["a.ts"], outcome);
      expect(loadBaseline(root)?.mutation).toEqual({
        "a.ts": { survived: 2, measured: 20, timeout: 1, noCoverage: 1, unallowed: 0 },
      });
    });
  });

  // 種置きが既存の記録を上書きできると、赤いファイルを seed で洗える。
  it("既にある記録は残す", () => {
    withRoot((root) => {
      const existing = { survived: 9, measured: 30, timeout: 0, noCoverage: 0, unallowed: null };
      saveBaseline(root, { crap: 5, mutation: { "a.ts": existing } });
      recordSeed(root, { crap: 5, mutation: { "a.ts": existing } }, ["a.ts"], outcome);
      expect(loadBaseline(root)?.mutation["a.ts"]).toEqual(existing);
    });
  });

  // 他のゲートの欄を種置きが作ると、測っていないゲートに 0 が入る（#28）。
  it("記録が無いリポジトリでも crap の欄は作らない", () => {
    withRoot((root) => {
      recordSeed(root, { mutation: {} }, ["a.ts"], outcome);
      expect(loadBaseline(root)).not.toHaveProperty("crap");
    });
  });

  it("置いた数を報告する", () => {
    withRoot((root) => {
      expect(recordSeed(root, { mutation: {} }, ["a.ts"], outcome)).toContain("1 ファイル / 生き残り 2 件");
    });
  });
});

describe("seedBaseline", () => {
  it("記録が無ければ mutation だけの空の記録", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-seedbase-"));
    try {
      expect(seedBaseline(root)).toEqual({ mutation: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("あればそれを読む", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-seedbase-"));
    try {
      saveBaseline(root, { crap: 7, mutation: {} });
      expect(seedBaseline(root).crap).toBe(7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
