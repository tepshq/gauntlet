import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "./main.ts";
import { EXIT_BLOCKED, EXIT_PASS } from "./tier.ts";

/**
 * exit code と、どのストリームに書いたかを掴む。
 *
 * **exit code はフックと CI との契約そのもの**（Claude Code は 2 のときだけ
 * 停止を阻止し、それ以外は素通しする）。ここが 1 つずれると、赤いのに
 * コミットが通る／緑なのに止まる、のどちらかが黙って起きる。
 */
function capture(body: () => number): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  try {
    return { code: body(), out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const packageVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

describe("知らない指定", () => {
  // 素通しすると、走らなかったゲートが緑として扱われる。
  it("知らないコマンドは止めて、名前を返す", () => {
    const { code, err } = capture(() => runCli(["nonsense"]));
    expect(code).toBe(EXIT_BLOCKED);
    expect(err).toContain("nonsense は知らないコマンドです");
  });

  it("コマンドが無いのも止める", () => {
    const { code, err } = capture(() => runCli([]));
    expect(code).toBe(EXIT_BLOCKED);
    expect(err).toContain("コマンドがありません");
  });

  // 止めるだけだと次に何を打てばいいか分からない。使い方まで出す。
  it.each([[[]], [["nonsense"]]])("止めるときは使い方も出す (%j)", (argv) => {
    expect(capture(() => runCli(argv)).err).toContain("gauntlet <command>");
  });

  // 0.12.0 の改名。旧形式を素通しすると、検査されないまま緑になる。
  it("旧 run --tier= は止めて移行先を言う", () => {
    const { code, err } = capture(() => runCli(["run"]));
    expect(code).toBe(EXIT_BLOCKED);
    expect(err).toContain("quick / full");
  });
});

describe("--version", () => {
  // skill の完了条件が「入った版を gauntlet 自身に訊く」なので、
  // 版だけが標準出力に出る必要がある（他のコマンドは全部標準エラー）。
  it.each(["--version", "-v"])("%s は版だけを標準出力に出す", (flag) => {
    const { code, out, err } = capture(() => runCli([flag]));
    expect(code).toBe(EXIT_PASS);
    expect(out).toBe(`${packageVersion}\n`);
    expect(err).toBe("");
  });
});

describe("help", () => {
  it.each(["help", "--help", "-h"])("%s は使い方を出して通す", (flag) => {
    const { code, err } = capture(() => runCli([flag]));
    expect(code).toBe(EXIT_PASS);
    expect(err).toContain("gauntlet <command>");
  });

  // 受け付けるのに使い方に載っていないコマンドがあると、存在に気づけない。
  it.each(["quick", "full", "list", "init", "hook"])("使い方に %s が載っている", (command) => {
    expect(capture(() => runCli(["help"])).err).toContain(command);
  });

  // 出口の意味は使い方の最後に書いてある。ここが本文と食い違うと読み手が誤解する。
  it("exit code の意味を書いてある", () => {
    const { err } = capture(() => runCli(["help"]));
    expect(err).toContain("exit 0");
    expect(err).toContain("exit 2");
  });
});
