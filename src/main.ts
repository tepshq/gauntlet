
/**
 * コマンドの中身。`cli.ts` が Node のバージョンを確かめてから読み込む。
 *
 * ここは薄く保つ。判断は run.ts と guard.ts にあり、そちらはテストできる。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GUARD_MESSAGE, shouldBlock } from "./guard.ts";
import { INIT_USAGE, formatInit, helpRequested, init, parseInitOptions } from "./init.ts";
import { describeCrash, doctor, listViolators, run } from "./run.ts";
import { EXIT_BLOCKED, EXIT_PASS, type TierName, exitCodeFor } from "./tier.ts";

function guard(): number {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (!shouldBlock(input as Parameters<typeof shouldBlock>[0])) return EXIT_PASS;
  process.stderr.write(`${GUARD_MESSAGE}\n`);
  return EXIT_BLOCKED;
}

function initCommand(argv: readonly string[]): number {
  // ヘルプは実行の前に見る。`init --help` が範囲を既定値で上書きしていた（h3 で実害）。
  if (helpRequested(argv)) {
    process.stderr.write(INIT_USAGE);
    return EXIT_PASS;
  }
  // フラグ無し（parseInitOptions が null）は骨組みの整備だけ。既存の範囲に触らない。
  process.stderr.write(formatInit(init(process.cwd(), parseInitOptions(argv))));
  return EXIT_PASS;
}

/** 一覧はゲートではないので、違反があっても exit 0。落ちるのは走れなかったときだけ。 */
function listCommand(): number {
  process.stderr.write(`${listViolators(process.cwd())}\n`);
  return EXIT_PASS;
}

/** 導入時に一度も動かないゲート（mutation）を動かして確かめる。走れば exit 0。 */
function doctorCommand(): number {
  const excluded = doctor(process.cwd());
  const dropped =
    excluded.length === 0 ? "" : `\n  ${excluded.join("、")} の変異は Stryker が置けないので、以降も測りません`;
  process.stderr.write(`gauntlet doctor: ok  Stryker が vitest を起動できました（変異は作らず初回実行のみ）${dropped}\n`);
  return EXIT_PASS;
}

/** tier はサブコマンド名で確定する。フックも CI も手動も同じ形で呼ぶ。 */
function tierCommand(tier: TierName): () => number {
  return () => {
    // 進捗を出すのは `full` だけ。`quick` は数秒で終わる上に、出力がフック経由で
    // エージェントの文脈に入るので、行を増やす価値が無い。
    const notify =
      tier === "full" ? (line: string): void => void process.stderr.write(`gauntlet full: ${line}\n`) : undefined;
    const { output, result } = run(tier, process.cwd(), notify);
    process.stderr.write(`${output}\n`);
    return exitCodeFor(result);
  };
}

const USAGE = `gauntlet <command>

  quick   差分に閉じた検査。型チェック + 関連テスト + 触った関数の CRAP
          （PreToolUse フックが git commit の直前に呼ぶ。手動でもそのまま叩ける）
  full    全量検査。上に加えて全テスト・重複・ラチェット・mutation（CI から）
  list    baseline が許容している CRAP 違反を全部並べる（ゲートではない）
  doctor  Stryker が vitest を起動できるか確かめる（導入時に mutation は走らないため）
  init    設定とフックを置く（範囲の決め方と CI は skill が案内する）
  guard   PreToolUse フックから。baseline の書き換えを止める

  --version  入っている版を出す

通れば exit 0、違反または gauntlet 自身が走れなければ exit 2。
`;

/**
 * 入った版を gauntlet 自身に訊く。**skill の完了条件がこれで確かめられる。**
 *
 * pnpm の `minimumReleaseAge` があるので「指定した版と実際に入った版が違う」は
 * 現実に起きる（latest が 0.18.0 のとき 0.13.0 が入った実測がある）。それを
 * 確かめる手段が gauntlet 側に無かった。
 */
function version(): number {
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  const meta = JSON.parse(readFileSync(path, "utf8")) as { version: string };
  process.stdout.write(`${meta.version}\n`);
  return EXIT_PASS;
}

function help(): number {
  process.stderr.write(USAGE);
  return EXIT_PASS;
}

/** 0.12.0 で `run --tier=turn|pr` を `quick` / `full` に改名した。旧形式は案内して止める。 */
function renamed(): number {
  process.stderr.write(`gauntlet: run --tier=turn|pr は 0.12.0 で quick / full になりました\n\n${USAGE}`);
  return EXIT_BLOCKED;
}

/** 知らない指定は素通しせずに止める。走らなかったゲートを緑にしない。 */
function usageError(argv: readonly string[]): number {
  const given = argv.length === 0 ? "コマンドがありません" : `${argv[0]} は知らないコマンドです`;
  process.stderr.write(`gauntlet: ${given}\n\n${USAGE}`);
  return EXIT_BLOCKED;
}

const COMMANDS: Record<string, (argv: readonly string[]) => number> = {
  guard,
  init: initCommand,
  doctor: doctorCommand,
  list: listCommand,
  quick: tierCommand("quick"),
  full: tierCommand("full"),
  run: renamed,
  help,
  "--help": help,
  "-h": help,
  "--version": version,
  "-v": version,
};

function main(argv: readonly string[]): number {
  return (COMMANDS[String(argv[0])] ?? usageError)(argv);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // gauntlet 自身が走れなかった場合も阻止側に倒す。素通しすると flaky になる。
  process.stderr.write(`gauntlet: ${describeCrash(error)}\n`);
  process.exitCode = EXIT_BLOCKED;
}
