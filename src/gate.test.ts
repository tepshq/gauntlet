import { describe, expect, it } from "vitest";
import { REPORT_SCHEMA_VERSION, type AdapterReport, type FunctionReport } from "./report.ts";
import { crapAdvice, crapText, deadIncludeText, gateRepository, gateTouched, measurementFaults, repositoryViolators, requiredCoverage } from "./gate.ts";
import { withinThreshold } from "./crap.ts";

function fn(file: string, startLine: number, endLine: number, cc: number, coverage: number): FunctionReport {
  return {
    location: { file, name: "f", scope: [], startLine, startColumn: 0, endLine, endColumn: 0 },
    cc,
    coverage,
  };
}

function reportOf(functions: FunctionReport[]): AdapterReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    adapter: { name: "typescript", version: "0" },
    root: "/repo",
    functions,
    excluded: [],
  };
}

// CRAP 8 の意味: 網羅率 0 なら CC 2 まで、100% なら CC 8 まで。
const BAD = fn("a.ts", 10, 20, 5, 0); // CRAP 30
const GOOD = fn("a.ts", 30, 40, 5, 1); // CRAP 5

describe("gateTouched", () => {
  it("触った関数の違反を出す", () => {
    const violations = gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([15])]]));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("CRAP 30.0");
    expect(violations[0]!.line).toBe(10);
  });

  // ファイル単位で見ると、1 行直しただけでそのファイルの全関数が対象になる。
  it("同じファイルでも触っていない関数は見ない", () => {
    expect(gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([35])]]))).toEqual([]);
  });

  it("触っていないファイルは見ない", () => {
    expect(gateTouched(reportOf([BAD]), new Map([["b.ts", new Set([15])]]))).toEqual([]);
  });

  it("閾値内なら触っていても通す", () => {
    expect(gateTouched(reportOf([GOOD]), new Map([["a.ts", new Set([35])]]))).toEqual([]);
  });

  it("関数の端の行も触ったとみなす", () => {
    for (const line of [10, 20]) {
      expect(gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([line])]]))).toHaveLength(1);
    }
  });

  it("違反の理由が読める", () => {
    const [violation] = gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([15])]]));
    expect(violation!.message).toBe("CRAP 30.0 (> 8)  複雑度 5 / 網羅率 0%  a.ts:10 f  → 網羅率 51% で通ります");
  });

  // 網羅率を百分率にし損ねると、0% 以外が全部おかしくなる。
  it("網羅率を百分率で出す", () => {
    const half = fn("a.ts", 10, 20, 5, 0.5);
    const [violation] = gateTouched(reportOf([half]), new Map([["a.ts", new Set([15])]]));
    expect(violation!.message).toContain("網羅率 50%");
  });

  // 閾値ちょうどは通す。hue には CRAP ぴったり 8 の関数が実在する。
  it.each([
    [8, 1, true],
    [9, 1, false],
  ])("CC %i / 網羅率 %d は通るか: %s", (cc, coverage, passes) => {
    const edge = fn("a.ts", 10, 20, cc, coverage);
    const violations = gateTouched(reportOf([edge]), new Map([["a.ts", new Set([15])]]));
    expect(violations).toHaveLength(passes ? 0 : 1);
  });

  // 行の範囲を無視すると、ファイルを触っただけで全関数が対象になる。
  it("関数の範囲の外の行では触ったとみなさない", () => {
    for (const line of [9, 21]) {
      expect(gateTouched(reportOf([BAD]), new Map([["a.ts", new Set([line])]]))).toEqual([]);
    }
  });
});

describe("crapText", () => {
  // gateTouched の違反にも pr のラチェット報告にも同じ形で載る。ずれると同じ違反が別物に見える。
  it("スコア・閾値・両方のレバー・場所・次の一手を一行に収める", () => {
    expect(crapText(BAD)).toBe("CRAP 30.0 (> 8)  複雑度 5 / 網羅率 0%  a.ts:10 f  → 網羅率 51% で通ります");
  });
});

