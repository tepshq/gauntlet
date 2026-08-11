/**
 * 導入。置くのは薄いファイルだけで、ロジックは全てパッケージ側に残す。
 *
 * 生成物が薄いほど「更新」は npm のバージョンを上げるだけで済む。
 * 再生成も差分適用も managed block も持たない。
 *
 * **CI の workflow は置かない。** 以前は雛形を書いていたが、CI が要るものは
 * gauntlet からは見えない（サービスコンテナ、マイグレーション、Node のバージョン、認証）。
 * duct では生成された workflow が既存 CI と重複した上、Postgres も migrate も無く、
 * それを手で足したら `init` の再実行で消える形になっていた。
 * 「1 行足す先」は skill が案内する。CI について知っている場所を 1 つに保つ。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILENAME, ConfigError, type GauntletConfig } from "./config.ts";

export interface InitOptions {
  defaultBranch: string;
  include: string[];
  exclude: string[];
  /** gauntlet が走らせる vitest project の宣言。空 = 宣言なし（全部走らせる）。 */
  testProjects: string[];
}

export const INIT_DEFAULTS: InitOptions = {
  defaultBranch: "main",
  include: ["src/**/*.ts"],
  // テストは gauntlet が自動で外すので、既定の除外は無い（0.20.0）。
  // 既定に書いておくと「テストは自分で外すもの」と読ませてしまう。
  exclude: [],
  testProjects: [],
};

/**
 * config を組み立てる。**フラグで管理しないキーは既存から引き継ぐ。**
 *
 * `commands.typecheck` は `init` にフラグが無く、skill が「手で書く」と案内している。
 * 全上書きにしていた頃は、範囲を直すために `init` を叩き直すと**黙って消えた** —
 * teps のような 2 パス型チェックのリポジトリでは、既定の `tsc --noEmit` に落ちて
 * 半分しか見ないまま緑になる。settings.json / .gitignore と同じくマージする。
 */
function configFor(options: InitOptions, existing: GauntletConfig | null): GauntletConfig & { $schema: string } {
  return {
    $schema: "./node_modules/@teps/gauntlet/schema/gauntlet.config.schema.json",
    schemaVersion: 1,
    adapter: "typescript",
    runner: "vitest",
    defaultBranch: options.defaultBranch,
    source: { include: options.include, ...(options.exclude.length === 0 ? {} : { exclude: options.exclude }) },
    ...(options.testProjects.length === 0 ? {} : { tests: { projects: options.testProjects } }),
    ...(existing?.commands === undefined ? {} : { commands: existing.commands }),
  };
}

/** 既存 config。読めなければ null（壊れていても init は進む — 書き直せば直るので）。 */
function existingConfig(root: string): GauntletConfig | null {
  const raw = readIfPresent(root, CONFIG_FILENAME);
  // Stryker disable next-line ConditionalExpression: 早期 return を外しても
  // JSON.parse(null) は "null" を読んで null を返すので、結果が変わらない。
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as GauntletConfig;
  } catch {
    return null;
  }
}

/**
 * `PreToolUse` を 2 つ置く。**どちらも配線が要らない** —
 * `.claude/settings.json` はコミットで伝播するので、clone した全員に効く。
 *
 * 1. **guard** — baseline の書き換えを止める（即断）
 * 2. **`quick`** — `git commit` の直前に走り、赤なら exit 2 でコミットさせない。
 *    exit 2 の stderr は「ツール呼び出しをブロックした理由」としてエージェントに
 *    構造的に届く。git の pre-commit だと gauntlet の出力が git の失敗に埋もれる。
 *
 * 起動点の変遷: 0.12 まで `Stop`（毎ターン。遅いリポジトリで成立せず、
 * 8 回連続ブロックでキャップがかかる穴もある）→ 0.13 は git の pre-commit
 * （`core.hooksPath` の配線が clone ごとに要り、忘れた人には静かに効かない）
 * → 0.14 で `PreToolUse` に集約（DESIGN §2）。
 * 0.13 以前から入れているリポジトリは `.githooks/` と `core.hooksPath` を外してよい。
 */
