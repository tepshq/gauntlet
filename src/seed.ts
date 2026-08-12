/**
 * mutation の記録の種置き。**ゲートではない。**
 *
 * 変異対象は差分から決まるので、clean な既定ブランチでは必ず 0 — 導入時に `full` を
 * 回しても記録は空のままで、最初にそのファイルに触れた PR が自分の新コードの生き残りを
 * 許容値にしてしまう（#36）。差分に依らず宣言した範囲を測って、main の状態を記録する。
 *
 * `run.ts` から分けたのは、**プロセスを触る殻を 1 か所に閉じる**ため。判断（断る理由・
 * 対象の選び方・報告の文）は純関数にしてあり、殻に残した分岐は「対象 0 件なら測らない」
 * の 1 つだけ。
 */

import { type GauntletConfig, loadConfig } from "./config.ts";
import { type Baseline, type MutationRecord, BASELINE_FILENAME, loadBaseline, saveBaseline } from "./baseline.ts";
import { workingTreeClean } from "./git.ts";
import { listSourceFiles } from "./typescript/adapter.ts";
import { type MutationOutcome, requireMutationTools, runMutation } from "./typescript/mutation.ts";
import { RunnerError, type TestOutcome, runTests } from "./typescript/runner.ts";
import { type Notify, countByFile, coveredFiles, declaredProjects, mutationRecords, needsTestsMessage } from "./run.ts";

/**
 * 種を置く対象。**差分ではなく宣言した範囲から決め、記録の無いファイルだけを測る。**
 *
 * 変異対象は差分から決まるので、**clean な既定ブランチでは必ず 0** — 導入時に `full` を
 * 回しても `mutation` は `{}` のままで、記録は「そのファイルに最初に触れた PR」が作る。
 * するとその PR が書いたコードの生き残りがそのまま許容値になり（報告例では 513 件）、
 * 「main の状態を基準にして PR の増分を問う」形にならない（#36）。
 *
 * 既に記録のあるファイルを外すのは 2 つの理由から。**緩める経路を作らない**（種置きが
 * 既存の記録を上書きできると、赤いファイルを `seed` で洗える）ことと、**分割して回せる**
 * ようにするため（780 ファイルを一度に測れないので、同じコマンドを繰り返すと残りだけが
 * 進む）。テストが触れないファイルを外すのは `full` と同じ理由（Stryker が落ちる）。
 */
export function seedTargets(
  candidates: readonly string[],
  inScope: readonly string[],
  tested: ReadonlySet<string>,
  recorded: Readonly<Record<string, MutationRecord>>,
): string[] {
  const scoped = new Set(inScope);
  return [...new Set(candidates)]
    .filter((file) => scoped.has(file) && tested.has(file) && recorded[file] === undefined)
    .sort();
}

/** 置いた種の報告。**0 件のときに黙らない** — 範囲の指定ミスと「もう全部ある」は別物。 */
export function seedMessage(records: Readonly<Record<string, MutationRecord>>): string {
  const files = Object.keys(records).length;
  if (files === 0) {
    return (
      "記録を置く対象がありませんでした（範囲の中のファイルは、既に記録があるか、" +
      "どのテストも触れていません）。範囲を広げるか、そのままで構いません"
    );
  }
  const survived = Object.values(records).reduce((sum, record) => sum + record.survived, 0);
  return (
    `mutation を記録しました（${files} ファイル / 生き残り ${survived} 件）。` +
    `git add ${BASELINE_FILENAME} でコミットしてください`
  );
}

/**
 * 種を置けない理由。**置ける状態なら null。**
 *
 * 判断をここに集めて、プロセスを触る殻に分岐を残さない（殻はテストが届かないので、
 * 分岐を置くと未計測の変異と CRAP がそのまま増える — #31 のラチェットに 2 回止められた）。
 */
export function seedRefusal(clean: boolean, outcome: Pick<TestOutcome, "passed" | "failures">): string | null {
  if (!clean) return SEED_NEEDS_CLEAN;
  if (!outcome.passed) return needsTestsMessage(outcome.failures);
  return null;
}

/** 断る理由があれば落とす。走れなかった回を緑にしない。 */
export function refuseUnless(reason: string | null): void {
  if (reason !== null) throw new RunnerError(reason);
}

/**
 * 範囲の指定を `source` と同じ形に揃える。**除外は設定のものを引き継ぐ** —
 * seed だけ広い範囲を測れると、宣言した範囲の外に穴が開く。
 */
