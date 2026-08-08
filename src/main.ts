
/**
 * コマンドの中身。`cli.ts` が Node のバージョンを確かめてから読み込む。
 *
 * ここは薄く保つ。判断は run.ts と guard.ts にあり、そちらはテストできる。
 */

import { readFileSync } from "node:fs";
import { GUARD_MESSAGE, shouldBlock } from "./guard.ts";
import { init, parseInitOptions, scopeReport } from "./init.ts";
import { describeCrash, run } from "./run.ts";
import { EXIT_BLOCKED, EXIT_PASS, type TierName, exitCodeFor } from "./tier.ts";

function guard(_argv: readonly string[]): number {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (!shouldBlock(input as Parameters<typeof shouldBlock>[0])) return EXIT_PASS;
  process.stderr.write(`${GUARD_MESSAGE}\n`);
  return EXIT_BLOCKED;
}

function initCommand(argv: readonly string[]): number {
  const options = parseInitOptions(argv);
  const written = init(process.cwd(), options);
  const { matched, unmatched } = scopeReport(process.cwd(), options);
  const notice =
    unmatched.length === 0
      ? ""
      : `\n対象外に TypeScript があります: ${unmatched.join(", ")}\n` +
        `測る範囲が正しいか gauntlet.config.json の source を確認してください（.claude/skills/gauntlet-setup）。\n`;
  process.stderr.write(`${written.map((path) => `  ${path}`).join("\n")}\n\n測る対象: ${matched} ファイル\n${notice}`);
  return EXIT_PASS;
}

/** tier はサブコマンド名で確定する。フックも CI も手動も同じ形で呼ぶ。 */
function tierCommand(tier: TierName): () => number {
  return () => {
    const { output, result } = run(tier, process.cwd());
    process.stderr.write(`${output}\n`);
    return exitCodeFor(result);
  };
}

const USAGE = `gauntlet <command>

  quick   差分に閉じた検査。型チェック + 関連テスト + 触った関数の CRAP
          （Stop フック・pre-commit・手動、起動点はリポジトリが選ぶ）
  full    全量検査。上に加えて全テスト・lint・重複・ラチェット・mutation（CI から）
  init    フック・設定・skill を置く（CI は skill が案内する）
  guard   PreToolUse フックから。baseline の書き換えを止める

通れば exit 0、違反または gauntlet 自身が走れなければ exit 2。
`;

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
  quick: tierCommand("quick"),
  full: tierCommand("full"),
  run: renamed,
  help,
  "--help": help,
  "-h": help,
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
