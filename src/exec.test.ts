import { describe, expect, it } from "vitest";
import { capture } from "./exec.ts";

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

  it("失敗の原因を combined に載せる", () => {
    const result = capture(NODE, ["-e", "process.stderr.write('why'); process.exit(1)"], process.cwd());
    expect(result.combined).toContain("why");
    expect(result.stdout).toBe("");
  });

  it("成功時は combined と stdout が同じ", () => {
    const result = capture(NODE, ["-e", "process.stdout.write('same')"], process.cwd());
    expect(result.combined).toBe(result.stdout);
  });

  it("コマンド自体が無くても落とさない", () => {
    expect(capture("definitely-not-a-command", [], process.cwd()).stdout).toBe("");
  });
});
