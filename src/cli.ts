#!/usr/bin/env node
/**
 * 唯一の入口。`Stop` フックも `PreToolUse` フックも CI も、同じこのコマンドを呼ぶ。
 *
 * **ここでは Node のバージョンだけを見て、中身は動的に読み込む。**
 * gauntlet は `node:fs` の `globSync`（Node 22 で入った）を使う。静的 import だと
 * 古い Node ではコードが 1 行も走る前にモジュール解決で落ち、
 * `The requested module 'node:fs' does not provide an export named 'globSync'` しか出ない。
 * duct の CI で実際に踏んだ。`engines` は宣言してあるが npm は警告だけで通す。
 */

import { MINIMUM_NODE_MAJOR, nodeTooOld } from "./node-version.ts";
import { EXIT_BLOCKED } from "./tier.ts";

if (nodeTooOld(process.versions.node)) {
  process.stderr.write(
    `gauntlet: Node ${MINIMUM_NODE_MAJOR} 以上が必要です（いま v${process.versions.node}）\n`,
  );
  process.exitCode = EXIT_BLOCKED;
} else {
  const { runCli } = await import("./main.ts");
  process.exitCode = runCli(process.argv.slice(2));
}
