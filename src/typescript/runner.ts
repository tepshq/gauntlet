/**
 * vitest の実行。
 *
 * **vitest の exit code は使わない。** プロジェクトが coverage 閾値を設定していると、
 * 部分実行は必ずそれを下回って exit 1 になる（hue で実測）。しきい値の上書きは
 * glob キー付きの設定には効かないので、テスト結果と coverage を別経路で取る。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { capture } from "../exec.ts";
import { type PackageManager, detectPackageManager, installDevCommand } from "../package-manager.ts";
import type { IstanbulCoverage } from "./coverage.ts";

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

/** gauntlet が使う coverage provider。v8 はエンジン内蔵の計測で、コードを書き換えない。 */
const COVERAGE_PROVIDER = "@vitest/coverage-v8";

/**
 * coverage provider を入れる 1 行。**版を人間に計算させない。**
 *
 * `@vitest/coverage-v8` は vitest の**完全一致**を peer に要求する
 * （`peer vitest@"3.2.7"` — 範囲ではない）。しかも vitest 側は provider を
 * peer 宣言していないので npm は必要性すら知らず、版無しで入れると最新が来て
 * ERESOLVE で install ごと失敗する（duct で実測）。
 *
 * 正解の版は「入っている vitest」なので gauntlet が読める。読めるものを
 * 人間に `node -p` で取り出させるのは、判定できることを渡していない。
 */
export function coverageInstallCommand(pm: PackageManager, vitestVersion: string | null): string {
  const spec = vitestVersion === null ? COVERAGE_PROVIDER : `${COVERAGE_PROVIDER}@${vitestVersion}`;
  return installDevCommand(pm, [spec]);
}

