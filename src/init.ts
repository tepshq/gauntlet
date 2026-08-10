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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  exclude: ["src/**/*.test.ts"],
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
    source: { include: options.include, exclude: options.exclude },
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

const SKILL = `---
name: gauntlet-setup
description: gauntlet をこのリポジトリに導入する、または測る範囲・走らせるテストの宣言を直す。導入直後、gauntlet.config.json を作る・直すとき、quick が意図しない範囲を測っているときに使う。
---

# gauntlet の導入

**測る範囲はユーザーと決める。** 推測して黙って書かない。範囲が狭いまま緑になるのが、
このツールで一番気づけない失敗だから。

この skill 自体は \`npx @teps/gauntlet init\`（未インストールでも動く）が置く。
そこから先 — 依存の投入・範囲の決定・CI・ラチェットの種 — は全部ここの手順で行う。

## 0. 依存を入れる

gauntlet が devDependencies に無ければ、まず入れる。**コマンドは決め打ちしない** —
リポジトリのパッケージマネージャに合わせる（間違えると lockfile が汚れる）:

1. **PM の特定**: \`package.json\` の \`packageManager\` フィールドが正。無ければ lockfile
   （\`pnpm-lock.yaml\` / \`yarn.lock\` / \`bun.lock\` / \`package-lock.json\`）から。
2. **node_modules が無ければ先にリポジトリ自体を install する**（後の「実行で確定させる」
   手順にテスト実行が要る）。
3. **入れるもの**:
   - \`@teps/gauntlet\` — フックが \`npx gauntlet\` で呼ぶ本体
   - \`@stryker-mutator/core\` \`@stryker-mutator/vitest-runner\` — \`full\` の mutation 用

例（pnpm のリポジトリ）:

\`\`\`
pnpm add -D @teps/gauntlet @stryker-mutator/core @stryker-mutator/vitest-runner
\`\`\`

**coverage provider（\`@vitest/coverage-v8\`）は手で足さない。** 版を間違えると
install ごと失敗する（vitest の**完全一致**を peer に要求する）。足りなければ
\`gauntlet quick\` が**版を埋めた 1 行**を出すので、それをそのまま打つ。

vitest が無いリポジトリは対象外（gauntlet の要件）。無理に足さず、ユーザーに伝えて止まる。

## 1. リポジトリを読む

- \`tsconfig.json\` の \`include\` — ただし鵜呑みにしない。生成物（\`.next/types\`）、
  設定ファイル（\`next.config.ts\`, \`vitest.config.ts\`）、e2e が混ざっていることが多い
- TypeScript が置かれている最上位ディレクトリを実際に列挙する
- **ルート直下の \`.ts\` も 1 つずつ分類する。** 設定ファイルに紛れて製品コードが
  置かれていることがある（duct ではルートの \`proxy.ts\` が Auth0 の認証ゲート本体で、
  最初の導入はこれを測り漏らした）。**取りこぼしを見つけるのはここだけの仕事** —
  \`init\` は範囲について何も言わない
- テストファイルの命名規則（\`*.test.ts\` / \`*.spec.ts\` / \`__tests__/\`）
- 既定ブランチ（\`git symbolic-ref --short HEAD\` や \`origin/HEAD\`）

### どう型チェックしているか

\`package.json\` の \`typecheck\` / \`type-check\` スクリプトを読む。**tsconfig が複数ある場合は要注意** —
\`tsc -p tsconfig.src.json --noEmit && tsc --noEmit\` のように 2 パスのことがある（teps が実例）。
gauntlet の既定は \`tsc --noEmit --incremental\` だけなので、そのままだと**半分しか見ない**。

\`commands.typecheck\` で上書きする場合も \`--incremental\` を付けたままにする —
2 回目以降の \`quick\` が数秒速くなる（duct 実測 8.5s → 1.9s）。キャッシュ
（\`*.tsbuildinfo\`、\`init\` が .gitignore に足す）は速さだけを変え、診断は変えない。

### 外部サービスを要するテストはどれか

DB・ネットワーク・実ファイルシステムに触れるテストを探す。手がかり:

- \`PrismaClient\` / \`new Pool(\` / \`$queryRaw\` / \`createClient(\` の import
- \`beforeAll\` での接続や \`listen(\`
- 「ローカル DB に接続できません」のようなガード

**確定させるのは grep ではなく実行。** 候補が出そろったら、\`.env\` / \`.env.local\` を
一時的に別の場所へ退避して unit テストを走らせる。落ちるものだけが本物。
環境変数を unset するだけでは足りない — テストファイルが自前で dotenv を読む設計は
普通にある（duct で実測。grep は 16 候補中 15 が偽陽性で、本物 1 件を取りこぼしていた。
取りこぼしは後の「DB 無しで \`quick\` が通ること」の確認で捕まえた）。

**外部サービスを要するテストは、gauntlet の世界の外に置く。** gauntlet は
\`gauntlet.config.json\` の \`tests.projects\` に**宣言された vitest project だけ**を走らせる
（実行・coverage・mutation 全部。宣言が無ければ全部走らせる）。外部サービスを要する
テストを宣言外の project に分ければ、gauntlet からは存在しなくなる。
手元に DB が無いだけで赤になるのは環境で答えが変わるゲートであり、そういうテストの
coverage は「通りすがりに実行しただけ」の行をテスト済みに見せる。
それらを回す場所は各リポジトリの既存 CI。project の名前や分け方はリポジトリの自由。

### CI はどうなっているか

\`.github/workflows/\` を全部見る。\`full\` をどこで回すかを 3 で決めるための材料を集める。

**a. 古い認証設定が残っていないか。** gauntlet は 0.9.0 から \`@teps/gauntlet\` として public npm
（registry.npmjs.org）にあり、**認証は要らない**。GitHub Packages 時代の名残があると
逆に壊れるので、見つけたら外す:

- \`.npmrc\` の \`@tepshq:registry=https://npm.pkg.github.com\` の行
- workflow の \`registry-url\` / \`scope\` / \`NODE_AUTH_TOKEN\`（gauntlet のためだけに
  入っていた場合。他の private パッケージが使っているなら残す）

**b. \`full\` を足せる job があるか。** 次を全て満たす job を探す。lint / 型チェック /
テストを回している job が普通は該当する。

- \`actions/checkout\` に \`fetch-depth: 0\`（merge-base を取るのに全履歴が要る）
- Node が **22 以上**（gauntlet が \`node:fs\` の \`globSync\` を使う）

gauntlet は宣言されたテストしか走らせないので、**\`full\` の job にサービスコンテナや
DB の初期化は要らない**。宣言外のテストは既存 CI の job がそのまま担う。

**完了条件** — TypeScript を含む最上位ディレクトリを 1 つ残らず挙げ、それぞれについて
「製品コードか、テストか、生成物か、設定か」を言えること。型チェックのコマンド、
外部サービスを要するテストの一覧、そして \`full\` を足せる job があるかどうかを言えること。

## 2. 提案してユーザーに確認する

測る対象と、外すものを**理由つきで**示す。例:

> \`src\` と \`bin\` を測ります。\`e2e\` は Playwright の受け入れテストなので外します。
> \`scripts\` は 3 ファイルありますが、リリース作業用で本体ではないので外します。
> 型チェックは 2 パスなので \`commands.typecheck\` で上書きします。
> \`lib/import/session.test.ts\` は DB が要るので、宣言から外す project への分離をお願いします。

**判断が割れる場所は必ず訊く。** 迷わず決められる場所だけ黙って含める。

**完了条件** — ユーザーが範囲・型チェック・走らせる project の宣言に同意していること。

## 3. 入れる

\`\`\`
npx gauntlet init --default-branch=<branch> --include=<glob,glob> --exclude=<glob,glob> --test-projects=<name,name>
\`\`\`

**範囲を書き換えるのはフラグを渡したときだけ。** フラグ無しの \`init\` は骨組み
（フック・skill・.gitignore）の整備だけで、既存の \`gauntlet.config.json\` には触らない
（出力が「変更なし」と言う）。だから gauntlet を上げたあと叩き直しても範囲は消えない。
\`--test-projects\` は project を使っていないリポジトリでは省略する（全部走る）。

**測った件数はここでは確かめない。** 検算は 4 の完了条件（\`npx gauntlet quick\` の
\`測る対象 N\` が 1 で数えた想定と合うか）で行う。基準を 2 か所に置かない。

型チェックの上書きが要る場合は \`gauntlet.config.json\` の \`commands.typecheck\` に書く
（\`init\` にフラグは無い。config はスキーマ検証されるので、間違えれば起動時に落ちる）。
範囲を直すために \`init\` をフラグ付きで叩き直しても \`commands\` は残る
（出力が「更新（commands は残しました）」と言う）。

### 起動点は自動で配線される

\`quick\` は Claude Code の \`PreToolUse\` フック（\`npx gauntlet guard\`）が、
**エージェントがコミットしようとした瞬間**に呼ぶ。\`init\` が
\`.claude/settings.json\` に書くので、**配線の手作業は無い** — このファイルは
コミットで伝播し、clone した全員に効く。

**わざと違反（未テストで CC 3 以上の関数）を作ってコミットさせ、拒否されることまで確認する。**

0.13 以前から入れているリポジトリには後始末が要る:

\`\`\`
git config --unset core.hooksPath   # 0.13 の pre-commit 配線
rm -rf .githooks                    # 0.13 が置いたフック
\`\`\`

\`.claude/settings.json\` に \`Stop\` フック（0.12 以前）が残っていたら、それも消す。

### 外部サービスを要するテストがあった場合

\`init\` は**これを自動ではやらない**。1 で見つけていたら、ここで整理する。

**外部サービスを要するテストを専用の vitest project に分け、それを宣言から外す。**
project の名前も分け方もリポジトリの自由（そういうテストはどのみち専用の
\`environment\` / \`setupFiles\` / env 変数が要ることが多く、本来引くべき境界と一致する）。
分け方の例:

\`\`\`ts
projects: [
  { extends: true, test: { name: "unit", include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/*.db.test.ts"] } },
  { extends: true, test: { name: "db", include: ["**/*.db.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**"] } },
]
\`\`\`

この例なら宣言は \`--test-projects=unit\`。**宣言できるのはインラインの project だけ**
（別ファイルへの glob 参照は名前が読めないため、mutation で残せない）。

\`**/.claude/**\` の除外は全 project に入れる。Claude Code の worktree が
\`.claude/worktrees/\` にリポジトリ丸ごとのコピーを作ることがあり、
その中のテストまで拾うと件数が倍増する（duct で 600 ファイル拾った実例）。

## 4. CI で \`full\` を回す

**\`init\` は workflow を作らない。** CI が要るものは gauntlet からは見えない
（サービスコンテナ、マイグレーション、Node のバージョン、認証）。既に動いている job には
それが全部揃っているので、そこに 1 行足すのが一番確実で、重複も生まない。

### 足せる job がある場合（1 の b で見つけたもの）

その job の最後に足す。それだけ。

\`\`\`yaml
      - run: npx gauntlet full
\`\`\`

### 足せる job が無い場合

作る。以後これは**リポジトリのファイル**で、gauntlet は二度と触らない。
gauntlet は宣言されたテストしか走らせないので、\`services:\` も DB の初期化も要らない。
ただし \`postinstall\` が環境変数を形式上要求する場合（Prisma の \`generate\` 等）は
ダミー値を \`env:\` に置く。

\`\`\`yaml
name: gauntlet
on: pull_request

jobs:
  gauntlet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # merge-base を取るために全履歴が要る。浅いと差分の起点が決まらない。
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          # gauntlet は node:fs の globSync を使うので 22 以上。
          node-version: 22
      - run: npm ci
      - run: npx gauntlet full
\`\`\`

**job の Node が 22 未満なら、そこには足せない。** 上の別 job を作るか、
リポジトリの持ち主に CI の Node を上げてもらうか。どちらにするかは訊く
（アプリが載る Node を変える話なので、gauntlet の都合で決めてよいことではない）。

**完了条件** — \`npx gauntlet quick\` が通り、測った件数が想定と一致していること。
**pre-commit が配線され、わざと作った違反でコミットが拒否されること。**
外部サービスが無い状態でも \`quick\` と \`full\` が通ること（宣言が効いている証拠）。
\`full\` を回す job が 1 つあり、それが上の 2 条件（全履歴・Node 22 以上）を満たすこと。

## 5. ラチェットの種を置く

\`full\` を**手元で一度回して**、できた \`gauntlet.baseline.json\` をコミットする。

\`\`\`
npx gauntlet full
\`\`\`
初回は「\`gauntlet.baseline.json\` を作りました。…コミットしてください」で**落ちる**。
これが正常。ファイルはできているので、コミットしてもう一度回せば通る。
コミットは \`git add -A\` で行う — ファイル名を含む Bash コマンドは guard が止めるので、
名指しの \`git add gauntlet.baseline.json\` は使えない。

**CI に任せてはいけない。** CI が置いた種はコンテナの中に書かれて捨てられる。
毎 PR がその PR の状態を許容値として置き直すことになり、ラチェットが一度も噛まない。

**完了条件** — \`gauntlet.baseline.json\` が履歴にあり、\`npx gauntlet full\` が通ること。

## 触らないもの

\`gauntlet.baseline.json\` は許容する違反数の記録で、減らすのは gauntlet が自動で行う。
編集と、ファイル名に触れる Bash コマンドは \`PreToolUse\` フックで止まる
（読むには Read ツール、コミットには \`git add -A\` を使う）。赤を消すには違反そのものを直す。
`;

