/**
 * mutation testing。gauntlet の中で唯一「テストを増やすだけでは通せない」ゲート。
 *
 * **`--inPlace` を使う。** Stryker は既定でサンドボックスにコピーし、その過程で
 * TypeScript の compiler API（`ts.parseConfigFileTextToJson`）を呼ぶが、
 * TypeScript 7 にその API は無く落ちる。`--inPlace` はコピーしないので前処理が走らない。
 * 実ファイルを書き換えることになるが、mutation は CI でしか走らせないので作業ツリーは使い捨て。
 */

import {
  chmodSync,
  existsSync,
  globSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Captured, capture } from "../exec.ts";
import { detectPackageManager, installDevCommand } from "../package-manager.ts";
import { RunnerError, lastReasons } from "./runner.ts";
import { executableFiles } from "../git.ts";

/** Stryker の json reporter の固定出力先。CLI からファイル名を変えられない。 */
export const REPORT_PATH = "reports/mutation/mutation.json";

interface Mutant {
  mutatorName: string;
  replacement?: string;
  status: string;
  /** Ignored の理由。static は Stryker の固定文言、disable はコメントの理由文。 */
  statusReason?: string;
  location: { start: { line: number } };
}

export interface MutationReport {
  files: Record<string, { mutants: Mutant[] }>;
}

export interface SurvivedMutant {
  file: string;
  line: number;
  mutator: string;
  /** 変異後のコード。無いと読み手は Stryker を再実行（分単位）しないと正体が分からない。 */
  replacement: string | null;
}

/**
 * 生き残った変異だけを取り出す。
 *
 * `NoCoverage`（どのテストも通っていない）は数えない。それは網羅率の話で、
 * CRAP が既に見ている。mutation が独自に捕まえるのは「テストは通るが assert が弱い」ケース。
 */
export function survivedFrom(report: MutationReport): SurvivedMutant[] {
  return Object.entries(report.files).flatMap(([file, entry]) =>
    entry.mutants
      .filter((mutant) => mutant.status === "Survived")
      .map((mutant) => ({
        file,
        line: mutant.location.start.line,
        mutator: mutant.mutatorName,
        replacement: mutant.replacement ?? null,
      })),
  );
}

/**
 * ファイルごとに「測った変異」の数（Ignored / NoCoverage を除く）。
 *
 * 記録（`MutationRecord.measured`）に入り、生き残りの増加が「テストが弱くなった」のか
 * 「測定集合が広がった」のかを突き合わせ側が区別できるようにする。
 */
export function measuredByFile(report: MutationReport): Record<string, number> {
  return Object.fromEntries(
    Object.entries(report.files).map(([file, entry]) => [
      file,
      entry.mutants.filter((mutant) => mutant.status !== "Ignored" && mutant.status !== "NoCoverage").length,
    ]),
  );
}

/**
 * 測らなかった変異の内訳。
 *
 * Stryker は `--ignoreStatic` の除外も `// Stryker disable` の除外も同じ `Ignored` に
 * するので、数を分けないと**意図的な除外が「静的な変異」の件数に吸収されて見えなくなる**
 * （#25。「見えていれば人が気づける」を軸に disable 方式を選んだのに、総数だけが
 * 見えない形になっていた）。区別は `statusReason` — static は Stryker の固定文言、
 * disable はコメントの理由文が入る。理由の無い disable は空になるので、それも数える。
 */
export interface IgnoredBreakdown {
  /** モジュール読み込みに影響するため測れない変異（`--ignoreStatic`）。 */
  static: number;
  /** `// Stryker disable` で理由つきで外した変異。 */
  declared: number;
  /** `// Stryker disable` だが理由が書かれていない変異。原則（理由必須）の破れ。 */
  unexplained: number;
}

