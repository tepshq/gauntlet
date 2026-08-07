import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchCandidates, changedLines, collectHunks, hunkLines, lines } from "./git.ts";

describe("branchCandidates", () => {
  // CI の checkout は対象ブランチしかローカルに作らないので、`main` は解決できず
  // `origin/main` だけが存在する。手元では逆のこともある。
  it("ローカルとリモート追跡の両方を試す", () => {
    expect(branchCandidates("main")).toEqual(["main", "origin/main"]);
  });

  it("既にリモートを指していれば足さない", () => {
    expect(branchCandidates("origin/main")).toEqual(["origin/main"]);
  });

  it("upstream など別のリモートでもそのまま使う", () => {
    expect(branchCandidates("upstream/trunk")).toEqual(["upstream/trunk"]);
  });
});

describe("changedLines", () => {
  function repo(body: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-git-"));
    const run = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };
    try {
      run("init", "-q", "-b", "main");
      run("config", "user.name", "t");
      run("config", "user.email", "t@t");
      writeFileSync(join(root, "seed.txt"), "x\n");
      run("add", "-A");
      run("commit", "-q", "-m", "init");
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // git は既定で非 ASCII のパスを引用符付き・8 進エスケープで返す。
  // そのまま開こうとすると ENOENT で落ちる。
  it("日本語のファイル名を読める", () => {
    repo((root) => {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs/資料.ts"), "export const a = 1;\n");
      expect([...changedLines(root, "main").keys()]).toContain("docs/資料.ts");
    });
  });

  // 未追跡には画像や xlsx も混ざる。ここで落ちると gauntlet 全体が動かない。
  it("読めないファイルがあっても落ちない", () => {
    repo((root) => {
      writeFileSync(join(root, "binary.xlsx"), Buffer.from([0x00, 0xff, 0xfe]));
      writeFileSync(join(root, "ok.ts"), "export const a = 1;\n");
      expect([...changedLines(root, "main").keys()]).toContain("ok.ts");
    });
  });

  // 行番号は 1 始まり。ずれると触った関数の判定が丸ごと外れる。
  it("新規ファイルは 1 行目から全行を変更とみなす", () => {
    repo((root) => {
      writeFileSync(join(root, "new.ts"), "a\nb\nc\n");
      expect([...(changedLines(root, "main").get("new.ts") ?? [])].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
    });
  });

  // ハンクを読まないと、コミット済み・未コミットの変更が全部見えなくなる。
  it("既存ファイルの変更行を読む", () => {
    repo((root) => {
      writeFileSync(join(root, "seed.txt"), "x\nadded\n");
      expect([...(changedLines(root, "main").get("seed.txt") ?? [])]).toEqual([2]);
    });
  });

  it("変更が無ければ空", () => {
    repo((root) => {
      expect(changedLines(root, "main").size).toBe(0);
    });
  });

  // 出力が空のときに分割すると、空文字がファイル名として紛れ込む。
  it("空のファイル名を作らない", () => {
    repo((root) => {
      writeFileSync(join(root, "new.ts"), "a\n");
      expect([...changedLines(root, "main").keys()]).toEqual(["new.ts"]);
    });
  });
});

describe("hunkLines", () => {
  it.each([
    ["個数付き", "@@ -1,3 +5,2 @@", [5, 6]],
    ["個数なしは 1 行", "@@ -1 +7 @@", [7]],
    ["旧側だけ個数付き", "@@ -1,3 +9 @@", [9]],
    ["桁が多くても読む", "@@ -100,2 +1234,3 @@", [1234, 1235, 1236]],
    ["旧側の個数が 2 桁以上", "@@ -1,12 +5,2 @@", [5, 6]],
    ["新側の個数が 2 桁以上", "@@ -1,3 +5,12 @@", [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]],
  ])("%s", (_label, header, expected) => {
    expect(hunkLines(header)).toEqual(expected);
  });

  // 削除だけのハンクは新側に行を持たない。ここを 1 行と数えると、
  // 消しただけの差分で無関係な関数が「触った」判定になる。
  it("新側が 0 行なら何も返さない", () => {
    expect(hunkLines("@@ -3,2 +4,0 @@")).toEqual([]);
  });

  it.each([
    ["ハンクでない行", "diff --git a/x b/x"],
    ["空", ""],
    ["先頭が @@ でない", " @@ -1,1 +1,1 @@"],
  ])("%s は無視する", (_label, line) => {
    expect(hunkLines(line)).toEqual([]);
  });
});

describe("collectHunks", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,0 +2,2 @@",
    "+added",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -5 +7 @@",
    "-old",
  ].join("\n");

  it("ファイルごとに変更行を集める", () => {
    const into = new Map<string, Set<number>>();
    collectHunks(diff, into);
    expect([...into.keys()]).toEqual(["a.ts", "b.ts"]);
    expect([...(into.get("a.ts") ?? [])]).toEqual([2, 3]);
    expect([...(into.get("b.ts") ?? [])]).toEqual([7]);
  });

  // 新側（+++）を見ないと、リネームで消えた側のパスを拾ってしまう。
  it("旧側のパスは拾わない", () => {
    const into = new Map<string, Set<number>>();
    collectHunks("--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@", into);
    expect([...into.keys()]).toEqual(["new.ts"]);
  });

  it("既にある集合に足す", () => {
    const into = new Map([["a.ts", new Set([99])]]);
    collectHunks("+++ b/a.ts\n@@ -1 +1 @@", into);
    expect([...(into.get("a.ts") ?? [])].sort((x, y) => x - y)).toEqual([1, 99]);
  });

  // ファイル名が決まる前のハンクを拾うと、null をキーにした集合ができる。
  it("ファイル名より前のハンクは無視する", () => {
    const into = new Map<string, Set<number>>();
    collectHunks("@@ -1 +1 @@\n+++ b/a.ts\n@@ -2 +2 @@", into);
    expect([...into.keys()]).toEqual(["a.ts"]);
    expect([...(into.get("a.ts") ?? [])]).toEqual([2]);
  });
});

describe("collectHunks — 空の扱い", () => {
  // 変更行を持たないファイルがキーとして現れると、触っていないのに
  // 触った判定の入り口に立ってしまう。
  it("変更行が無ければキーを作らない", () => {
    const into = new Map<string, Set<number>>();
    collectHunks("+++ b/a.ts\n@@ -3,2 +4,0 @@", into);
    expect([...into.keys()]).toEqual([]);
  });

  it("ハンクでない行だけでもキーを作らない", () => {
    const into = new Map<string, Set<number>>();
    collectHunks("+++ b/a.ts\n-removed\n+added", into);
    expect([...into.keys()]).toEqual([]);
  });
});

describe("lines", () => {
  it("行に分ける", () => {
    expect(lines("a\nb")).toEqual(["a", "b"]);
  });

  // git の出力は末尾に改行が付く。素で分割すると空文字がファイル名として紛れ込む。
  it("末尾の改行で空文字を作らない", () => {
    expect(lines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("途中の空行も落とす", () => {
    expect(lines("a\n\nb")).toEqual(["a", "b"]);
  });

  it("空なら空", () => {
    expect(lines("")).toEqual([]);
  });
});
