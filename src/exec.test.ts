import { describe, expect, it } from "vitest";
import { capture, captureShell } from "./exec.ts";

describe("captureShell", () => {
  // teps の型チェックは `tsc -p a.json --noEmit && tsc --noEmit` の 2 パス。
  // 引数を分割して渡すだけでは && が tsc の引数になる。
  it("シェルの演算子を解釈する", () => {
    expect(captureShell("echo one && echo two", process.cwd()).stdout.trim()).toBe("one\ntwo");
  });

  it("前段が落ちれば後段は走らない", () => {
    expect(captureShell("false && echo unreachable", process.cwd()).stdout).not.toContain("unreachable");
  });

  it("非ゼロで終わっても落とさない", () => {
    expect(captureShell("echo partial; exit 1", process.cwd()).stdout.trim()).toBe("partial");
  });

  // node_modules/.bin を通すので、npx を書かなくても道具が解決する。
  // 「先頭」でないと、同名のグローバルコマンドが優先されて別物が走る。
  it("node_modules/.bin を PATH の先頭に置く", () => {
    const path = captureShell("echo $PATH", process.cwd()).stdout.trim();
    expect(path.split(":")[0]).toBe(`${process.cwd()}/node_modules/.bin`);
  });

  it("実際にローカルの道具が解決する", () => {
    expect(captureShell("tsc --version", process.cwd()).stdout).toMatch(/Version \d/);
  });

  it("標準エラーを stdout に混ぜない", () => {
    expect(captureShell("echo out; echo err 1>&2", process.cwd()).stdout.trim()).toBe("out");
  });
});

const NODE = process.execPath;

describe("capture", () => {
  it("成功した実行の標準出力を返す", () => {
    expect(capture(NODE, ["-e", "process.stdout.write('ok')"], process.cwd()).stdout).toBe("ok");
  });

  // 道具は違反が 1 件でもあれば非ゼロで終わる。ここで落とすと判定ができない。
  it("非ゼロで終わっても落とさず標準出力を返す", () => {
    const result = capture(NODE, ["-e", "process.stdout.write('partial'); process.exit(1)"], process.cwd());
    expect(result.stdout).toBe("partial");
  });

  // 落とすかどうかは呼び出し側が決める（vitest では握り潰し、Stryker の dry run では見る）。
  // 実際のコードを返さないと、道具の「起動できなかった」と「違反があった」を区別できない。
  it("終了コードをそのまま返す", () => {
    expect(capture(NODE, ["-e", "process.exit(3)"], process.cwd()).code).toBe(3);
    expect(capture(NODE, ["-e", ""], process.cwd()).code).toBe(0);
  });

  // 原因が標準エラーにしか出ないことがあるので、両方を繋いで載せる。
  it("失敗の原因を combined に載せる", () => {
    const result = capture(NODE, ["-e", "process.stdout.write('out'); process.stderr.write('why'); process.exit(1)"], process.cwd());
    expect(result.combined).toBe("outwhy");
    expect(result.stdout).toBe("out");
  });

  it("標準エラーが空でも stdout を落とさない", () => {
    const result = capture(NODE, ["-e", "process.stdout.write('only'); process.exit(1)"], process.cwd());
    expect(result.combined).toBe("only");
  });

  it("成功時は combined と stdout が同じ", () => {
    const result = capture(NODE, ["-e", "process.stdout.write('same')"], process.cwd());
    expect(result.combined).toBe(result.stdout);
  });

  it("コマンド自体が無くても落とさない", () => {
    expect(capture("definitely-not-a-command", [], process.cwd()).stdout).toBe("");
  });
});