export function ignoredBreakdown(report: MutationReport): IgnoredBreakdown {
  const breakdown = { static: 0, declared: 0, unexplained: 0 };
  for (const entry of Object.values(report.files)) {
    for (const mutant of entry.mutants) {
      if (mutant.status !== "Ignored") continue;
      if ((mutant.statusReason ?? "").startsWith("Static mutant")) breakdown.static += 1;
      else if ((mutant.statusReason ?? "").trim() === "") breakdown.unexplained += 1;
      else breakdown.declared += 1;
    }
  }
  return breakdown;
}

/**
 * 対象リポジトリの Stryker。
 *
 * `npx stryker` は入っていないと npm から別の（非推奨の）パッケージを取ってきてしまう。
 * 対象リポジトリの vitest に合わせる必要があるので、gauntlet が同梱するのではなく
 * 対象側に入れてもらい、無ければその場で止める。
 */
function strykerBin(root: string): string {
  const bin = join(root, "node_modules", ".bin", "stryker");
  if (existsSync(bin)) return bin;
  throw new RunnerError(
    `Stryker が入っていません。次で入れてください:\n  ${installMutationDeps(root)}`,
  );
}

/** mutation に要る 2 つ。どちらが欠けても同じコマンドで足りる。 */
function installMutationDeps(root: string): string {
  return installDevCommand(detectPackageManager(root), [
    "@stryker-mutator/core",
    "@stryker-mutator/vitest-runner",
  ]);
}

/**
 * vitest-runner の実体を**対象リポジトリから**解決する。
 *
 * Stryker の既定 `plugins: ["@stryker-mutator/*"]` は、Stryker 自身の隣を readdir して
 * プラグインを探す（npm / yarn のフラットな node_modules 前提）。**pnpm の分離レイアウトでは
 * そこに api / core / instrumenter / util しか無く、vitest-runner は別の仮想ストアに置かれる**
 * ので、glob では原理的に見つからない（h3 で実測）。絶対パスは glob に入らずそのまま
 * 読まれるので、実体を名指しする。
 *
 * `createRequire` の基点は**対象リポジトリ**。gauntlet 自身の位置から解決すると、
 * gauntlet は vitest-runner に依存していないので pnpm では見つからない。
 */
export function vitestRunnerPlugin(root: string): string {
  try {
    return createRequire(join(root, "package.json")).resolve(
      "@stryker-mutator/vitest-runner",
    );
  } catch {
    throw new RunnerError(
      `Stryker の vitest-runner が見つかりません。次で入れてください:\n  ${installMutationDeps(root)}`,
    );
  }
}

/**
 * Stryker に渡す設定。CLI 引数ではなく生成した設定ファイルで渡す —
 * vitest runner の `configFile`（下のラッパー）は CLI から指定できないため。
 *
 * **退避先をリポジトリの外に出す。** `--inPlace` は実ファイルを書き換えるので、
 * まず元ファイルを退避ディレクトリへ丸ごとコピーする。それが既定ではリポジトリ内の
 * `.stryker-tmp/` なので、**対象リポジトリの vitest がそのコピーをテストとして拾う**。
 * duct では 22 個の「テストファイルが入力ファイルと照合できない」警告が出て
 * coverage 解析が壊れ、変異ごとに全スイートが走って timeout していた
 * （同じ DB 行を二重に叩いて dry run が落ちることもあった）。外に出せば、
 * 各リポジトリの vitest 設定に除外を足してもらう必要が無くなる。実測 127 秒 → 69 秒。
 *
 * **`--ignoreStatic`。** モジュール直下の式（定数やマップ）への変異は
 * モジュール読み込みそのものに影響するので、Stryker は per-test coverage を使えず
 * **変異ごとに全テストを走らせる**。duct の全スイートは 55 秒なので大半が timeout した
 * （30 行の component で 11 変異中 8 件）。**これは無料ではない** — timeout せずに
 * 判定が出ていた分も失う（同じ実測で Killed 2・Survived 1）。それでも入れる理由は、
 * timeout は違反に数えないので**分単位を払って何も分からない**状態だったこと、
 * そして duct の CI が既に 13 分に達していること。失った分は `ignoredBreakdown` で件数を出す。
 */