// 網羅率 100% では CRAP = 複雑度 なので、閾値 8 は高複雑度側では複雑度の上限として働く。
// h3 では違反 35 件のうち 25 件が網羅率 90〜100% で、テストを足しても 1 件も減らない。
describe("requiredCoverage", () => {
  it.each([
    [3, 18],
    [4, 38],
    [5, 51],
    [6, 62],
    [7, 73],
    [8, 100],
  ])("複雑度 %i は網羅率 %i%%", (cc, percent) => {
    expect(requiredCoverage(cc)).toBe(percent);
  });

  // 言った数字で本当に通り、その 1% 下では通らないこと。丸め方を 1 段間違えると
  // 「言われたとおりにしたのに赤のまま」になる（複雑度 4 は 37% では通らない）。
  it.each([3, 4, 5, 6, 7, 8])("複雑度 %i: 言った網羅率が最小", (cc) => {
    const percent = requiredCoverage(cc)!;
    expect(withinThreshold(cc, percent / 100)).toBe(true);
    expect(withinThreshold(cc, (percent - 1) / 100)).toBe(false);
  });

  // 複雑度 1〜2 はどんな網羅率でも閾値を超えない。違反として現れない。
  it("閾値以下の複雑度は 0% でよい", () => {
    expect(requiredCoverage(2)).toBe(0);
  });

  it("複雑度 9 以上は通せない", () => {
    expect(requiredCoverage(9)).toBe(null);
    expect(requiredCoverage(31)).toBe(null);
  });
});

describe("crapAdvice", () => {
  it("通せるなら要る網羅率を言う", () => {
    expect(crapAdvice(5)).toBe("網羅率 51% で通ります");
  });

  // ここを「網羅率を上げてください」で済ませると、永遠に通らない作業に向かわせる。
  it("通せないなら割るように言う", () => {
    expect(crapAdvice(31)).toBe("複雑度 9 以上はテストでは通りません。関数を割ってください");
  });
});

describe("repositoryViolators", () => {
  // ラチェットはこの数を数え、後退の報告はこの一覧を名指しする。数と一覧の基準がずれてはいけない。
  it("閾値を超えた関数だけ返す", () => {
    expect(repositoryViolators(reportOf([BAD, GOOD]))).toEqual([BAD]);
  });

  it("違反が無ければ空", () => {
    expect(repositoryViolators(reportOf([GOOD]))).toEqual([]);
  });
});

describe("gateRepository", () => {
  it("違反数が許容値以下なら落とさない", () => {
    expect(gateRepository(reportOf([BAD, GOOD]), { crap: 1, mutation: {} })).toEqual({ kind: "ok" });
  });

  it("許容値を超えたら落とす", () => {
    expect(gateRepository(reportOf([BAD]), { crap: 0, mutation: {} })).toEqual({ kind: "regressed", allowed: 0, actual: 1 });
  });

  it("減っていたら改善として返す", () => {
    expect(gateRepository(reportOf([GOOD]), { crap: 3, mutation: {} })).toEqual({ kind: "improved", from: 3, to: 0 });
  });

  // 0 から始めると、既存リポジトリは導入した瞬間に赤で埋まって誰も入れられない。
  it("記録が無ければ今の実測値を種にする", () => {
    expect(gateRepository(reportOf([BAD, BAD, GOOD]), null)).toEqual({ kind: "seeded", to: 2 });
  });
});

