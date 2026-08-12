import { describe, expect, it } from "vitest";
import { capture, captureShell, captureStreaming } from "./exec.ts";

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

  // combined は失敗の原因を人に見せるためのもの。道具は前後に空行を吐くので、
  // そのまま載せると報告の頭とお尻が空白で始まる（違反 1 行ごとの出力に混ざる）。
  it("combined の前後の空白を落とす", () => {
    const result = capture(
      NODE,
      ["-e", "process.stdout.write('  out\\n'); process.stderr.write('  err  '); process.exit(1)"],
      process.cwd(),
    );
    // 落とすのは前後だけ。間の空白は原因の一部なので残す。
    expect(result.combined).toBe("out\n  err");
    // stdout の方は機械可読なので触らない。
    expect(result.stdout).toBe("  out\n");
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

// #38: 分単位の段で出力を全部バッファすると、打ち切られた回のログに何も残らない。
// 流しながら捕まえる口。**終了コードは tee のもの**なので、使う側は本文で判定する。
describe("captureStreaming", () => {
  it("出力を捕まえる", () => {
    expect(captureStreaming(process.execPath, ["-e", "console.log('進行 1')"], process.cwd()).combined).toContain(
      "進行 1",
    );
  });

  // 標準エラーも同じ流れに入れる（Stryker は失敗の理由をそちらに出すことがある）。
  it("標準エラーも同じ本文に入る", () => {
    expect(captureStreaming(process.execPath, ["-e", "console.error('原因')"], process.cwd()).combined).toContain(
      "原因",
    );
  });

  // 落ちた回こそ本文が要る。捕まえ損ねると失敗の理由が消える（0.23.3 で踏んだ形）。
  it("落ちても書けた分は返す", () => {
    const captured = captureStreaming(
      process.execPath,
      ["-e", "console.log('ここまで'); process.exit(3)"],
      process.cwd(),
    );
    expect(captured.combined).toContain("ここまで");
  });

  // 終了コードは tee のものになる。ここを頼ると「落ちたのに 0」になるので、
  // 使う側（runMutation）は本文とレポートの有無で判定している。
  it("終了コードは当てにならない（常に 0）", () => {
    expect(captureStreaming(process.execPath, ["-e", "process.exit(3)"], process.cwd()).code).toBe(0);
  });

  // 引数はシェルを経由しても分割されない（パスに空白が入る対象リポジトリがある）。
  it("空白を含む引数をそのまま渡す", () => {
    const captured = captureStreaming(process.execPath, ["-e", "console.log(process.argv[1])", "a b"], process.cwd());
    expect(captured.combined.trim()).toBe("a b");
  });
});