export function strykerConfig(
  files: readonly string[],
  tempDir: string,
  vitestConfigFile: string | null,
  runnerPlugin: string,
  excludedMutations: readonly string[] = [],
): Record<string, unknown> {
  return {
    testRunner: "vitest",
    inPlace: true,
    // **初回実行の打ち切りを、誰も選んでいない 5 分（Stryker の既定）に任せない。**
    // dry run は全スイートを perTest coverage 付きで走らせるので、CI が遅いリポジトリでは
    // 原理的に収まらない（duct は手元 51 秒に対し CI 9 分 35 秒。5 分 02 秒で打ち切られた）。
    // しかも**手元では通り CI だけで落ちる**という、他の 4 ゲートには無い形になる。
    //
    // gauntlet は 2 つ目の締切を持たない。**止める役は CI job の `timeout-minutes`** で、
    // それは使う側が選んだ数。ここはその外側に置いて、先に噛まないようにするだけ
    // （異常なハングを最後に捕まえる網であって、予算ではない）。
    dryRunTimeoutMinutes: 60,
    tempDirName: tempDir,
    ignoreStatic: true,
    reporters: ["json"],
    // 既定の `["@stryker-mutator/*"]` は Stryker 自身の隣を readdir して探す。
    // pnpm の分離レイアウトでは vitest-runner は別の場所にあり、原理的に見つからない
    // （npm / yarn のフラットな node_modules 前提の実装）。実体の絶対パスを渡す。
    plugins: [runnerPlugin],
    mutate: [...files],
    // 上流が「置けない」と言った mutator だけを外す（`unplaceableMutators`）。
    ...(excludedMutations.length === 0
      ? {}
      : { mutator: { excludedMutations: [...excludedMutations] } }),
    ...(vitestConfigFile === null
      ? {}
      : { vitest: { configFile: vitestConfigFile } }),
  };
}

