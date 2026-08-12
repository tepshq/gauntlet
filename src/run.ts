/**
 * tier の実行。CLI から切り離してテスト可能にしてある。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type GauntletConfig, loadConfig } from "./config.ts";
import { BASELINE_FILENAME, type Baseline, type BaselineStore, type FileRatchet, type MutationRecord, diskStore, loadBaseline, memoryStore, ratchetByFile, ratchetNumber, resolveConflictedBaseline, saveBaseline } from "./baseline.ts";
import { type Captured, captureShell } from "./exec.ts";
import { crapText, gateRepository, gateTouched, measurementFaults, repositoryViolators, touchedFunctions } from "./gate.ts";
import { crap } from "./crap.ts";
import type { FunctionReport } from "./report.ts";
import { changedLines, mergeBase, workingTreeClean } from "./git.ts";
import {
  type CheckName,
  type CheckResult,
  TIER_CHECKS,
  type TierName,
  type TierResult,
  type Violation,
  tierStatus,
} from "./tier.ts";
import { type DeadInclude, type IncludeReview, analyze, isTestFile, listSourceFiles, reviewIncludes, unmeasuredFiles } from "./typescript/adapter.ts";
import type { IstanbulCoverage } from "./typescript/coverage.ts";
import { runDuplication } from "./typescript/duplication.ts";
import { REPORT_PATH, type IgnoredBreakdown, type SurvivedMutant, dryRunMutation, requireMutationTools, runMutation } from "./typescript/mutation.ts";
import { RunnerError, type TestFailure, type TestOutcome, runTests } from "./typescript/runner.ts";


/** どのチェックも「何を見たか」と「違反」を返す。任意にすると出し忘れが緑に見える。 */
interface Examined {
  scope: string;
  violations: Violation[];
}

function timed(name: CheckName, body: () => Examined): CheckResult {
  const started = performance.now();
  const { scope, violations } = body();
  return {
    name,
    status: violations.length === 0 ? "pass" : "fail",
    durationMs: performance.now() - started,
    violations,
    scope,
  };
}

/**
 * 既定の型チェック。`--incremental` は前回の検査結果（.tsbuildinfo、init が
 * .gitignore に足す）を使い、変更の影響範囲だけを再検査する — duct の実測で
 * 8.5s → 1.9s。診断の内容は同じで、速さだけが変わる。
 *
 * キャッシュという状態を持ち込むが、緑の意味は変えない — 権威ある判定である
 * `full` は CI の使い捨てコンテナで走るので、必ずコールド（キャッシュ無し）になる。
 * `quick` の速さのためだけにキャッシュが効く。
 */
export const DEFAULT_TYPECHECK = "tsc --noEmit --incremental";

/** tsc は診断を標準出力に出す。出ていなければ通っている。 */
export function typecheckViolations(result: Captured): Violation[] {
  return result.stdout.trim() === "" ? [] : [{ message: result.combined.trim() }];
}

/**
 * 型エラーの判定はプロジェクトの設定に従う。gauntlet はコマンドを走らせるだけ。
 *
 * 走らせたコマンドをそのまま見せる。tsconfig が複数あるリポジトリでは
 * 既定の `tsc --noEmit` が半分しか見ないことがあり、それは出力に出ないと気づけない。
 */
function typecheck(root: string, config: GauntletConfig): CheckResult {
  const command = config.commands?.typecheck ?? DEFAULT_TYPECHECK;
  return timed("typecheck", () => ({ scope: command, violations: typecheckViolations(captureShell(command, root)) }));
}

/**
 * 段の開始を知らせる先。**打ち切られた回に何も残らないのを防ぐ。**
 *
 * 出力が最後の 1 回だけだと、CI の timeout で殺された回は情報ゼロになる
 * （duct の CI で 2 回。17 分走って 1 行も出ず、「壊れているのか・設定が違うのか・
 * 単に遅いのか」が区別できなかった）。`quick` は数秒で終わり、出力はフック経由で
 * エージェントの文脈に入るので黙らせる — 呼び出し側が渡さなければ何も出ない。
 */
export type Notify = (line: string) => void;

export function runTier(root: string, tier: TierName, notify: Notify = () => {}): TierResult {
  const started = performance.now();
  const conflictNotes = settleConflictedBaseline(root);
  // 記録は改善のたびに gauntlet 自身が書き換える。**書き換えたことを言わないと
  // コミットし忘れ、次の実行でまた同じ値が置き直される**（新規導入で実測）。
  // 前後を突き合わせるだけなので、各ゲートに手を入れずに済む。
  const before = loadBaseline(root);
  const config = loadConfig(root);
  const base = mergeBase(root, config.defaultBranch);
  const projects = declaredProjects(config);

  // quick は差分に関係するテストだけ、full は全体を走らせる。
  const testsStarted = performance.now();
  const outcome = runTests(root, tier === "quick" ? base : null, projects, [], config.source.include);
  const testsMs = performance.now() - testsStarted;

  const report = analyze(root, config, outcome.coverage);
  const changed = changedLines(root, base);
  const store = baselineStoreFor(root, tier, before);
  const persist = store.persists;

  const runners: Record<CheckName, () => CheckResult> = {
    typecheck: () => typecheck(root, config),
    tests: () => testsCheck(outcome, testsMs),
    crap: () =>
      crapCheck(
        store,
        tier,
        report,
        changed,
        outcome,
        reviewIncludes(root, config.source),
        // 部分実行の coverage は変更ファイルに絞られるので、不在に意味が無い。
        tier === "full" ? unmeasuredFiles(root, config.source, outcome.coverage) : [],
      ),
    mutation: () =>
      mutationCheck(
        store,
        root,
        config,
        mutationScope(changed.keys(), (tests) =>
          coveredFiles(root, runTests(root, null, projects, tests, config.source.include).coverage),
        ),
        // フル実行の coverage に現れたファイル = 何かのテストが触れるファイル。
        new Set(coveredFiles(root, outcome.coverage)),
        notify,
      ),
    duplication: () => duplicationCheck(store, root, config),
  };
  const checks = TIER_CHECKS[tier].map((name) => {
    notify(`${name} …`);
    return runners[name]();
  });

  return {
    tier,
    status: tierStatus(checks),
    checks,
    durationMs: performance.now() - started,
    notes: [...conflictNotes, ...baselineNotes(store, before, persist)],
  };
}

