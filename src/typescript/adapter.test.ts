import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewIncludes, toPosix } from "./adapter.ts";

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
  function withRepo(body: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-include-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
      mkdirSync(join(root, "src", "utils"), { recursive: true });
      writeFileSync(join(root, "src", "alpha.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "src", "utils", "beta.ts"), "export const b = 2;\n");
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

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