describe("measurementFaults", () => {
  const covered: FunctionReport = fn("a.ts", 1, 5, 1, 1);
  const bare: FunctionReport = fn("a.ts", 1, 5, 1, 0);

  it("測れていれば何も言わない", () => {
    expect(measurementFaults(reportOf([covered]), 10, true)).toEqual([]);
  });

  // `src` は実在するので「実在しないパスを指している」は原因を取り違える。
  // h3 ではその案内どおり綴りとパスを疑って探すことになった。
  it("死んだ include は名指しして直し方を言う", () => {
    expect(measurementFaults(reportOf([]), 10, true, [{ pattern: "lib", fix: "lib/**/*.ts" }])).toEqual([
      {
        message:
          "gauntlet.config.json の source.include の `lib` は、測れるファイルを 1 つも掴んでいません。" +
          "`lib/**/*.ts` に直してください",
      },
    ]);
  });

  // 全体としては測れているので、ここを通すと範囲が黙って狭いまま緑になる。
  it("測れていても、死んだ include があれば 1 件ずつ落とす", () => {
    const dead = [
      { pattern: "src", fix: "src/**/*.ts" },
      { pattern: "lib", fix: null },
    ];
    expect(measurementFaults(reportOf([covered]), 10, true, dead).map((v) => v.message)).toEqual([
      deadIncludeText(dead[0]!),
      deadIncludeText(dead[1]!),
    ]);
  });
  // メッセージだけ読んで直せる必要がある。原因の場所を名指しする。
  it("対象が 1 つも無ければ、どこを見るべきか言う", () => {
    expect(measurementFaults(reportOf([]), 10, true)).toEqual([
      {
        message:
          "測る対象が 1 つもありません。gauntlet.config.json の source.include が" +
          "実在しないパスを指している可能性があります",
      },
    ]);
  });

  // 「テストが無いから 0%」と「coverage 設定が噛み合っていない」を区別できないまま
  // 全関数を違反にしてはいけない。件数を出すと、どちらか判断しやすい。
  it("テストが走ったのに誰も覆われていなければ、件数つきで落とす", () => {
    expect(measurementFaults(reportOf([bare, bare]), 3822, true)).toEqual([
      {
        message:
          "テストが 3822 件走ったのに、どの関数も覆われていません。" +
          "vitest の coverage.include が測る対象と噛み合っていない可能性があります",
      },
    ]);
  });

  it("テストが 0 件なら網羅率 0 でも咎めない", () => {
    expect(measurementFaults(reportOf([bare]), 0, true)).toEqual([]);
  });

  it("1 つでも覆われていれば咎めない", () => {
    expect(measurementFaults(reportOf([bare, covered]), 10, true)).toEqual([]);
  });

  // 部分実行（quick）では、vitest が coverage を変更ファイルだけに絞るので
  // 全員 0 が正常でありうる。hono では設定だけの差分で、h3 では新規の未テスト
  // ファイルを足した差分で踏んだ。この条件に識別力が無いので判定しない。
  it("部分実行では、全員 0 でも咎めない", () => {
    expect(measurementFaults(reportOf([bare, bare]), 4795, false)).toEqual([]);
  });

  it("部分実行でも、対象が空なのは設定の誤りとして言う", () => {
    expect(measurementFaults(reportOf([]), 10, false)).toHaveLength(1);
  });
});

describe("deadIncludeText", () => {
  // 直し方を決め打ちにすると（`src/**/*.ts` と言い切ると）、lib/ のリポジトリに
  // 当たらない助言になる。当てて確かめたものだけを言う。
  it("直し方が作れたら、そのまま置き換えられる形で言う", () => {
    expect(deadIncludeText({ pattern: "lib/", fix: "lib/**/*.ts" })).toBe(
      "gauntlet.config.json の source.include の `lib/` は、測れるファイルを 1 つも掴んでいません。" +
        "`lib/**/*.ts` に直してください",
    );
  });

  it("作れなければ、当たっている先を言う", () => {
    expect(deadIncludeText({ pattern: "dist/**/*.ts", fix: null })).toBe(
      "gauntlet.config.json の source.include の `dist/**/*.ts` は、測れるファイルを 1 つも掴んでいません" +
        "（gitignore された生成物などにだけ当たっています）",
    );
  });
});