/**
 * マージで衝突した記録を、gauntlet 自身が解決して書き戻す。
 *
 * 複数ブランチが両方で記録を締めると、マージ時の衝突は構造的に必ず起きる。
 * guard が書き換えを止めているのでエージェントには出口が無く（Edit も
 * `git checkout --theirs` も止まる）、放置すると parse 不能 → 記録なし → 種置きで
 * **負債の記録が全部消える**という一番悪い経路に落ちる。両側とも実測として
 * コミットされた値なので、厳しい側を機械的に取ればエージェントに値を選ばせずに済む。
 *
 * dirty なツリーへの書き込みだが「作業途中の実測を基準にしない」原則には反しない —
 * 書くのは今の実測ではなく、コミット済みの 2 つの実測の厳しい側。
 * 解決できない形（マーカーが千切れている等）はここでは何もせず、従来どおり
 * 「読めない記録」として種置き（それは赤くなる）に任せる。
 */
export function settleConflictedBaseline(root: string): string[] {
  const path = join(root, BASELINE_FILENAME);
  if (!existsSync(path)) return [];
  const resolved = resolveConflictedBaseline(readFileSync(path, "utf8"));
  if (resolved === null) return [];
  saveBaseline(root, resolved);
  return [
    `${BASELINE_FILENAME} のマージ衝突を、フィールドごとに厳しい側を取って解決しました。` +
      `git add ${BASELINE_FILENAME} でステージしてください`,
  ];
}

/**
 * この実行が書いた記録を、残すか・書き戻すか決めて、知らせる文を返す。
 *
 * **作業途中の値で締めない。** 分割の途中は数字が上下するのが普通で、途中の一番
 * 良かった瞬間が基準になると、続きの編集が自分の未完成状態に負ける（77 → 80 で
 * 実際に落ちた）。stash 中の実行が記録を汚して `git stash pop` が衝突する事故も同根。
 * clean なツリーの実測（= コミット済みの状態そのもの）だけを記録する。
 *
 * 例外は種置き（`before` が無い）— init 直後は必ず未コミットなので、そこで
 * 書かないと導入が始まらない。種の回は「コミットしてください」で落ちるので、
 * 作業途中の値が黙って基準になることはない。
 */
/**
 * この実行の記録の更新を残してよいか。**チェックが記録を書く前に**判定する —
 * 書いた後に status を見ると、その書き込み自体がツリーを汚して常に「clean でない」になる。
 *
 * 種置き（`before` が無い）はここでは扱わない。`settleBaseline` が例外として残す。
 */
export function canRecordBaseline(root: string, tier: TierName, before: Baseline | null): boolean {
  return tier === "full" && before !== null && workingTreeClean(root);
}

/**
 * この実行の記録の読み書き口。**書いてよい実行かを store の差し替えで表す。**
 *
 * 書けない実行はメモリに逸れるので、「書いてから書き戻す」のクラッシュ窓
 * （その間に死ぬと作業途中の値が残る）が無い。種置き（before 無し）はディスク —
 * init 直後は必ず未コミットで、書かないと導入が始まらない。
 */
export function baselineStoreFor(
  root: string,
  tier: TierName,
  before: Baseline | null,
): BaselineStore & { persists: boolean } {
  const persists = before === null || canRecordBaseline(root, tier, before);
  return { ...(persists ? diskStore(root) : memoryStore(before)), persists };
}

/** キー順に依存しない比較のための正規形。手で編集された記録は順序が揃っていない。 */
function canonicalBaseline(baseline: Baseline): string {
  return JSON.stringify({
    crap: baseline.crap,
    duplication: baseline.duplication ?? null,
    mutation: Object.fromEntries(Object.entries(baseline.mutation).sort()),
  });
}

export function baselineNotes(store: BaselineStore, before: Baseline | null, persist: boolean): string[] {
  const after = store.load();
  if (before === null || after === null) return [];
  if (canonicalBaseline(after) === canonicalBaseline(before)) return [];
  if (persist) return ratchetNote(before, after);
  return [
    `実測では記録が動きました（${ratchetChanges(before, after).join(" / ")}）が、` +
      "作業ツリーが clean でないため保存していません（作業途中の値を基準にしないため）。" +
      "コミットしてから full を回すと記録されます",
  ];
}

/**
 * 記録が締まったことの知らせ。**違反ではないので落とさない。**
 *
 * 種を置いた回（`before` が無い）は別の案内が出るので、ここでは黙る。
 */
export function ratchetNote(before: Baseline | null, after: Baseline | null): string[] {
  if (before === null || after === null) return [];
  const changes = ratchetChanges(before, after);
  if (changes.length === 0) return [];
  return [`許容値を締めました（${changes.join(" / ")}）。git add -A などでコミットしてください`];
}

