/**
 * 外部コマンドの実行。
 *
 * gauntlet が呼ぶ道具（vitest / eslint / Stryker）は、違反が 1 件でもあれば
 * 非ゼロで終わる。exit code では「道具が落ちた」と「違反があった」を区別できないので、
 * ここでは落とさず出力を返し、判定は呼び出し側が出力そのものに対して行う。
 */

import { execFileSync } from "node:child_process";

export interface Captured {
  /** 標準出力だけ。機械可読な出力を読むときはこちら。 */
  stdout: string;
  /** 標準出力と標準エラーを繋いだもの。失敗の原因を人に見せるときはこちら。 */
  combined: string;
}

export function capture(bin: string, args: readonly string[], cwd: string): Captured {
  try {
    const stdout = execFileSync(bin, args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { stdout, combined: stdout };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const stdout = failure.stdout ?? "";
    return { stdout, combined: `${stdout}${failure.stderr ?? (error as Error).message}`.trim() };
  }
}
