import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSourceFiles, reviewIncludes, toPosix, unmeasuredFiles } from "./adapter.ts";

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
  const entry = { statementMap: {}, s: {} };

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