/** 記録のどこが動いたか。言い方は `ratchetNote` の仕事。 */
export function ratchetChanges(before: Baseline, after: Baseline): string[] {
  const changes: string[] = [];
  if (after.crap !== before.crap) changes.push(`CRAP 違反 ${before.crap} → ${after.crap}`);
  if (after.duplication !== before.duplication) {
    changes.push(`重複 ${before.duplication ?? 0} → ${after.duplication ?? 0} トークン`);
  }
  const files = [...new Set([...Object.keys(before.mutation), ...Object.keys(after.mutation)])].filter(
    (file) => JSON.stringify(before.mutation[file]) !== JSON.stringify(after.mutation[file]),
  );
  // 新しく記録したファイルは名指しする。初回観測がそのまま許容値になるので、コードを
  // 別ファイルに移すと生き残りが黙って消える — 見えていれば人がレビューで気づける。
  const seeded = files.filter(
    // Stryker disable next-line OptionalChaining: `files` は両者のキーの和集合なので、
    // before に無いファイルは必ず after にある。&& の短絡で ?. の左は常に定義済み。
    (file) => before.mutation[file] === undefined && (after.mutation[file]?.survived ?? 0) > 0,
  );
  for (const file of seeded) {
    changes.push(`mutation を新しく記録: ${file}（生き残り ${after.mutation[file]!.survived} 件）`);
  }
  const rest = files.length - seeded.length;
  if (rest > 0) changes.push(`mutation ${rest} ファイル`);
  return changes;
}

/**
 * 違反 1 件に載せる詳細の上限。
 *
 * 全部並べると本当の原因が量に埋もれる。切った分は件数で言う —
 * 黙って切ると「これで全部」に読める。
 */
const DETAIL_LIMIT = 10;

export function detailLines(items: readonly string[], limit: number): string[] {
  if (items.length <= limit) return [...items];
  return [...items.slice(0, limit), `…他 ${items.length - limit} 件`];
}

function indented(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** 見出しの下に詳細を 2 字下げでぶら下げる。`formatResult` が全体をさらに下げる。 */
export function withDetails(head: string, items: readonly string[]): string {
  const lines = detailLines(items, DETAIL_LIMIT);
  return lines.length === 0 ? head : `${head}\n${indented(lines.join("\n"))}`;
}

/**
 * 失敗の本文から、直すのに要る部分だけを残す。
 *
 * スタックトレースは削る — 理由（期待値と実際）を残せば、場所はテスト名で足りる。
 * 色コードは端末でない出力にも混ざることがあるので落とす。
 */
export function condenseFailure(message: string, limit: number): string {
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const lines = message
    .replace(ansi, "")
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line));
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return detailLines(lines, limit).join("\n");
}

/**
 * vitest の JSON 側に理由が無いか。
 *
 * 空のことも（ファイル自体の失敗）、`STACK_TRACE_ERROR` に差し替わっていることもある
 * （timeout。h3 で実測。default reporter 側には `Test timed out in 5000ms.` と出ていた）。
 * どちらも「落ちた」以外が伝わらないので、同じ扱いにする。
 */
export function lacksReason(message: string): boolean {
  const body = condenseFailure(message, DETAIL_LIMIT);
  return body === "" || body.split("\n").every((line) => line.includes("STACK_TRACE_ERROR"));
}

/**
 * 落ちたテスト 1 件を、再実行せずに直せる形で。
 *
 * **理由が無くても、次に打つものは必ず出す。** 名前だけ出すと「落ちた」以外の情報が
 * ゼロになり、手で切り分ける以外になくなる（h3 では 10 回近く回すことになった）。
 */
export function testViolation(failure: TestFailure): Violation {
  const title = `${failure.test ?? "(テストファイル自体が失敗)"}  ${failure.file}`;
  const detail = lacksReason(failure.message)
    ? `理由が出ていません。npx vitest run ${failure.file} で確認してください`
    : condenseFailure(failure.message, DETAIL_LIMIT);
  return { message: `${title}\n${indented(detail)}`, file: failure.file };
}

/**
 * vitest が人向けに印字した失敗の節。**JSON 側に理由が無いときだけ添える。**
 *
 * 判定は JSON のまま、理由は default reporter から取る。両方出すと、
 * 理由が読める普通の失敗では同じ内容が 2 回並ぶ。
 */
export function failureReport(output: string): string {
  const marker = output.indexOf("Failed Tests");
  return marker === -1 ? "" : condenseFailure(output.slice(marker), DETAIL_LIMIT);
}

/**
 * 「N 件が失敗」だけでは再実行しないと直せない。落ちたテストごとに理由を並べる。
 *
 * **assert が 1 つも落ちずにファイルが落ちる形がある**（import エラー、timeout）。
 * そのとき vitest の数え方では失敗 0 件なので、`0 / 1668 件が失敗` と出て
 * 「何も落ちていない」に読める（h3 で実測）。数え方を変えて言う。
 */
export function testViolations(outcome: Pick<TestOutcome, "failed" | "total" | "failures" | "output">): Violation[] {
  const summary =
    outcome.failed === 0 && outcome.failures.length > 0
      ? `${outcome.failures.length} ファイルがテストを実行できませんでした（${outcome.total} 件中の失敗は 0 件）:`
      : `${outcome.failed} / ${outcome.total} 件が失敗:`;
  if (outcome.failures.length === 0) {
    return [{ message: `${summary} 詳細を取れませんでした。npx vitest run で確認してください` }];
  }
  const shown = outcome.failures.slice(0, DETAIL_LIMIT).map(testViolation);
  const rest = outcome.failures.length - DETAIL_LIMIT;
  const printed = outcome.failures.some((failure) => lacksReason(failure.message)) ? failureReport(outcome.output) : "";
  return [
    { message: summary },
    ...shown,
    ...(rest > 0 ? [{ message: `…他 ${rest} 件の失敗` }] : []),
    ...(printed === "" ? [] : [{ message: `vitest が印字した理由:\n${indented(printed)}` }]),
  ];
}

