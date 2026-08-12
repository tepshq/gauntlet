/**
 * 外部コマンドの実行。
 *
 * gauntlet が呼ぶ道具（vitest / eslint / Stryker）は、違反が 1 件でもあれば
 * 非ゼロで終わる。exit code では「道具が落ちた」と「違反があった」を区別できないので、
 * ここでは落とさず出力を返し、判定は呼び出し側が出力そのものに対して行う。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * 出力を**流しながら**捕まえる。分単位かかるコマンド（mutation）のためのもの。
 *
 * `capture` は出力を全部バッファするので、**途中で打ち切られた回には何も残らない** —
 * CI の job 上限で 58 分走って cancel されたとき、ログに残っていたのは gauntlet 自身の
 * 3 行だけで、「どこまで測れたか / あと何分足せばよいか / 止まっているのか」の
 * どれも分からなかった（#38）。
 *
 * `tee` で一時ファイルに写しながら標準出力へ素通しする。Node の同期実行に
 * 「流しつつ捕まえる」口が無いので、シェルに任せるのがいちばん薄い
 * （`captureShell` で既に `sh` に依存している）。**dash（Ubuntu の `/bin/sh`）で実測。**
 * 書き出し先を `/dev/stderr` にしないのは、Linux では呼び出し側が `2> log` している回に
 * `tee` がそのファイルを開き直して先頭から潰しうるため。
 *
 * **終了コードは `tee` のもの**（つまり常に 0）。この口を使う側は出力そのもので
 * 判定すること — mutation はレポートの有無と本文で判定しているので影響しない。
 * 終了コードで判断する dry run（`doctor`）は `capture` のまま。
 */
export function captureStreaming(bin: string, args: readonly string[], cwd: string): Captured {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-stream-"));
  const logPath = join(dir, "output.log");
  try {
    execFileSync("sh", ["-c", '"$@" 2>&1 | tee "$GAUNTLET_LOG"', "sh", bin, ...args], {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, GAUNTLET_LOG: logPath },
    });
    const combined = readFileSync(logPath, "utf8");
    return { stdout: combined, combined, code: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
