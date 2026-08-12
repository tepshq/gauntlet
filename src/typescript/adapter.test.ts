import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GauntletConfig } from "../config.ts";
import { analyze, isTestFile, listSourceFiles, reviewIncludes, toPosix, unmeasuredFiles } from "./adapter.ts";

/**
 * git 管理下の小さなリポジトリ。`src/alpha.ts` / `src/utils/beta.ts` / `src/zeta.ts`。
 *
 * ディレクトリを跨ぐ 3 つにしてあるのは、glob の出力順と辞書順がずれるため —
 * 並べ替えを落としても気づける形にする。
 */
function withRepo(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-include-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src", "utils"), { recursive: true });
    writeFileSync(join(root, "src", "alpha.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "utils", "beta.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "src", "zeta.ts"), "export const z = 3;\n");
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Windows の区切りのまま照合すると、coverage のキーと突き合わない。
describe("toPosix", () => {
  it("区切りを / に揃える", () => {
    expect(toPosix("src\\utils\\b.ts")).toBe("src/utils/b.ts");
  });

  it("もともと / なら変えない", () => {
    expect(toPosix("src/utils/b.ts")).toBe("src/utils/b.ts");
  });
});

// `--include=src` は glob として成立してしまう（ディレクトリ自身にマッチする）ので、
// 綴りの誤りと同じ「対象 0」になりながら原因は正反対。h3 で実際に踏んだ形を再現する。
describe("reviewIncludes", () => {
  it("ディレクトリ名だけの include を返す", () => {
    withRepo((root) => {
      expect(reviewIncludes(root, { include: ["src"] }).dead).toEqual([{ pattern: "src", fix: "src/**/*.ts" }]);
    });
  });

  // 末尾の `/` と途中の `/` を取り違えると、直し方が `srcutils/` のような形になって
  // 「言われたとおりに直したのに直らない」になる。
  it("末尾の / だけを落として直し方を作る", () => {
    withRepo((root) => {
      expect(reviewIncludes(root, { include: ["src/utils/"] }).dead).toEqual([
        { pattern: "src/utils/", fix: "src/utils/**/*.ts" },
      ]);
    });
  });

  it.each(["src/**/*.ts", "src/**", "src/*.ts"])("ソースに届く %s は返さない", (pattern) => {
    withRepo((root) => {
      expect(reviewIncludes(root, { include: [pattern] })).toEqual({ dead: [], unmatched: [] });
    });
  });

  // 落とさないが黙らない。落とすと「最後の .tsx を消したら赤」になるが、
  // 綴りを 1 文字誤った include も同じ形をしていて、黙ると半分が測られないまま緑になる。
  it("1 つもマッチしない include は落とさず、名前だけ返す", () => {
    withRepo((root) => {
      expect(reviewIncludes(root, { include: ["src/**/*.tsx"] })).toEqual({
        dead: [],
        unmatched: ["src/**/*.tsx"],
      });
    });
  });

  // h3 の実測: src は生きているので全体は緑、testt は黙って抜け落ちていた。
  it("生きている include に混ざった綴り誤りも返す", () => {
    withRepo((root) => {
      expect(reviewIncludes(root, { include: ["src/**/*.ts", "testt/**/*.ts"] })).toEqual({
        dead: [],
        unmatched: ["testt/**/*.ts"],
      });
    });
  });

  // 全体としては測れているので、ここを見逃すと範囲が黙って狭いまま緑になる。
  it("生きている include に混ざっていても見つける", () => {
    withRepo((root) => {
      expect(reviewIncludes(root, { include: ["src/**/*.ts", "src"] }).dead).toEqual([{ pattern: "src", fix: "src/**/*.ts" }]);
    });
  });

  // gitignore された生成物にしか当たらない include も、測る対象を連れてこない。
  it("リポジトリが所有しないものにしか当たらなければ返す", () => {
    withRepo((root) => {
      writeFileSync(join(root, ".gitignore"), "dist/\n");
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "generated.ts"), "export const c = 3;\n");
      expect(reviewIncludes(root, { include: ["dist/**/*.ts"] }).dead).toEqual([{ pattern: "dist/**/*.ts", fix: null }]);
    });
  });
});