/**
 * gauntlet と、それが呼ぶ道具が残す作業ファイル。
 *
 * `coverage/` と `.stryker-tmp/` は実行のたびに作られる。放っておくと
 * 導入した全リポジトリで未追跡のゴミになるので、こちらで面倒を見る。
 * `*.tsbuildinfo` は既定の型チェック（`tsc --noEmit --incremental`）の検査キャッシュ。
 */
const IGNORED = ["coverage/", "reports/", ".stryker-tmp/", "*.tsbuildinfo"];

/** 既にある行は足さない。既存の .gitignore を並べ替えたり消したりもしない。 */
export function mergeGitignore(existing: string | null): string {
  const current = existing ?? "";
  const lines = current.split("\n");
  const missing = IGNORED.filter((entry) => !lines.some((line) => line.trim() === entry));
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
    ? "\n次: Claude Code でこのリポジトリを開き、/gauntlet-setup を実行してください\n" +
      "（依存の投入 → 測る範囲の決定 → CI → ラチェットの種置きまで随行します）\n"
    : "";
  return `${listed}\n${next}`;
}

/**
 * 0.9.x 以前が置いた skill。名前が「gauntlet の全部」を名乗る大きさなのに中身は
 * 導入手順だけで、無関係な gauntlet の質問まで吸い込んでいた。gauntlet-setup に
 * 改名したので、置き直すときに古い方を片付ける。
 */