/** vitest が設定として解決する名前。vitest 優先は vitest 自身の解決順に合わせている。 */
const CONFIG_CANDIDATES = ["vitest.config", "vite.config"].flatMap((base) =>
  ["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => `${base}.${ext}`),
);

/** リポジトリの vitest 設定。Stryker のラッパーが import する相手。 */
export function findRepoVitestConfig(root: string): string | null {
  const found = CONFIG_CANDIDATES.find((name) => existsSync(join(root, name)));
  return found === undefined ? null : join(root, found);
}

/**
 * Stryker に渡す vitest 設定のラッパー。
 *
 * Stryker の vitest runner には project フィルタが無い（`dir` / `related` /
 * `configFile` のみ）。宣言（`tests.projects`）を効かせるには設定ごと差し替えるしか
 * ないので、リポジトリの設定を import して宣言にある project だけ残したものを
 * 一時ファイルとして渡す。
 *
 * 別ファイルへの glob 文字列（`./x/*\/vitest.config.ts`）で参照された project は
 * 名前が読めないため、宣言があるときは**残せない**（= 宣言できるのはインラインの
 * project だけ）。gauntlet の世界に入れたい project はインラインで書いてもらう。
 *
 * `root` を明示するのは、設定ファイルがリポジトリの外（一時ディレクトリ）に
 * 置かれるため。vitest が設定の場所から root を推測すると探索が壊れる。
 */
export function strykerVitestWrapper(
  repoConfigPath: string,
  root: string,
  projects: readonly string[],
): string {
  return [
    "// gauntlet が生成した一時ファイル。リポジトリの vitest 設定から、宣言された project だけを残す。",
    `import base from ${JSON.stringify(repoConfigPath)};`,
    'const config = (await (typeof base === "function" ? base({ command: "serve", mode: "test" }) : base)) ?? {};',
    `config.root ??= ${JSON.stringify(root)};`,
    // --inPlace が書き戻すのは計装済みのコード。それが型として通ることは原理的に無いので、
    // vitest 側の typecheck が有効なリポジトリでは mutation が必ず落ちる（h3 で実測）。
    // 型は gauntlet が別ゲート（commands.typecheck）で見ているので、ここで見る理由が無い。
    "config.test ??= {};",
    "config.test.typecheck = { enabled: false };",
    `const declared = ${JSON.stringify([...projects])};`,
    "if (declared.length > 0 && Array.isArray(config.test?.projects)) {",
    "  config.test.projects = config.test.projects.filter(",
    '    (project) => typeof project !== "string" && declared.includes(project?.test?.name),',
    "  );",
    "}",
    "export default config;",
    "",
  ].join("\n");
}

export interface GeneratedFile {
  path: string;
  content: string;
}

/**
 * Stryker 起動に要るファイル一式。**先頭が Stryker に渡す設定。**
 * 組み立ては純粋に行い、書くのは呼び出し側。ここをテストで固定して、
 * プロセスを起動する殻（`runMutation`）には判断を残さない。
 */
function confFile(
  confDir: string,
  tempDir: string,
  files: readonly string[],
  wrapper: string | null,
  runnerPlugin: string,
  excluded: readonly string[],
): GeneratedFile {
  return {
    path: join(confDir, "stryker.conf.json"),
    content: JSON.stringify(
      strykerConfig(files, tempDir, wrapper, runnerPlugin, excluded),
      null,
      2,
    ),
  };
}

export function strykerFiles(
  confDir: string,
  tempDir: string,
  root: string,
  repoConfig: string | null,
  projects: readonly string[],
  files: readonly string[],
  runnerPlugin: string,
  excluded: readonly string[] = [],
): GeneratedFile[] {
  if (repoConfig === null)
    return [confFile(confDir, tempDir, files, null, runnerPlugin, excluded)];
  const wrapper = join(confDir, "vitest.config.mjs");
  return [
    confFile(confDir, tempDir, files, wrapper, runnerPlugin, excluded),
    {
      path: wrapper,
      content: strykerVitestWrapper(repoConfig, root, projects),
    },
  ];
}

export interface MutationOutcome {
  survived: SurvivedMutant[];
  /** `--ignoreStatic` で測らなかった数。 */
  ignored: IgnoredBreakdown;
  /** 上流が置けなくて外した mutator。これも測っていない分。 */
  excluded: string[];
  /** ファイルごとの「測った変異」の数。記録に入り、増加の理由の切り分けに使う。 */
  measured: Record<string, number>;
}

/**
 * Stryker が走れる状態かだけを見る。**変異対象が 0 でも呼ぶ。**
 *
 * 道具が揃っているかは対象の有無と無関係なのに、0 件で先に帰ると
 * 「変異対象 0 ファイル」の緑になる。導入直後の種置きは差分にソースが無いので必ずこれを踏み、
 * 壊れていることが最初の実装 PR まで隠れる（h3 で実測）。
 */
export function requireMutationTools(root: string): void {
  strykerBin(root);
  vitestRunnerPlugin(root);
}

/**
 * 変異させる前のファイルの mode。
 *
 * `--inPlace` の書き戻しで実行ビットが落ちる（h3 で `bin/h3.mjs` が 755 → 644）。
 * gauntlet が対象リポジトリに残してよい変更は無いので、自分で戻す。
 */
export function fileModes(
  root: string,
  files: readonly string[],
): Map<string, number> {
  const modes = new Map<string, number>();
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path)) modes.set(path, statSync(path).mode);
  }
  return modes;
}

export function restoreModes(modes: ReadonlyMap<string, number>): void {
  for (const [path, mode] of modes) {
    if (existsSync(path)) chmodSync(path, mode);
  }
}

/**
 * Stryker が対象リポジトリの vitest を**実際に起動できるか**だけを見る。
 *
 * `--dryRunOnly` は変異を作らず最初のテスト実行だけを行う（Stryker が CI 用に
 * 用意している確認モード）。道具が揃っていること（`requireMutationTools`）と、
 * 揃った道具が噛み合うことは別で、後者は変異対象が 0 の回には確かめられない。
 * **導入直後は差分にソースが無いので必ず 0 になる** — mutation だけが一度も
 * 走らないまま「導入完了」になっていた（h3 が指摘）。
 */