export function seedScope(pattern: string, source: GauntletConfig["source"]): GauntletConfig["source"] {
  return { include: [pattern], ...(source.exclude ? { exclude: source.exclude } : {}) };
}

/**
 * 記録がまだ無いリポジトリでも種を置ける。**他のゲートの欄は作らない**（#28）。
 *
 * crap / duplication の欄は、そのゲートが完走した回だけが書く。ここで 0 を埋めると
 * 「測っていないゲートに最も厳しい値」が入る。
 */
export function seedBaseline(root: string): Baseline {
  return loadBaseline(root) ?? { mutation: {} };
}

/**
 * 実測を記録に足して報告する。**測るのは呼び出し側**（Stryker を起動しないので、
 * 「どのファイルが記録に入るか・既存の記録を壊さないか」をテストできる）。
 *
 * 既存の記録は残したまま新しい分だけを足す。`seedTargets` が記録済みを外しているので
 * 上書きは起きないが、ここでも順序で守る（後から来た値が既存を潰さない形にしない）。
 */
export function recordSeed(
  root: string,
  baseline: Baseline,
  targets: readonly string[],
  outcome: Pick<MutationOutcome, "survived" | "noCoverage" | "measured" | "timeout">,
): string {
  const records = mutationRecords(targets, {
    survived: countByFile(outcome.survived),
    measured: outcome.measured,
    timeout: outcome.timeout,
    noCoverage: countByFile(outcome.noCoverage),
  });
  saveBaseline(root, { ...baseline, mutation: { ...records, ...baseline.mutation } });
  return seedMessage(records);
}

/** Stryker を起動して記録する殻。**分岐を持たない。** */
function measureAndRecord(
  root: string,
  config: GauntletConfig,
  baseline: Baseline,
  targets: readonly string[],
  notify: Notify,
): string {
  requireMutationTools(root);
  notify(`変異対象 ${targets.length} ファイル。作業ツリーを一時的に書き換えます`);
  return recordSeed(root, baseline, targets, runMutation(root, targets, declaredProjects(config)));
}

/**
 * 宣言した範囲を測って記録の種を置く。**ゲートではない**（判定はせず、記録だけ置く）。
 *
 * 判断は `seedRefusal` / `seedTargets` / `seedMessage` にある。ここはプロセスと
 * ファイルを触るだけの殻。clean なツリーでだけ書くのは `full` と同じ（#23）。
 */
export function seedMutation(root: string, pattern: string, notify: Notify): string {
  const config = loadConfig(root);
  const outcome = runTests(root, null, declaredProjects(config), [], config.source.include);
  refuseUnless(seedRefusal(workingTreeClean(root), outcome));
  const baseline = seedBaseline(root);
  const targets = seedTargets(
    listSourceFiles(root, seedScope(pattern, config.source)),
    listSourceFiles(root, config.source),
    new Set(coveredFiles(root, outcome.coverage)),
    baseline.mutation,
  );
  return targets.length === 0 ? seedMessage({}) : measureAndRecord(root, config, baseline, targets, notify);
}

/**
 * `seed --mutation=<glob>` の範囲。**無ければ null**（呼び出し側が使い方を出して止める）。
 *
 * 既定を「測る対象すべて」にしない — 780 ファイルの実行が事故で始まる。範囲を書かせる
 * ことが、そのまま「何回かに分けて回す」の入口になる。
 */
export function parseSeedPattern(argv: readonly string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith("--mutation="));
  const pattern = flag?.slice("--mutation=".length).trim();
  return pattern === undefined || pattern === "" ? null : pattern;
}

export const SEED_USAGE = `gauntlet seed --mutation=<glob>

  差分に依らず、渡した範囲を測って mutation の記録を置く（ゲートではない）。
  既定ブランチの clean なツリーで回すと「main の状態」が許容値になる。
  記録の無いファイルだけを測るので、範囲を変えて何回かに分けて回せる。

  例: npx gauntlet seed --mutation='lib/**/*.ts'
`;

/** 種置きも clean なツリーの実測だけを記録する（`full` と同じ理由 — #23）。 */
export const SEED_NEEDS_CLEAN =
  "作業ツリーが clean ではありません。記録するのはコミット済みの状態の実測だけです" +
  "（作業途中の値を基準にしないため）。コミットしてから seed を回してください";

