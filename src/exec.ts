/**
 * 外部コマンドの実行。
 *
 * gauntlet が呼ぶ道具（vitest / jscpd）は、違反が 1 件でもあれば
 * 非ゼロで終わる。exit code では「道具が落ちた」と「違反があった」を区別できないので、
 * ここでは落とさず出力を返し、判定は呼び出し側が出力そのものに対して行う。
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface Captured {
  /** 標準出力だけ。機械可読な出力を読むときはこちら。 */
  stdout: string;
  /** 標準出力と標準エラーを繋いだもの。失敗の原因を人に見せるときはこちら。 */
  combined: string;
  /** 終了コード。0 以外を落とすかどうかは呼び出し側が決める（vitest では握り潰す）。 */
  code: number;
}

function toCaptured(run: () => string): Captured {
  try {
    const stdout = run();
    return { stdout, combined: stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    const stdout = failure.stdout ?? "";
    return {
      stdout,
      combined: `${stdout}${failure.stderr ?? (error as Error).message}`.trim(),
      code: failure.status ?? 1,
    };
  }
}

export function capture(bin: string, args: readonly string[], cwd: string): Captured {
  return toCaptured(() => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: "pipe" }));
}

/**
 * config に書かれたコマンドをシェルで実行する。
 *
 * `tsc -p a.json --noEmit && tsc --noEmit` のような複数パスの型チェックは
 * 実在する（teps）。引数を分割して渡すだけでは `&&` が tsc の引数になってしまう。
 * `node_modules/.bin` を PATH の先頭に置くので、`npx` を書かなくても解決する。
 */
export function captureShell(command: string, cwd: string): Captured {
  const bin = join(cwd, "node_modules", ".bin");
  return toCaptured(() =>
    execFileSync("sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    }),
  );
}