/** node_modules に**実際に入っている** vitest の版。`^` 解決後の値が要る。 */
export function installedVitestVersion(root: string): string | null {
  try {
    // Stryker disable next-line StringLiteral: encoding を外しても Buffer が
    // JSON.parse に渡って同じ結果になるため、区別できる振る舞いが無い。
    const pkg = readFileSync(join(root, "node_modules", "vitest", "package.json"), "utf8");
    return (JSON.parse(pkg) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * provider が無いまま走らせない。
 *
 * 無いと vitest は「MISSING DEPENDENCY」を吐いて coverage を書かず、gauntlet 側は
 * 「vitest の実行結果を読めません」という**下位ツールの生エラー**になる。
 * 原因（provider が無い）と直し方（この 1 行）を先に言う。
 */
export function requireCoverageProvider(root: string): void {
  if (existsSync(join(root, "node_modules", COVERAGE_PROVIDER))) return;
  const command = coverageInstallCommand(detectPackageManager(root), installedVitestVersion(root));
  throw new RunnerError(
    `coverage provider（${COVERAGE_PROVIDER}）が入っていません。次で入れてください:\n  ${command}`,
  );
}

/** テスト 1 件分の結果。`fullName` は `describe > it` を連結した全名。 */
interface VitestAssertion {
  fullName?: string;
  status: string;
  failureMessages?: string[];
}

/** ファイル 1 つ分の結果。`message` はファイル自体が落ちたとき（import エラー等）の本文。 */
interface VitestFileResult {
  name: string;
  status: string;
  message?: string;
  assertionResults?: VitestAssertion[];
}

/** vitest の JSON reporter が返すもののうち、判定に使う部分。 */
export interface VitestJsonReport {
  success: boolean;
  numTotalTests: number;
  numFailedTests: number;
  testResults?: VitestFileResult[];
}

/**
 * 落ちたテスト 1 件分。
 *
 * ファイル名だけだと、読み手は理由を知るためにテストをもう一周回すしかない。
 * vitest の JSON には理由（assert の期待値と実際）が既にあるので、ここで残す。
 */
export interface TestFailure {
  /** リポジトリ相対。 */
  file: string;
  /** `describe > it` の全名。ファイル自体が落ちた（import エラー等）なら null。 */
  test: string | null;
  /** vitest が報告した失敗の本文。スタックを含むことがある（削るのは表示側）。 */
  message: string;
}

export interface TestOutcome {
  passed: boolean;
  total: number;
  failed: number;
  failures: TestFailure[];
  coverage: IstanbulCoverage;
  /** vitest が人向けに印字した出力。JSON 側に理由が無いときの最後の手がかり。 */
  output: string;
}

/**
 * 出力が無いときは vitest の出力を添える。
 *
 * 原因はほぼ常にそこに書かれている（依存の欠落、設定の誤りなど）。
 * 握り潰すと「ファイルがありません」だけが残り、辿れなくなる。
 */
function readJson<T>(path: string, what: string, output: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new RunnerError(`${what}を読めません。vitest の出力:\n${lastLines(output, 15)}`);
  }
}

export function lastLines(text: string, count: number): string {
  return text.split("\n").slice(-count).join("\n").trim();
}

/** vitest は絶対パスで報告する。差分や baseline と同じリポジトリ相対に揃える。 */
function relativeName(root: string, path: string): string {
  return (isAbsolute(path) ? relative(root, path) : path).split("\\").join("/");
}

/**
 * ファイル 1 つ分の失敗を取り出す。
 *
 * 落ちた assert が 1 つも無いのに status が failed なのは、ファイル自体が
 * 落ちた形（import エラー、構文エラー等）。そのときの本文はファイル側の
 * `message` にしか無い。
 */
function fileFailures(result: VitestFileResult, root: string): TestFailure[] {
  const file = relativeName(root, result.name);
  // Stryker disable next-line ArrayDeclaration: 既定値に何を入れても
  // 直後の filter が status を見て落とすので、区別できる振る舞いが無い。
  const failed = (result.assertionResults ?? []).filter((assertion) => assertion.status === "failed");
  if (failed.length === 0) return [{ file, test: null, message: result.message ?? "" }];
  return failed.map((assertion) => ({
    file,
    test: assertion.fullName ?? null,
    message: assertion.failureMessages?.[0] ?? "",
  }));
}

/** vitest の JSON reporter の出力から、判定に使う部分だけ取り出す。 */
export function toOutcome(report: VitestJsonReport, root: string): Omit<TestOutcome, "coverage" | "output"> {
  return {
    passed: report.success && report.numFailedTests === 0,
    total: report.numTotalTests,
    failed: report.numFailedTests,
    // Stryker disable next-line ArrayDeclaration: 既定値に何を入れても
    // 直後の filter が status を見て落とすので、区別できる振る舞いが無い。
    failures: (report.testResults ?? [])
      .filter((result) => result.status === "failed")
      .flatMap((result) => fileFailures(result, root)),
  };
}

/**
 * `projects` は gauntlet が走らせる vitest project の宣言（`tests.projects`）。
 *
 * **正の選択。** gauntlet に「外部サービスを要するテスト」という概念は無い —
 * 開発者が「これが gauntlet の世界のテスト」と宣言し、宣言に無い project は
 * 実行も coverage も mutation もされない。空なら全部走らせる（project を
 * 使っていないリポジトリはこちら）。
 *
 * **glob の `--exclude` ではなく project 名なのは、`--exclude` が vitest の
 * `projects` に伝わらないため**（duct で実測）。project は vitest が選択を
 * 正しく解釈する唯一の一級境界。
 */
export function vitestArgs(
  base: string | null,
  outDir: string,
  projects: readonly string[],
  files: readonly string[] = [],
  include: readonly string[] = [],
): string[] {
  const args = ["vitest", "run", "--coverage", "--coverage.provider=v8", "--coverage.reporter=json"];
  // **測る範囲は gauntlet の宣言で決める。** 渡さないとリポジトリの `coverage.include`
  // 次第で、範囲に入れたのに coverage に現れないファイルが出る。それは網羅率 0% と
  // 区別がつかず、テストを書いても直らない赤になる（h3 で実測）。
  // これで「full の coverage に現れない = リポジトリの coverage.exclude が消した」に絞れる。
  args.push(...include.map((glob) => `--coverage.include=${glob}`));
  args.push(...projects.map((name) => `--project=${name}`));
  if (base !== null) args.push(`--changed=${base}`);
  args.push(`--coverage.reportsDirectory=${join(outDir, "coverage")}`);
  // json は判定用、default は人（とエージェント）向け。**両方要る** — vitest の JSON は
  // timeout の理由を `STACK_TRACE_ERROR` に差し替えることがあり、機械可読な側だけでは
  // 「落ちた」以外が伝わらない（h3 で実測）。--outputFile は json 側にだけ効く。
  args.push("--reporter=json", "--reporter=default", `--outputFile=${join(outDir, "result.json")}`);
  // 位置引数はテストファイルの絞り込み。フラグの後ろに置く。
  args.push(...files);
  return args;
}

/**
 * テストを走らせて、結果と coverage を返す。
 *
 * `base` を渡すとその起点以降の変更に関係するテストだけを走らせる。
 * `--changed` は変更ファイルを import する全テストをモジュールグラフから選ぶので、
 * 変更ファイルの coverage はこれで完全になる。
 *
 * `files` を渡すとそのテストファイルだけを走らせる。どのソースを覆っているかを
 * 知るために使う（`mutationScope`）。`base` とは併用しない。
 * 渡したテストが全部宣言外の project で選択が 0 件になっても、特別扱いは要らない
 * — vitest は `success: false` を返すが、呼び出し元は coverage しか読まず、
 * coverage は空に潰れる（duct の vitest 3.2.7 で実測）。
 */
export function runTests(
  root: string,
  base: string | null,
  projects: readonly string[],
  files: readonly string[] = [],
  include: readonly string[] = [],
): TestOutcome {
  requireCoverageProvider(root);
  const outDir = mkdtempSync(join(tmpdir(), "gauntlet-"));
  try {
    // exit code は握り潰す。閾値違反とテスト失敗が区別できないため。
    const { combined } = capture("npx", vitestArgs(base, outDir, projects, files, include), root);
    const report = readJson<VitestJsonReport>(join(outDir, "result.json"), "vitest の実行結果", combined);
    const outcome = toOutcome(report, root);

    // **テストが落ちていれば coverage は無い。** vitest はテストが落ちると
    // coverage を書き出さない。ここで coverage の不在を報告すると、
    // 本当の原因（テストが落ちた）が見えなくなる。
    if (!outcome.passed) return { ...outcome, coverage: {}, output: combined };

    const path = join(outDir, "coverage", "coverage-final.json");
    return { ...outcome, coverage: readJson<IstanbulCoverage>(path, "coverage-final.json", combined), output: combined };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