/** テストの実行はチェックの評価より前に済んでいるので、所要時間は外から渡す。 */
export function testsCheck(
  outcome: Pick<TestOutcome, "passed" | "failed" | "total" | "failures" | "output">,
  durationMs: number,
): CheckResult {
  const violations = outcome.passed ? [] : testViolations(outcome);
  return {
    name: "tests",
    status: violations.length === 0 ? "pass" : "fail",
    durationMs,
    violations,
    scope: `${outcome.total} 件`,
  };
}

/**
 * この実行で走ったテストが**振る舞いを動かした**ソース。判定は関数が 1 つでも呼ばれたか。
 *
 * ここまで 2 段しくじっている。
 *
 * 1. **「coverage に現れた」では足りない。** vitest は `coverage.include` に合致する
 *    未ロードのファイルもゼロ行の項目として載せる（gauntlet 自身の main.ts で実測）。
 *    キーの存在で判定すると探索範囲が「include の全ファイル」に膨張した。
 * 2. **「1 文でも実行された」でも足りない。** `import` はモジュールの top-level を
 *    走らせるので、バレル（re-export）を 1 つ import しただけで、その先の全ファイルに
 *    文の実行が付く。duct では 44 行のテスト 1 本で変異対象が 18 ファイルに膨らみ、
 *    **触っていない 17 ファイルの生き残り 587 件が baseline に焼かれた**。
 *    最小再現でも `export const B = 2` だけのファイルが文 hit 1 / 関数 hit 0 になる。
 *
 * 3. **関数 hit だけでも足りない。** `--coverage.include` を渡すようになった（#6）ので、
 *    テストが 1 度もロードしていないファイルも coverage に載る。duct ではその合成エントリの
 *    一部が「文は全部 0 なのに関数 hit 1」になり、**変異対象が 18 → 700 ファイルに増えた**。
 *    最小構成では vitest 3.2.6 でも 4.1.10 でも再現できず、原因は掴めていない。
 *
 * **だから両方を要求する。** 実際に走ったなら関数の中の文も走るので、
 * `関数 hit > 0` かつ `文 hit = 0` は現実の実行では起こりえない — この AND が落とすのは
 * 計測の作り物だけで、本物を落とすことはない。
 *
 * 関数を 1 つも持たないファイル（定数だけ）はここに現れないが、そこに作れる変異は
 * static なものだけで、`--ignoreStatic` が最初から測っていない。
 */
export function coveredFiles(root: string, coverage: IstanbulCoverage): string[] {
  return Object.entries(coverage)
    .filter(
      ([, entry]) =>
        Object.values(entry.s).some((count) => count > 0) && Object.values(entry.f).some((count) => count > 0),
    )
    .map(([absolute]) => relative(root, absolute).split("\\").join("/"));
}

/**
 * 変異させる範囲。**差分そのものが上限を決める。**
 *
 * 変異は高い。teps の実測では 135 ファイル・約 23,000 変異でローカル 47 分。
 * 1 変異あたり 124ms のうち約 7 割は変異を差し替える往復のオーバーヘッドで、
 * テスト自体（11 件・38ms）は速い。回数が問題なので、範囲を絞るしかない。
 *
 * **`--changed` が選んだテストの coverage は使えない。** vitest は変更ファイルを
 * import する全テストを逆依存グラフから拾うので、`package.json` や `vitest.config.ts`
 * を触る差分では全テストが選ばれる。duct の実測では全 664 テストファイルが走り、
 * 変異対象が 520 ファイルになった。Dependabot の更新でも同じことが起きる。
 * そして gauntlet を導入する PR 自身が必ず設定ファイルを触るので、
 * **baseline の種を置くための最初の `full` が最も回らない**という形になっていた。
 *
 * 代わりに差分から直接決める:
 *
 * - **変更されたソース** — これがテストで守られているかを問うのが本題
 * - **変更されたテストが覆うソース** — assert を消しただけの差分でも、
 *   そのテストが覆うソースが対象に入る。これが無いと mutation を素通りできる（gameable）
 *
 * 変更されたテストが無ければ余分な実行そのものが要らないので、`coveredBy` は呼ばない。
 */
export function mutationScope(changed: Iterable<string>, coveredBy: (tests: string[]) => string[]): string[] {
  const files = [...changed];
  const tests = files.filter(isTestFile);
  if (tests.length === 0) return files;
  return [...new Set([...files, ...coveredBy(tests)])];
}

/**
 * 種を置いただけの回は通さない。
 *
 * `full` を CI でしか回さないと、置いた種はコンテナの中に書かれて捨てられる。
 * 毎 PR が自分の状態から許容値を置き直すことになり、**どれだけ悪化しても通る**
 * （duct で実測。導入して数回 CI を回してもファイルが履歴に無かった）。
 *
 * ファイルは書いたまま残すので、コミットすれば次から噛む。
 */
/**
 * 種を置いた回に、**ゲートごとに出す短い印**。
 *
 * baseline はゲート横断で 1 ファイルなので、起きた事象は 1 つ。説明を各ゲートに
 * 出すと、同じ 2 行が crap と duplication に並んで「別々に何かが起きた」と読める
 * （h3 の導入で指摘された）。説明は `formatResult` が最後に 1 回だけ出す。
 */
export const BASELINE_SEEDED: Violation = { message: "許容値の記録を作りました（下記）" };

export const BASELINE_NOT_COMMITTED: Violation = {
  message:
    `${BASELINE_FILENAME} を作りました。git add -A などでコミットしてください` +
    "（ファイル名を含む Bash コマンドは guard が止めます）。" +
    "履歴に無いと毎回いまの状態が許容値として置き直され、ラチェットが噛みません",
};

/**
 * 後退の報告に、差分の外にある違反を名指しで添える。
 *
 * 記録は数だけ（DESIGN §ratchet）なので、どれが増えた分かは特定できない。
 * それでも一覧が要る — 触った関数の違反は gateTouched が別に出すが、
 * テストを消して**触っていない**関数の網羅率が落ちた後退は、これが無いと
 * どの関数の話か手がかりがゼロになる。
 */