const HOOKS = {
  PreToolUse: [
    {
      matcher: "Edit|Write|NotebookEdit|Bash",
      hooks: [{ type: "command", command: "npx gauntlet guard" }],
    },
    {
      // `if` は Claude Code の permission rule 構文で、コマンドの中身まで見る。
      // 先頭の変数代入を除き、`&&` で繋いだ各コマンドも `$()` の中も検査するので、
      // gauntlet 側でコマンドを解析する必要が無い（一度自前で書いて捨てた）。
      matcher: "Bash",
      hooks: [{ type: "command", if: "Bash(git commit *)", command: "npx gauntlet quick" }],
    },
  ],
};

/**
 * skill の正本は **リポジトリ直下の `skills/gauntlet-setup/SKILL.md`**（0.17.0）。
 *
 * `init` はもう skill を書かない。配布は `npx skills add tepshq/gauntlet -a claude-code`
 * が担う（skills エコシステム）。0.16 までは init が生成していたが、その成果物を
 * skills CLI が拾うという循環になっていた。gauntlet 自身が配る道具と、gauntlet の
 * 使い方を教える文書は、別の経路で配って構わない — 前者は npm、後者は skills。
 */

/**
 * gauntlet と、それが呼ぶ道具が残す作業ファイル。
 *
 * `coverage/` と `.stryker-tmp/` は実行のたびに作られる。放っておくと
 * 導入した全リポジトリで未追跡のゴミになるので、こちらで面倒を見る。
 * `*.tsbuildinfo` は既定の型チェック（`tsc --noEmit --incremental`）の検査キャッシュ。
 */
const IGNORED = ["coverage/", "reports/", ".stryker-tmp/", "*.tsbuildinfo"];

/**
 * 既にある行は足さない。既存の .gitignore を並べ替えたり消したりもしない。
 *
 * **末尾の `/` は無視して突き合わせる。** `coverage` は（ディレクトリにも当たるので）
 * `coverage/` を含む。h3 には元から `coverage` があり、そこへ `coverage/` を足していた —
 * 動作は同じでも、読んだ人に「なぜ 2 回書くのか」と思わせる（h3 の導入で指摘された）。
 */
function samePattern(line: string, entry: string): boolean {
  const bare = (pattern: string): string => pattern.replace(/\/$/, "");
  return bare(line.trim()) === bare(entry);
}

export function mergeGitignore(existing: string | null): string {
  const current = existing ?? "";
  const lines = current.split("\n");
  const missing = IGNORED.filter((entry) => !lines.some((line) => samePattern(line, entry)));
  if (missing.length === 0) return current;
  const head = current === "" ? "" : `${current.replace(/\n+$/, "")}\n\n`;
  return `${head}# gauntlet の出力\n${missing.join("\n")}\n`;
}

type Settings = { hooks?: Record<string, unknown[]> };

/**
 * 読めない settings.json は、生の SyntaxError ではなく直せる文言で落とす。
 *
 * 既存の設定を推測で捨てるくらいなら止まる方がいい（フックが 1 つ消えれば、
 * そのリポジトリのゲートが黙って無効になる）。ファイルはまだ書いていない。
 */
function parseSettings(raw: string): Settings {
  try {
    return JSON.parse(raw) as Settings;
  } catch (error) {
    throw new ConfigError(
      `.claude/settings.json が JSON として読めません: ${(error as Error).message}\n` +
        "コメントや末尾のカンマがあれば外してください（Claude Code の設定は厳密な JSON です）。",
    );
  }
}

/**
 * 既にあるフックを消さずに足す。他の用途で使っている設定を壊さない。
 *
 * **同じものは二度足さない。** `init` は測る範囲を直すたびに叩かれるので、
 * 積み上げるとフックが多重に登録され、毎ターン gauntlet が何度も走ることになる。
 */