export function dryRunMutation(
  root: string,
  files: readonly string[],
  projects: readonly string[],
): string[] {
  const { captured, excluded } = launchStryker(root, files, projects, [
    "--dryRunOnly",
  ]);
  const failure = dryRunFailure(captured);
  if (failure !== null) throw new RunnerError(failure);
  return excluded;
}

/**
 * dry run が失敗していれば、その理由。**通っていれば null。**
 *
 * 判断はここに集め、プロセスを起動する殻には残さない。
 *
 * **テストが 0 件は設定の誤りとは対処が正反対。** Stryker はこれを `ConfigError`
 * （"Please check your configuration"）として投げ、vitest runner は
 * 「`vitest.related` を切れ / ソースを直接 import しろ」と警告する。どちらも設定を
 * 疑わせるが、テストが 0 件のリポジトリでは**設定は正しい**（新規導入直後は珍しくない。
 * 実際に切り分けを誤らせた）。
 */
export function dryRunFailure(captured: Captured): string | null {
  if (captured.combined.includes("No tests were executed")) return NO_TESTS_TO_MUTATE;
  if (captured.code === 0) return null;
  return `Stryker が vitest を起動できませんでした:\n${lastReasons(captured.combined, 15)}`;
}

/**
 * 文言を丸ごと固定する。ここは「何を直せばよいか」がすべてで、
 * 「設定を見直せ」に読めた瞬間に読み手は間違った方向へ行く。
 */
export const NO_TESTS_TO_MUTATE =
  "テストが 1 件も走らなかったので、mutation が回るかは確かめられません。" +
  "設定の誤りではありません — 最初のテストを 1 件書いてから、もう一度 doctor を叩いてください" +
  "（quick / full はテストが 0 件でも通ります）";

/**
 * 上流が「そこには置けない」と言った mutator の名前。
 *
 * Stryker は変異を三項演算子で包んで元の位置に差し戻すが、クラスのメソッド名のように
 * 式を置けない位置がある。そこに当たると**変異 1 個を諦めるのではなく実行ごと落ちる**
 * （h3 の `"~request"()` で実測。上流では 2020 年から 1〜2 年おきに別の構文で再発している）。
 * エラー文が外すべき mutator を自分で名乗るので、構文ごとの特例は持たない。
 */
export function unplaceableMutators(output: string): string[] {
  const match = /could not place mutants with type\(s\): ([^.]+)\./.exec(
    output,
  );
  if (match === null) return [];
  return [
    ...new Set(
      match[1]!.match(/"([^"]+)"/g)?.map((quoted) => quoted.slice(1, -1)) ?? [],
    ),
  ];
}

/** 二重起動の印。リポジトリの中には置かない（作業ツリーを汚さない）。 */
export function lockPath(root: string): string {
  return join(
    tmpdir(),
    `gauntlet-mutation-${createHash("sha1").update(root).digest("hex").slice(0, 12)}.lock`,
  );
}

/**
 * その印を今も握っているプロセス。**死んでいれば握っていない。**
 *
 * 印を消さずに死ぬ（kill -9、電源断）ことはあるので、残骸で永久に止まらないようにする。
 */