export function ratchetViolation(
  report: ReturnType<typeof analyze>,
  changed: Map<string, Set<number>>,
  outcome: { allowed: number; actual: number },
): Violation {
  const head = `リポジトリ全体の違反が ${outcome.allowed} → ${outcome.actual} に増えました`;
  const touched = new Set(touchedFunctions(report, changed));
  const outside = repositoryViolators(report).filter((fn) => !touched.has(fn));
  if (outside.length === 0) return { message: `${head}。増えた分は上の触った関数の違反です` };
  return { message: withDetails(`${head}。差分の外にある違反（増えた分と、以前から許容されている分）:`, outside.map(crapText)) };
}

/**
 * リポジトリ全体のラチェットを当て、必要なら記録を更新する。
 *
 * 改善は自動で固定する。記録し損ねると許容値が緩いまま残り、
 * あとで同じだけ悪化させても通ってしまう。
 */
export function applyRatchet(
  store: BaselineStore,
  report: ReturnType<typeof analyze>,
  changed: Map<string, Set<number>>,
): Violation[] {
  const baseline = store.load();
  const outcome = gateRepository(report, baseline);
  if (outcome.kind === "regressed") {
    return [ratchetViolation(report, changed, outcome)];
  }
  if (outcome.kind !== "ok") store.save({ ...EMPTY_BASELINE, ...baseline, crap: outcome.to });
  return outcome.kind === "seeded" ? [BASELINE_SEEDED] : [];
}

/**
 * テストが落ちていると coverage が無い（vitest は落ちると書き出さない）。
 *
 * そのまま当てると全関数が網羅率 0 と見なされ、偽の違反で本当の原因が埋もれる。
 * 通さないが、理由はテストだと言う。
 */
export const CRAP_NEEDS_TESTS: Violation = { message: "テストが落ちているため計測できません" };

/**
 * `list` が落ちるときの説明。**どのファイルかまで言う。**
 *
 * `quick` / `full` なら直前の tests チェックが落ちたテストを並べているが、
 * `list` はこの 1 行で終わるので、ファイル名が無いと切り分けの起点が無い（h3 が指摘）。
 */
export function needsTestsMessage(failures: readonly TestFailure[]): string {
  const files = [...new Set(failures.map((failure) => failure.file))];
  if (files.length === 0) return CRAP_NEEDS_TESTS.message;
  return `${CRAP_NEEDS_TESTS.message}: ${detailLines(files, DETAIL_LIMIT).join("、")}`;
}

/** gauntlet が走らせる vitest project の宣言。空 = 宣言なし（全部走らせる。DESIGN §2）。 */
export function declaredProjects(config: GauntletConfig): string[] {
  return config.tests?.projects ?? [];
}

/** include を見ずに呼べるようにする既定。テストから閾値だけを当てたいときに使う。 */
const EMPTY_REVIEW: IncludeReview = { dead: [], unmatched: [] };

/** リポジトリ全体のラチェットはフル実行のある `full` でだけ判定する。 */
export function crapViolations(
  store: BaselineStore,
  tier: TierName,
  report: ReturnType<typeof analyze>,
  changed: Map<string, Set<number>>,
): Violation[] {
  return [...gateTouched(report, changed), ...(tier === "full" ? applyRatchet(store, report, changed) : [])];
}

/**
 * 測れているか確かめてから閾値を当てる。
 *
 * テストが落ちていれば coverage が無く、設定がずれていれば対象が空になる。
 * どちらも「違反ゼロ」に見えてしまうので、先に潰す。
 */
export function crapCheckViolations(
  store: BaselineStore,
  tier: TierName,
  report: ReturnType<typeof analyze>,
  changed: Map<string, Set<number>>,
  outcome: Pick<TestOutcome, "passed" | "total">,
  includes: IncludeReview = EMPTY_REVIEW,
  unmeasured: readonly string[] = [],
): Violation[] {
  if (!outcome.passed) return [CRAP_NEEDS_TESTS];
  const faults = measurementFaults(report, outcome.total, tier === "full", includes.dead, unmeasured);
  return faults.length === 0 ? crapViolations(store, tier, report, changed) : faults;
}

/**
 * 測った範囲を関数とファイルの両方で言う。
 *
 * 範囲を決めるとき人間が数えるのは**ファイル**なので、関数の数だけ出しても
 * 突き合わせられない（h3 では 50 ファイルを数えたのに `測る対象 411` が出て、
 * 検算のために glob を自分で回す羽目になった）。追加の走査は要らない —
 * 関数を持つファイルと「関数が無くて外したファイル」で glob の結果を尽くしている。
 */
export function scopeText(report: ReturnType<typeof analyze>): string {
  const files = new Set(report.functions.map((fn) => fn.location.file)).size + report.excluded.length;
  return `${report.functions.length} 関数（${files} ファイル）`;
}

/**
 * 何を見たかを一行で。緑のときに「対象 0 件で緑」と区別するために出す。
 *
 * 1 件もマッチしない include はここに足す。**落とさないが黙らない** —
 * 綴りを 1 文字誤った include（`testt/**\/*.ts`）は、他が生きていれば緑のまま
 * 半分が測られない状態を作る（h3 で実測）。落とせない理由は `reviewIncludes` 参照。
 */
export function crapScope(
  report: ReturnType<typeof analyze>,
  changed: Map<string, Set<number>>,
  unmatched: readonly string[] = [],
): string {
  const head = `触った関数 ${touchedFunctions(report, changed).length} / 測る対象 ${scopeText(report)}`;
  if (unmatched.length === 0) return head;
  const named = unmatched.map((pattern) => `\`${pattern}\``).join("、");
  return `${head}\nsource.include の ${named} は 1 件もマッチしていません（意図した書き方なら無視してください）`;
}