export function mergeSettings(existing: string | null): string {
  const settings: Settings = existing === null ? {} : parseSettings(existing);
  const hooks = settings.hooks ?? {};
  for (const [event, entries] of Object.entries(HOOKS)) {
    const current = hooks[event] ?? [];
    const known = new Set(current.map((entry) => JSON.stringify(entry)));
    hooks[event] = [...current, ...entries.filter((entry) => !known.has(JSON.stringify(entry)))];
  }
  return `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`;
}

/**
 * 置いたファイルと、それに**何をしたか**。
 *
 * パスだけ並べると、読み手は「自分の settings.json は上書きされたのか」を
 * 出力から判断できない（4 ファイルで振る舞いが 3 種類ある）。
 */
export interface WrittenFile {
  path: string;
  note: string;
}

function write(root: string, path: string, contents: string, note: string): WrittenFile {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return { path, note };
}

/** 既存があれば「更新」。gauntlet が所有するファイル（config / skill）用。 */
function madeOrUpdated(before: unknown): string {
  return before === null ? "作成" : "更新";
}

/** .gitignore は足りない行だけ足す。何行足したかを言うと、読み手が確かめられる。 */
function gitignoreNote(before: string | null, after: string): string {
  if (before === null) return "作成";
  if (before === after) return "変更なし";
  return `更新（${after.split("\n").length - before.split("\n").length} 行追加）`;
}

function readIfPresent(root: string, path: string): string | null {
  try {
    // Stryker disable next-line StringLiteral: encoding を外しても Buffer が
    // JSON.parse に渡って同じ結果になるため、区別できる振る舞いが無い。
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}


/**
 * init の出力。**判断も体裁もここで決める** — main.ts には書くだけを残す
 * （薄いまま保てば、テストできない場所に判断が溜まらない）。
 */
export function formatInit(result: InitResult): string {
  const width = Math.max(...result.files.map((file) => file.path.length));
  const listed = result.files.map((file) => `  ${file.path.padEnd(width)}  ${file.note}`).join("\n");
  // 案内するのは、まだ範囲が決まっていないときだけ。設定済みのリポジトリを
  // 更新した回に出すと雑音になる。
  const next = result.needsSetup
    ? "\n次: Claude Code で /gauntlet-setup を実行してください\n" +
      "（無ければ npx skills add tepshq/gauntlet -a claude-code で入ります）\n"
    : "";
  return `${listed}\n${next}`;
}


export interface InitResult {
  files: WrittenFile[];
  /** config を新しく作った = 範囲がまだ決まっていない。次の一歩を案内する。 */
  needsSetup: boolean;
}

/**
 * config を書くか、既存を守るか。
 *
 * **`options` が null（フラグ無し）で既存があれば触らない。** ここを既定値で
 * 上書きしていたため、新しいフックを取り込もうと `init` を叩き直した人が
 * 測る範囲を `src/**` に戻される事故があった（`commands` 消失と同じ形）。
 * 範囲を書き換えるのは、範囲を指定して呼ばれたときだけ。
 *
 * 壊れて読めない config も残す — 上書きすると手書きの範囲が消える。
 * 読めない config は実行時に ConfigError で落ちるので、黙って進むことはない。
 */
function configFile(root: string, options: InitOptions | null): WrittenFile {
  const raw = readIfPresent(root, CONFIG_FILENAME);
  if (options === null && raw !== null) return { path: CONFIG_FILENAME, note: "変更なし" };
  const existing = existingConfig(root);
  const note = existing?.commands === undefined ? madeOrUpdated(raw) : "更新（commands は残しました）";
  return write(root, CONFIG_FILENAME, `${JSON.stringify(configFor(options ?? INIT_DEFAULTS, existing), null, 2)}\n`, note);
}

/**
 * 骨組みを置く。**`options` が null なら範囲は決めない**（既存の config を守る）。
 *
 * 範囲を決めるのは skill の仕事で、決まった値をフラグで渡してもう一度叩く。
 * 測った件数はここでは出さない — 検算は `quick` の scope 行が担う
 * （skill の完了条件がそれを見ている。二重に出すと基準が 2 つになる）。
 */
export function init(root: string, options: InitOptions | null = null): InitResult {
  const settings = readIfPresent(root, ".claude/settings.json");
  const gitignore = readIfPresent(root, ".gitignore");
  const merged = mergeGitignore(gitignore);
  // 設定は書く前に全部読む。読めない settings.json ならここで落ち、1 つも書かずに済む。
  const settingsAfter = mergeSettings(settings);
  const config = configFile(root, options);

  return {
    files: [
      config,
      write(root, ".claude/settings.json", settingsAfter, settings === null ? "作成" : "更新（既存の設定は残しました）"),
      write(root, ".gitignore", merged, gitignoreNote(gitignore, merged)),
    ],
    // 範囲を指定して呼ばれたなら、もう決まっている。案内が要るのは
    // 「骨組みだけ置いて、範囲がまだ既定値」の状態。
    needsSetup: options === null && config.note === "作成",
  };
}

/** init が受け取るフラグ。ここに無いものは素通しさせない。 */
const INIT_FLAGS = ["default-branch", "include", "exclude", "test-projects"] as const;

export const INIT_USAGE = `gauntlet init [フラグ]

  --default-branch=<branch>       差分の起点になるブランチ
  --include=<glob,glob>           測る対象。ファイルを名指しする形で書く
                                  （<dir> ではなく '<dir>/**/*.ts'）
  --exclude=<glob,glob>           測る対象から外すもの
  --test-projects=<name,name>     走らせる vitest project の宣言（省略 = 全部）

フラグ無しなら骨組みの整備だけで、既存の測る範囲には触りません。
測る範囲は /gauntlet-setup が決めてからフラグで渡します。
`;

/** `--name=value` / `--name` の name だけを取り出す。値の解析はしない。 */
function flagNames(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg.startsWith("--")).map((arg) => arg.slice(2).split("=")[0] ?? "");
}

