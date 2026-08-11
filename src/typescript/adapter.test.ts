import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deadIncludes, toPosix } from "./adapter.ts";

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
describe("deadIncludes", () => {
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
      expect(deadIncludes(root, { include: ["src"] })).toEqual(["src"]);
    });
  });

  it.each(["src/**/*.ts", "src/**", "src/*.ts"])("ソースに届く %s は返さない", (pattern) => {
    withRepo((root) => {
      expect(deadIncludes(root, { include: [pattern] })).toEqual([]);
    });
  });

  // 「今は無いが将来増える」書き方は害が無い。ここで落とすと config が窮屈になる。
  it("1 つもマッチしない include は咎めない", () => {
    withRepo((root) => {
      expect(deadIncludes(root, { include: ["src/**/*.tsx"] })).toEqual([]);
    });
  });

  // 全体としては測れているので、ここを見逃すと範囲が黙って狭いまま緑になる。
  it("生きている include に混ざっていても見つける", () => {
    withRepo((root) => {
      expect(deadIncludes(root, { include: ["src/**/*.ts", "src"] })).toEqual(["src"]);
    });
  });

  // gitignore された生成物にしか当たらない include も、測る対象を連れてこない。
  it("リポジトリが所有しないものにしか当たらなければ返す", () => {
    withRepo((root) => {
      writeFileSync(join(root, ".gitignore"), "dist/\n");
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "generated.ts"), "export const c = 3;\n");
      expect(deadIncludes(root, { include: ["dist/**/*.ts"] })).toEqual(["dist/**/*.ts"]);
    });
  });
});