function crapCheck(
  store: BaselineStore,
  tier: TierName,
  report: ReturnType<typeof analyze>,
  changed: Map<string, Set<number>>,
  outcome: Pick<TestOutcome, "passed" | "total">,
  includes: IncludeReview,
  unmeasured: readonly string[],
): CheckResult {
  return timed("crap", () => ({
    violations: crapCheckViolations(store, tier, report, changed, outcome, includes, unmeasured),
    scope: crapScope(report, changed, includes.unmatched),
  }));
}

/**
 * 変異させる対象。**測る範囲の中にあるものだけ。**
 *
 * 範囲は `mutationScope` が決めるが、そこには差分に出てきた設定ファイル
 * （`vitest.config.ts` など）も混ざる。`source.include` / `exclude` を glob で
 * 解決した一覧と突き合わせて落とす。CRAP が見ているのと同じ範囲になる。
 */
export function mutationTargets(covered: Iterable<string>, inScope: Iterable<string>): string[] {
  const scoped = new Set(inScope);
  return [...new Set(covered)].filter((file) => scoped.has(file)).sort();
}

export function countByFile(mutants: readonly { file: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const mutant of mutants) counts[mutant.file] = (counts[mutant.file] ?? 0) + 1;
  return counts;
}

const EMPTY_BASELINE = { crap: 0, mutation: {} };

/**
 * ファイル単位のラチェットを当て、記録を更新する。mutation が使う。
 *
 * 0 件を要求すると既存リポジトリはどこも導入できない（gauntlet 自身ですら
 * 生き残りが 53 件あった）。CRAP と同じく「増やさない」だけを課す。
 */
/**
 * ファイルごとの実測を記録の形に揃える。
 *
 * 「全部殺した」（報告にあり、生き残り 0）と「測られていない」（報告に無い／measured 0）は
 * 別物 — 前者は 0 を記録してよい成果で、後者は何も分かっていない。
 */
export function mutationRecords(
  targets: readonly string[],
  survived: Record<string, number>,
  measured: Record<string, number>,
  timeout: Record<string, number>,
): Record<string, MutationRecord> {
  return Object.fromEntries(
    targets
      // **測った実体のあるファイルだけ。** 候補に入っても Stryker の報告に現れない・
      // 全部が NoCoverage/Ignored で measured 0、というファイルに 0/0/0 を作ると、
      // それが「実測」として記録され、負債が消える（#27）。報告に無い = 知らない、で通す。
      .filter((file) => (measured[file] ?? 0) > 0)
      .map((file) => [
        file,
        { survived: survived[file] ?? 0, measured: measured[file] ?? 0, timeout: timeout[file] ?? 0 },
      ]),
  );
}

/**
 * 生き残りが増えたことの説明。**測った数を添える。**
 *
 * 同じなら「テストが弱くなった」、増えていれば旧記録（余裕を計算できない）が原因なので、
 * 読み手が増加の理由を区別できる（テストを足しただけで落ちた h3/duct の切り分けに、
 * この情報が無くて Stryker の単体実行までやらせてしまった）。
 */
export function regressionText(entry: FileRatchet["regressed"][number]): string {
  const measured = `測った変異 ${entry.measuredBefore ?? "記録なし"} → ${entry.measuredNow ?? 0}`;
  // 打ち切りも言う。閾値は実行速度に比例するので、「遅くなるだけの変異」は速い機械で
  // Timeout・遅い CI で Survived になる — 生き残りだけ見ると「テストが弱くなった」と
  // 誤読する（実際に誤読され、原因に辿るには CI から mutation.json を持ち帰るしかなかった）。
  const timeout = `打ち切り ${entry.timeoutBefore ?? "記録なし"} → ${entry.timeoutNow ?? 0}`;
  return `テストを通り抜ける変異が ${entry.allowed} → ${entry.actual} に増えました（${timeout}、${measured}）  ${entry.file}`;
}

function gateByFile(
  store: BaselineStore,
  key: "mutation",
  targets: readonly string[],
  counts: Record<string, MutationRecord>,
  describe: (entry: FileRatchet["regressed"][number]) => string,
): Violation[] {
  const baseline = store.load() ?? EMPTY_BASELINE;
  const { regressed, updated } = ratchetByFile(baseline[key], targets, counts);
  store.save({ ...baseline, [key]: updated });
  return regressed.map((entry) => ({ message: describe(entry), file: entry.file }));
}

/**
 * 何を変異させ、何を測らなかったか。
 *
 * `--ignoreStatic` で外した分を黙って落とすと、緑が「弱いテストが無い」ではなく
 * 「そこは見ていない」を意味していることが読み手に伝わらない。
 */
export function mutationScopeText(
  targets: number,
  ignored: IgnoredBreakdown,
  untested = 0,
  excluded: readonly string[] = [],
): string {
  const bare = untested === 0 ? "" : `（テストが触れない ${untested} ファイルは対象外 — 網羅率 0 は CRAP が見る）`;
  // 静的な除外と意図的な除外を分けて数える。混ぜると、意図的に外した総数を誰も知れない
  // （「見えていれば人が気づける」を軸に disable 方式を選んだのに、そこだけ見えなくなる）。
  const parts = [
    ...(ignored.static > 0 ? [`静的な変異 ${ignored.static} 件`] : []),
    ...(ignored.declared > 0 ? [`宣言して外した変異 ${ignored.declared} 件`] : []),
  ];
  const skipped = parts.length === 0 ? "" : `（${parts.join("・")}は測っていません）`;
  // 理由必須は原則。落としはしないが、破れは件数で言う。
  const bare2 =
    ignored.unexplained === 0 ? "" : `（理由の無い Stryker disable が ${ignored.unexplained} 件あります — 理由を書いてください）`;
  const dropped = excluded.length === 0 ? "" : `（${excluded.join("、")} の変異は Stryker が置けないので測っていません）`;
  return `変異対象 ${targets} ファイル${bare}${skipped}${bare2}${dropped}`;
}