// gauntlet は --coverage.include に自分の宣言を渡すので、対象は未テストでも
// ゼロ行の項目として載る。それでも現れないのは、リポジトリ側の coverage.exclude が
// 消しているときだけ（CLI からは上書きできない。h3 で実測）。
describe("unmeasuredFiles", () => {
  const entry = { statementMap: {}, s: {}, f: {} };

  it("coverage に現れない対象を返す", () => {
    withRepo((root) => {
      const coverage = { [join(root, "src/alpha.ts")]: entry, [join(root, "src/zeta.ts")]: entry };
      expect(unmeasuredFiles(root, { include: ["src/**/*.ts"] }, coverage)).toEqual(["src/utils/beta.ts"]);
    });
  });

  // 実行されていないだけのファイルは coverage に載る。ここで返すと、
  // ただの網羅率 0% を「測れていない」と誤診する。
  it("載っていれば、実行されていなくても返さない", () => {
    withRepo((root) => {
      const coverage = {
        [join(root, "src/alpha.ts")]: entry,
        [join(root, "src/utils/beta.ts")]: entry,
        [join(root, "src/zeta.ts")]: entry,
      };
      expect(unmeasuredFiles(root, { include: ["src/**/*.ts"] }, coverage)).toEqual([]);
    });
  });

  it("測る対象の外は見ない", () => {
    withRepo((root) => {
      expect(unmeasuredFiles(root, { include: ["src/alpha.ts"] }, { [join(root, "src/alpha.ts")]: entry })).toEqual([]);
    });
  });
});

describe("listSourceFiles", () => {
  it("include に合致するものを並べる", () => {
    withRepo((root) => {
      expect(listSourceFiles(root, { include: ["src/**/*.ts"] })).toEqual([
        "src/alpha.ts",
        "src/utils/beta.ts",
        "src/zeta.ts",
      ]);
    });
  });

  // exclude を効かせ損ねると、テストファイル自身が測る対象に入る。
  it("exclude を落とす", () => {
    withRepo((root) => {
      expect(listSourceFiles(root, { include: ["src/**/*.ts"], exclude: ["src/utils/**"] })).toEqual([
        "src/alpha.ts",
        "src/zeta.ts",
      ]);
    });
  });

  // glob（ディスク）だけで決めると gitignore された生成物が混入する。
  // duct では Prisma の生成クライアント 61 ファイルが lib/** に合致していた。
  it("リポジトリが所有しないファイルは落とす", () => {
    withRepo((root) => {
      writeFileSync(join(root, ".gitignore"), "src/generated.ts\n");
      writeFileSync(join(root, "src", "generated.ts"), "export const g = 1;\n");
      expect(listSourceFiles(root, { include: ["src/**/*.ts"] })).toEqual([
        "src/alpha.ts",
        "src/utils/beta.ts",
        "src/zeta.ts",
      ]);
    });
  });
});

/**
 * `analyze` の入口。ソース（ディスク）と coverage（絶対パスのキー）を突き合わせて
 * 関数単位の報告にするところまでを、実ファイルを置いて通す。
 */
function withFunctionRepo(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-analyze-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "src"), { recursive: true });
    // 2 文とも関数の内側に来る形にする（1 行目の宣言は関数のものではない）。
    writeFileSync(join(root, "src", "add.ts"), "export function add(a: number, b: number): number {\n  const sum = a + b;\n  return sum;\n}\n");
    writeFileSync(join(root, "src", "bare.ts"), "export const answer = 42;\n");
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const config: GauntletConfig = {
  schemaVersion: 1,
  adapter: "typescript",
  runner: "vitest",
  defaultBranch: "main",
  source: { include: ["src/**/*.ts"] },
};

describe("analyze", () => {
  it("関数を cc と網羅率つきで並べる", () => {
    withFunctionRepo((root) => {
      // 2 文のうち 1 文だけ実行された = 0.5。回数（`f`）ではなく文の被覆で数える。
      const coverage = {
        [join(root, "src/add.ts")]: {
          statementMap: { "0": { start: { line: 2, column: 2 } }, "1": { start: { line: 3, column: 2 } } },
          s: { "0": 1, "1": 0 },
          f: { "0": 1 },
        },
      };
      const report = analyze(root, config, coverage);
      expect(report.functions).toEqual([
        {
          location: expect.objectContaining({ file: "src/add.ts", name: "add", startLine: 1 }),
          cc: 1,
          coverage: 0.5,
        },
      ]);
    });
  });

  // coverage のキーは絶対パス。相対に直して引けないと、覆われている関数まで
  // 一律 0% になり、CRAP が全関数を偽の赤にする。
  it("coverage に現れないファイルの関数は 0%", () => {
    withFunctionRepo((root) => {
      const report = analyze(root, config, {});
      expect(report.functions.map((fn) => fn.coverage)).toEqual([0]);
    });
  });

  // 黙って落とすと「測る対象 N 関数」が理由なく減る。理由まで載せる。
  it("関数が無いファイルは理由つきで外す", () => {
    withFunctionRepo((root) => {
      const report = analyze(root, config, {});
      expect(report.excluded).toEqual([{ file: "src/bare.ts", reason: "関数がありません" }]);
    });
  });

  // 報告の受け手（core 側）はこの 3 つで「誰が何の版で測ったか」を判断する。
  it("スキーマ版とアダプタの素性と root を載せる", () => {
    withFunctionRepo((root) => {
      const report = analyze(root, config, {});
      expect(report.schemaVersion).toBe(1);
      expect(report.adapter).toEqual({ name: "typescript", version: "0.0.0" });
      expect(report.root).toBe(root);
    });
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