/**
 * ヘルプを求められたか。**実行の前に見る。**
 *
 * `init --help` が実行に落ちていた（0.17.0 で「`--` があれば範囲指定」と
 * 判定していたため、`--include=` が無いので既定値で上書きした）。h3 の導入で
 * 実際に測る範囲が `src/**` に戻された。
 */
export function helpRequested(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * フラグから範囲を読む。**フラグが 1 つも無ければ `null`** — 範囲の指定なし、
 * つまり「骨組みの整備だけ」の呼ばれ方で、`init` は既存の config に触らない。
 *
 * **知らないフラグは止める。** 打ち間違い（`--includes=`）を素通しすると、
 * 既定値で書いたのに「指定したつもり」の設定が残る（走らなかったゲートを
 * 緑にしないのと同じ原則。`main.ts` の usageError と揃えた）。
 */
export function parseInitOptions(argv: readonly string[]): InitOptions | null {
  const given = flagNames(argv);
  const unknown = given.filter((name) => !(INIT_FLAGS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new ConfigError(`init が知らない指定です: ${unknown.map((name) => `--${name}`).join(" ")}\n\n${INIT_USAGE}`);
  }
  if (given.length === 0) return null;
  const value = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const list = (name: string, fallback: string[]): string[] => {
    const raw = value(name);
    return raw === undefined || raw === "" ? fallback : raw.split(",");
  };
  return {
    defaultBranch: value("default-branch") ?? INIT_DEFAULTS.defaultBranch,
    include: list("include", INIT_DEFAULTS.include),
    exclude: list("exclude", INIT_DEFAULTS.exclude),
    testProjects: list("test-projects", INIT_DEFAULTS.testProjects),
  };
}