export function lockHolder(path: string): number | null {
  if (!existsSync(path)) return null;
  // Number は前後の空白を無視するので、書き手が改行を付けても読める。
  // Stryker disable next-line StringLiteral: 符号化を落とすと Buffer が返るが、
  // Number は文字列化してから数にするので区別できる振る舞いが無い。
  const pid = Number(readFileSync(path, "utf8"));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * 同じリポジトリで mutation を二重に走らせない。
 *
 * `--inPlace` は**プロジェクト全体**を退避し、終了時にそこから書き戻す。同じ作業ツリーで
 * 2 つ走ると**後に書き戻した方が勝ち**、もう一方の未コミットの編集が消える
 * （このリポジトリで実際に消えた）。規律で守れる形ではないので機構で止める。
 */
function withRepoLock<T>(root: string, body: () => T): T {
  const path = lockPath(root);
  const holder = lockHolder(path);
  if (holder !== null) {
    throw new RunnerError(
      `同じリポジトリで gauntlet の mutation が走っています（pid ${holder}）。` +
        "Stryker はプロジェクト全体を書き戻すので、同時に回すと未コミットの編集が消えます。" +
        "終わってから、もう一度実行してください",
    );
  }
  writeFileSync(path, String(process.pid));
  try {
    return body();
  } finally {
    rmSync(path, { force: true });
  }
}

export interface StrykerRun {
  captured: Captured;
  /** 置けなくて外した mutator。**測っていない分**なので呼び出し側が出力に出す。 */
  excluded: string[];
}

/**
 * Stryker を起動して出力を返す。**後片付けまでが仕事。**
 *
 * 設定は退避先と別のディレクトリに置く。Stryker は `tempDirName` の中身を管理する
 * （作成・掃除）ので、同居させると設定ファイルごと消されうる。
 */
function launchStryker(
  root: string,
  files: readonly string[],
  projects: readonly string[],
  extra: readonly string[],
): StrykerRun {
  const bin = strykerBin(root);
  const runner = vitestRunnerPlugin(root);
  // Stryker の退避・復元はプロジェクト全体に及ぶので、変異対象だけでは戻し切れない。
  const modes = fileModes(root, [...files, ...executableFiles(root)]);
  return withRepoLock(root, () => {
    const once = (excluded: readonly string[]): Captured => {
      const tempDir = mkdtempSync(join(tmpdir(), "gauntlet-stryker-"));
      const confDir = mkdtempSync(join(tmpdir(), "gauntlet-stryker-conf-"));
      try {
        const repoConfig = findRepoVitestConfig(root);
        const launch = strykerFiles(
          confDir,
          tempDir,
          root,
          repoConfig,
          projects,
          files,
          runner,
          excluded,
        );
        launch.forEach((file) => writeFileSync(file.path, file.content));
        const captured = capture(bin, ["run", launch[0]!.path, ...extra], root);
        cleanLeftovers(root);
        return captured;
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
        rmSync(confDir, { recursive: true, force: true });
      }
    };
    try {
      const first = once([]);
      // 全損（1 か所置けないだけで 0 件）にはしない。名指しされた 1 種類だけ外して測り直す。
      const excluded = unplaceableMutators(first.combined);
      return excluded.length === 0
        ? { captured: first, excluded }
        : { captured: once(excluded), excluded };
    } finally {
      restoreModes(modes);
    }
  });
}

/** 変異させる対象が 1 つ以上あることは呼び出し側が保証する。 */
export function runMutation(
  root: string,
  files: readonly string[],
  projects: readonly string[],
): MutationOutcome {
  const { captured, excluded } = launchStryker(root, files, projects, []);
  const path = join(root, REPORT_PATH);
  if (!existsSync(path)) {
    throw new RunnerError(
      `Stryker がレポートを出しませんでした:\n${lastReasons(captured.combined, 15)}`,
    );
  }
  // **消さない。** どの変異が生き残ったかを後から見る唯一の材料で、
  // 消すと確かめるには Stryker のフル実行（分単位）をやり直すしかない。
  // `reports/` は init が .gitignore に足している。
  const report = JSON.parse(readFileSync(path, "utf8")) as MutationReport;
  return {
    survived: survivedFrom(report),
    ignored: ignoredBreakdown(report),
    excluded,
    measured: measuredByFile(report),
  };
}

/**
 * Stryker が置いていく作業ファイルを消す。
 *
 * `--inPlace` では `stryker-setup-*.js` がリポジトリのルートに残る。
 * 対象リポジトリを汚すのは gauntlet の仕事ではないので、こちらで片付ける。
 */
function cleanLeftovers(root: string): void {
  for (const name of globSync("stryker-setup-*.js", { cwd: root })) {
    rmSync(join(root, name), { force: true });
  }
}