function removeLegacySkill(root: string): void {
  rmSync(join(root, ".claude/skills/gauntlet"), { recursive: true, force: true });
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
  removeLegacySkill(root);
  const settings = readIfPresent(root, ".claude/settings.json");
  const skill = readIfPresent(root, ".claude/skills/gauntlet-setup/SKILL.md");
  const gitignore = readIfPresent(root, ".gitignore");
  const merged = mergeGitignore(gitignore);
  // 設定は書く前に全部読む。読めない settings.json ならここで落ち、1 つも書かずに済む。
  const settingsAfter = mergeSettings(settings);
  const config = configFile(root, options);

  return {
    files: [
      config,
      write(root, ".claude/settings.json", settingsAfter, settings === null ? "作成" : "更新（既存の設定は残しました）"),
      write(root, ".claude/skills/gauntlet-setup/SKILL.md", SKILL, madeOrUpdated(skill)),
      write(root, ".gitignore", merged, gitignoreNote(gitignore, merged)),
    ],
    // 範囲を指定して呼ばれたなら、もう決まっている。案内が要るのは
    // 「骨組みだけ置いて、範囲がまだ既定値」の状態。
    needsSetup: options === null && config.note === "作成",
  };
}

/**
 * フラグから範囲を読む。**フラグが 1 つも無ければ `null`** — 範囲の指定なし、
 * つまり「骨組みの整備だけ」の呼ばれ方で、`init` は既存の config に触らない。
 */
export function parseInitOptions(argv: readonly string[]): InitOptions | null {
  if (!argv.some((arg) => arg.startsWith("--"))) return null;
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