/** 一覧の 1 行に収める。変異後のコードは複数行のことがある。 */
export function oneLine(text: string, max: number): string {
  const flat = text
    .split("\n")
    .map((part) => part.trim())
    .join(" ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** どの行のどんな変異が通り抜けたか。Stryker の再実行（分単位）なしで正体が分かる形に。 */
export function describeSurvivor(mutant: SurvivedMutant): string {
  const replacement = mutant.replacement === null ? "" : `  → ${oneLine(mutant.replacement, 60)}`;
  return `L${mutant.line} ${mutant.mutator}${replacement}`;
}

/** 差分に関係するソースだけを変異させる。既存リポジトリ全体を一度に赤にしない。 */
function mutationCheck(
  store: BaselineStore,
  root: string,
  config: GauntletConfig,
  covered: Iterable<string>,
  tested: ReadonlySet<string>,
  notify: Notify,
): CheckResult {
  const inScope = mutationTargets(covered, listSourceFiles(root, config.source));
  // テストが 1 つも触れないファイルは変異させない。全変異が NoCoverage（数えない —
  // 網羅率 0 は CRAP の担当）になる上、Stryker は「No tests were executed」で
  // 落ちる（gauntlet 自身の main.ts だけの差分で実測）。外した数は scope に出す。
  const targets = inScope.filter((file) => tested.has(file));
  const untested = inScope.length - targets.length;
  return timed("mutation", () => {
    requireMutationTools(root);
    if (targets.length === 0)
      return { scope: mutationScopeText(0, { static: 0, declared: 0, unexplained: 0 }, untested), violations: [] };
    // 一番長い段。件数が分かれば時間の見積もりが立つ。書き換えの予告も兼ねる —
    // `--inPlace` は実ファイルを書き換えるので、途中で止めると計装が残る（duct で実測）。
    notify(`mutation 変異対象 ${targets.length} ファイル。作業ツリーを一時的に書き換えます`);
    const { survived, ignored, excluded, measured, timeout } = runMutation(root, targets, declaredProjects(config));
    return {
      // 測らなかった分を黙って落とさない。static な変異は `--ignoreStatic` で外している。
      scope: mutationScopeText(targets.length, ignored, untested, excluded),
      violations: gateByFile(store, "mutation", targets, mutationRecords(targets, countByFile(survived), measured, timeout), (entry) =>
        withDetails(
          regressionText(entry),
          survived.filter((mutant) => mutant.file === entry.file).map(describeSurvivor),
        ),
      ),
    };
  });
}

/**
 * 重複はリポジトリ全体の 1 つの数（重複トークン）を crap と同じ ratchet で見る。
 *
 * ファイル単位にしないのは、クローンがファイルの対に跨るため — どちらの件数に
 * 数えるかという割り付けの判断を増やさずに済む。絶対閾値も持たない（既存リポジトリを
 * 導入初日に赤で埋めない）。「増やさない」だけを課し、減れば自動で締まる。
 */
export function duplicationViolations(store: BaselineStore, actual: number): Violation[] {
  const baseline = store.load();
  const allowed = baseline?.duplication;
  // 0.11.0 より前の baseline にはこの欄が無い。種を置いた回は通さない（crap と同じ理由）。
  if (allowed === undefined) {
    store.save({ ...EMPTY_BASELINE, ...baseline, duplication: actual });
    return [BASELINE_SEEDED];
  }
  const outcome = ratchetNumber(allowed, actual);
  if (outcome.kind === "regressed") {
    return [{ message: `重複が ${outcome.allowed} → ${outcome.actual} トークンに増えました` }];
  }
  if (outcome.kind === "improved") store.save({ ...EMPTY_BASELINE, ...baseline, duplication: outcome.to });
  return [];
}

function duplicationCheck(store: BaselineStore, root: string, config: GauntletConfig): CheckResult {
  return timed("duplication", () => {
    // **渡した数を出す。** jscpd の `sources` は「min-tokens 以上あってクローンに
    // 参加しうるファイル数」で、渡した数ではない（duct で 794 → 760）。同じ実行の
    // crap 行と食い違って「範囲が黙って狭いのでは」と誤診させた。
    const files = listSourceFiles(root, config.source);
    const { duplicatedTokens } = runDuplication(root, files);
    return {
      scope: `重複 ${duplicatedTokens} トークン / 対象 ${files.length} ファイル`,
      violations: duplicationViolations(store, duplicatedTokens),
    };
  });
}

export function formatResult(result: TierResult): string {
  const lines = result.checks.map((check) => {
    const mark = check.status === "pass" ? "✓" : "✗";
    // 複数行の違反（tsc の診断、詳細つきの違反）も 2 行目以降ごと段に入れる。
    // 先頭行しか下げないと、詳細がチェックの木から外れて見える。
    const detail = check.violations.map((violation) => `\n    ${violation.message.split("\n").join("\n    ")}`).join("");
    // scope も複数行になりうる（マッチ 0 件の include）。違反と同じ段に入れる。
    const scope = check.scope.split("\n").join("\n    ");
    return `  ${mark} ${check.name} (${check.durationMs.toFixed(0)}ms)  ${scope}${detail}`;
  });
  const header = `gauntlet ${result.tier}: ${result.status} (${result.durationMs.toFixed(0)}ms)`;
  // 種置きは 1 つの事象。ゲートの数だけ説明を並べない。
  const seeded = result.checks.some((check) =>
    check.violations.some((violation) => violation.message === BASELINE_SEEDED.message),
  );
  const footer = seeded ? [BASELINE_NOT_COMMITTED.message] : result.notes;
  return [header, ...lines, ...(footer.length === 0 ? [] : ["", ...footer])].join("\n");
}

/** 自分で名づけているエラー。メッセージが一行の説明そのものになっている。 */
const EXPECTED_ERRORS = new Set(["ConfigError", "GitError", "RunnerError"]);

/**
 * gauntlet 自身が走れなかったときの報告。
 *
 * 既知のエラー（設定・git・道具）はメッセージだけで直せる。未知のエラーは
 * gauntlet 自身のバグなので、メッセージだけだと読み手は直しようがない —
 * 場所（スタック）ごと出す。
 */
export function describeCrash(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return EXPECTED_ERRORS.has(error.name) ? error.message : (error.stack ?? error.message);
}

/** tier はサブコマンド名から確定して渡される（`gauntlet quick` / `gauntlet full`）。 */
export function run(tier: TierName, cwd: string, notify?: Notify): { output: string; result: TierResult } {
  const result = runTier(cwd, tier, notify);
  return { output: formatResult(result), result };
}

/**
 * 一覧の見た目。**悪い順**に並べ、baseline の数と突き合わせられる形にする。
 *
 * 件数を切らない（`withDetails` の 10 件上限を使わない）。**全部見るための出力**なので、
 * ここで切ると baseline の数と合わなくなり、何のための一覧か分からなくなる。
 */
export function formatViolators(
  violators: readonly FunctionReport[],
  scope: string,
  allowed: number | null,
): string {
  const worstFirst = [...violators].sort((a, b) => crap(b.cc, b.coverage) - crap(a.cc, a.coverage));
  const record = allowed === null ? `${BASELINE_FILENAME} はまだありません` : `${BASELINE_FILENAME} の許容 ${allowed}`;
  const head = `CRAP 違反 ${violators.length} 件 / 測る対象 ${scope}（${record}）`;
  return [head, ...worstFirst.map((fn) => `  ${crapText(fn)}`)].join("\n");
}

/**
 * 4 つのゲートのうち、**導入時に一度も動かないもの**を動かして確かめる。
 *
 * `full` の mutation は差分から対象を決めるので、導入コミット（設定ファイルだけ）では
 * 必ず「変異対象 0 ファイル」で緑になる。道具が揃っていること（`requireMutationTools`）と
 * **その道具が対象リポジトリの vitest を起動できること**は別で、後者は最初に src を
 * 触る PR の CI まで分からなかった（h3 が指摘）。
 *
 * 変異は作らない（Stryker の `--dryRunOnly`）ので、確かめるのは疎通だけ。
 */
export function doctor(root: string): string[] {
  const config = loadConfig(root);
  return dryRunMutation(root, listSourceFiles(root, config.source), declaredProjects(config));
}

/**
 * 記録している mutation の生き残り。**Stryker は回さない。**
 *
 * 数はもう記録の中にあるので、出すのはただの読み出し。どの変異かまでは
 * フル実行が要るので、そこは在り処だけ言う（`list` の性格を変えないため）。
 */
export function mutationDebt(root: string, baseline: Baseline | null): string {
  // 消えたファイルの記録は残り続ける（ratchet は締める方向にしか動かず、
  // 対象から外れたファイルは二度と触られない）。並べると存在しないファイルを
  // 探しに行かせるので、今あるものだけ出す。
  const counts = Object.entries(baseline?.mutation ?? {})
    .map(([file, record]) => [file, record.survived] as const)
    .filter(([file, n]) => n > 0 && existsSync(join(root, file)));
  if (counts.length === 0) return "";
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const worstFirst = [...counts].sort(([, a], [, b]) => b - a);
  return [
    `\n記録している mutation の生き残り ${total} 件（${counts.length} ファイル）:`,
    ...worstFirst.map(([file, n]) => `  ${String(n).padStart(4)}  ${file}`),
    `  どの変異かは、そのファイルを差分に入れて full を回すと ${REPORT_PATH} に出ます`,
  ].join("\n");
}

export function violatorReport(
  report: ReturnType<typeof analyze>,
  outcome: Pick<TestOutcome, "passed" | "total" | "failures">,
  allowed: number | null,
  dead: readonly DeadInclude[] = [],
): string {
  // 測れていない状態で「違反 0 件」と言わない。`full` と同じ検査を先に通す。
  if (!outcome.passed) throw new RunnerError(needsTestsMessage(outcome.failures));
  const faults = measurementFaults(report, outcome.total, true, dead);
  if (faults.length > 0) throw new RunnerError(faults[0]!.message);
  return formatViolators(repositoryViolators(report), scopeText(report), allowed);
}

/**
 * baseline が今許容している CRAP 違反と mutation の生き残りを全部並べる。**ゲートではない。**
 *
 * ratchet は数しか記録しないので、`{ "crap": 35 }` から「どの 35 件か」に辿れなかった
 * （h3 の導入報告。手で coverage を取り直して未参照コードと網羅率 0 の公開 API を
 * 見つけている）。赤を減らす作業に取りかかるには、この一覧が要る。
 * 判断は `violatorReport` と `mutationDebt` にある。ここはプロセスとファイルを触るだけの殻。
 */
export function listViolators(root: string): string {
  const config = loadConfig(root);
  const outcome = runTests(root, null, declaredProjects(config), [], config.source.include);
  const baseline = loadBaseline(root);
  const crap = violatorReport(
    analyze(root, config, outcome.coverage),
    outcome,
    baseline?.crap ?? null,
    reviewIncludes(root, config.source).dead,
  );
  return `${crap}${mutationDebt(root, baseline)}`;
}
