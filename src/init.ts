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

import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILENAME, type GauntletConfig } from "./config.ts";

export interface InitOptions {
  defaultBranch: string;
  include: string[];
  exclude: string[];
}

export const INIT_DEFAULTS: InitOptions = {
  defaultBranch: "main",
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.test.ts"],
};

function configFor(options: InitOptions): GauntletConfig & { $schema: string } {
  return {
    $schema: "./node_modules/@teps/gauntlet/schema/gauntlet.config.schema.json",
    schemaVersion: 1,
    adapter: "typescript",
    runner: "vitest",
    defaultBranch: options.defaultBranch,
    source: { include: options.include, exclude: options.exclude },
  };
}

/** `Stop` は exit 2 で停止を阻止し、`PreToolUse` は exit 2 でツールを実行前に止める。 */
const HOOKS = {
  Stop: [{ hooks: [{ type: "command", command: "npx gauntlet run --tier=turn" }] }],
  PreToolUse: [
    {
      matcher: "Edit|Write|NotebookEdit|Bash",
      hooks: [{ type: "command", command: "npx gauntlet guard" }],
    },
  ],
};

const SKILL = `---
name: gauntlet
description: gauntlet をこのリポジトリに導入する、または測る範囲を直す。導入直後、gauntlet.config.json を作る・直すとき、turn が意図しない範囲を測っているときに使う。
---

# gauntlet の導入

**測る範囲はユーザーと決める。** 推測して黙って書かない。範囲が狭いまま緑になるのが、
このツールで一番気づけない失敗だから。

## 1. リポジトリを読む

- \`tsconfig.json\` の \`include\` — ただし鵜呑みにしない。生成物（\`.next/types\`）、
  設定ファイル（\`next.config.ts\`, \`vitest.config.ts\`）、e2e が混ざっていることが多い
- TypeScript が置かれている最上位ディレクトリを実際に列挙する
- **ルート直下の \`.ts\` も 1 つずつ分類する。** 設定ファイルに紛れて製品コードが
  置かれていることがある（duct ではルートの \`proxy.ts\` が Auth0 の認証ゲート本体で、
  最初の導入はこれを測り漏らした）。\`init\` の取りこぼし報告はディレクトリしか挙げない
- テストファイルの命名規則（\`*.test.ts\` / \`*.spec.ts\` / \`__tests__/\`）
- 既定ブランチ（\`git symbolic-ref --short HEAD\` や \`origin/HEAD\`）

### どう型チェックしているか

\`package.json\` の \`typecheck\` / \`type-check\` スクリプトを読む。**tsconfig が複数ある場合は要注意** —
\`tsc -p tsconfig.src.json --noEmit && tsc --noEmit\` のように 2 パスのことがある（teps が実例）。
gauntlet の既定は \`tsc --noEmit\` だけなので、そのままだと**半分しか見ない**。

### 外部サービスを要するテストはどれか

DB・ネットワーク・実ファイルシステムに触れるテストを探す。手がかり:

- \`PrismaClient\` / \`new Pool(\` / \`$queryRaw\` / \`createClient(\` の import
- \`beforeAll\` での接続や \`listen(\`
- 「ローカル DB に接続できません」のようなガード

**確定させるのは grep ではなく実行。** 候補が出そろったら、\`.env\` / \`.env.local\` を
一時的に別の場所へ退避して unit テストを走らせる。落ちるものだけが本物。
環境変数を unset するだけでは足りない — テストファイルが自前で dotenv を読む設計は
普通にある（duct で実測。grep は 16 候補中 15 が偽陽性で、本物 1 件を取りこぼしていた。
取りこぼしは後の「DB 無しで \`turn\` が通ること」の確認で捕まえた）。

**規約: そういうテストは \`*.integration.test.ts\` と名付ける。** gauntlet はこれを
**一切見ない**（\`turn\` も \`pr\` も。実行・coverage・mutation 全部）。設定項目は無い。
名前が合っていないファイルは**リネームしてもらう**。手元に DB が無いだけで赤になるのは
環境で答えが変わるゲートであり、integration の coverage は「通りすがりに実行しただけ」の
行をテスト済みに見せる。integration テストを回す場所は各リポジトリの既存 CI。

### CI はどうなっているか

\`.github/workflows/\` を全部見る。\`pr\` をどこで回すかを 3 で決めるための材料を集める。

**a. 古い認証設定が残っていないか。** \`@tepshq/gauntlet\` は 0.0.14 から public npm
（registry.npmjs.org）にあり、**認証は要らない**。GitHub Packages 時代の名残があると
逆に壊れるので、見つけたら外す:

- \`.npmrc\` の \`@tepshq:registry=https://npm.pkg.github.com\` の行
- workflow の \`registry-url\` / \`scope\` / \`NODE_AUTH_TOKEN\`（gauntlet のためだけに
  入っていた場合。他の private パッケージが使っているなら残す）

**b. \`pr\` を足せる job があるか。** 次を全て満たす job を探す。lint / 型チェック /
テストを回している job が普通は該当する。

- \`actions/checkout\` に \`fetch-depth: 0\`（merge-base を取るのに全履歴が要る）
- Node が **22 以上**（gauntlet が \`node:fs\` の \`globSync\` を使う）

gauntlet は integration テストを見ないので、**\`pr\` の job にサービスコンテナや
DB の初期化は要らない**。integration テストは既存 CI の job がそのまま担う。

**完了条件** — TypeScript を含む最上位ディレクトリを 1 つ残らず挙げ、それぞれについて
「製品コードか、テストか、生成物か、設定か」を言えること。型チェックのコマンド、
外部サービスを要するテストの一覧、そして \`pr\` を足せる job があるかどうかを言えること。

## 2. 提案してユーザーに確認する

測る対象と、外すものを**理由つきで**示す。例:

> \`src\` と \`bin\` を測ります。\`e2e\` は Playwright の受け入れテストなので外します。
> \`scripts\` は 3 ファイルありますが、リリース作業用で本体ではないので外します。
> 型チェックは 2 パスなので \`commands.typecheck\` で上書きします。
> \`lib/import/session.test.ts\` は DB が要るので \`*.integration.test.ts\` へのリネームをお願いします。

**判断が割れる場所は必ず訊く。** 迷わず決められる場所だけ黙って含める。

**完了条件** — ユーザーが範囲・型チェック・リネーム対象に同意していること。

## 3. 入れる

\`\`\`
npx gauntlet init --default-branch=<branch> --include=<glob,glob> --exclude=<glob,glob>
\`\`\`

出力の「測る対象: N ファイル」が想定と合っているか確かめる。
「対象外に TypeScript があります」が出たら、それが意図した除外か確認する。

型チェックの上書きが要る場合は \`gauntlet.config.json\` の \`commands.typecheck\` に書く
（\`init\` にフラグは無い。config はスキーマ検証されるので、間違えれば起動時に落ちる）。

### 外部サービスを要するテストがあった場合

\`init\` は**これを自動ではやらない**。1 で見つけていたら、ここで両方行う。

**a. vitest に \`integration\` project を作る。** 既存の project があれば、そこから
\`*.integration.test.*\` を除外して二重に走らないようにする。

\`\`\`ts
projects: [
  { extends: true, test: { name: "unit", include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/*.integration.test.ts"] } },
  { extends: true, test: { name: "integration", include: ["**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**"] } },
]
\`\`\`

\`**/.claude/**\` の除外は全 project に入れる。Claude Code の worktree が
\`.claude/worktrees/\` にリポジトリ丸ごとのコピーを作ることがあり、
その中のテストまで拾うと件数が倍増する（duct で 600 ファイル拾った実例）。

**b. 命名が合っていないファイルをリネームする。** 外部サービスを要するのに
\`*.integration.test.*\` でないものは \`turn\` に入ってしまう。

## 4. CI で \`pr\` を回す

**\`init\` は workflow を作らない。** CI が要るものは gauntlet からは見えない
（サービスコンテナ、マイグレーション、Node のバージョン、認証）。既に動いている job には
それが全部揃っているので、そこに 1 行足すのが一番確実で、重複も生まない。

### 足せる job がある場合（1 の b で見つけたもの）

その job の最後に足す。それだけ。

\`\`\`yaml
      - run: npx gauntlet run --tier=pr
\`\`\`

### 足せる job が無い場合

作る。以後これは**リポジトリのファイル**で、gauntlet は二度と触らない。
gauntlet は integration テストを走らせないので、\`services:\` も DB の初期化も要らない。
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
      - run: npx gauntlet run --tier=pr
\`\`\`

**job の Node が 22 未満なら、そこには足せない。** 上の別 job を作るか、
リポジトリの持ち主に CI の Node を上げてもらうか。どちらにするかは訊く
（アプリが載る Node を変える話なので、gauntlet の都合で決めてよいことではない）。

**完了条件** — \`npx gauntlet run --tier=turn\` が通り、測った件数が想定と一致していること。
外部サービスが無い状態でも \`turn\` と \`pr\` が通ること（\`integration\` project の除外が
効いている証拠）。\`pr\` を回す job が 1 つあり、それが上の 2 条件（全履歴・Node 22 以上）を
満たすこと。

## 5. ラチェットの種を置く

\`pr\` を**手元で一度回して**、できた \`gauntlet.baseline.json\` をコミットする。

\`\`\`
npx gauntlet run --tier=pr
\`\`\`
初回は「\`gauntlet.baseline.json\` を作りました。コミットしてください」で**落ちる**。
これが正常。ファイルはできているので、コミットしてもう一度回せば通る。

**CI に任せてはいけない。** CI が置いた種はコンテナの中に書かれて捨てられる。
毎 PR がその PR の状態を許容値として置き直すことになり、ラチェットが一度も噛まない。

**完了条件** — \`gauntlet.baseline.json\` が履歴にあり、\`npx gauntlet run --tier=pr\` が通ること。

## 触らないもの

\`gauntlet.baseline.json\` は許容する違反数の記録で、減らすのは gauntlet が自動で行う。
編集は \`PreToolUse\` フックで止まる。赤を消すには違反そのものを直す。
`;

/**
 * gauntlet と、それが呼ぶ道具が残す作業ファイル。
 *
 * `coverage/` と `.stryker-tmp/` は実行のたびに作られる。放っておくと
 * 導入した全リポジトリで未追跡のゴミになるので、こちらで面倒を見る。
 */
const IGNORED = ["coverage/", "reports/", ".stryker-tmp/"];

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
 * 既にあるフックを消さずに足す。他の用途で使っている設定を壊さない。
 *
 * **同じものは二度足さない。** `init` は測る範囲を直すたびに叩かれるので、
 * 積み上げるとフックが多重に登録され、毎ターン gauntlet が何度も走ることになる。
 */
export function mergeSettings(existing: string | null): string {
  const settings: Settings = existing === null ? {} : (JSON.parse(existing) as Settings);
  const hooks = settings.hooks ?? {};
  for (const [event, entries] of Object.entries(HOOKS)) {
    const current = hooks[event] ?? [];
    const known = new Set(current.map((entry) => JSON.stringify(entry)));
    hooks[event] = [...current, ...entries.filter((entry) => !known.has(JSON.stringify(entry)))];
  }
  return `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`;
}

function write(root: string, path: string, contents: string): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return path;
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
 * 測る対象になった数と、取りこぼしていそうな場所。
 *
 * `init` は既定値を書くだけで、そのリポジトリの正解は知らない。
 * 黙って書くと測定範囲が狭いまま緑になり、それが一番気づけない失敗になる。
 * 対象外の場所に TypeScript があることを見せて、設定を詰める合図にする。
 */
export function scopeReport(root: string, source: InitOptions): { matched: number; unmatched: string[] } {
  const topOf = (path: string): string => path.split(/[\\/]/)[0] ?? path;
  const matched = globSync(source.include, { cwd: root, exclude: source.exclude });
  const covered = new Set(matched.map(topOf));
  const all = globSync("**/*.ts", { cwd: root, exclude: ["node_modules/**", "dist/**", "coverage/**"] });
  const unmatched = [...new Set(all.map(topOf))]
    .filter((top) => !covered.has(top) && !top.endsWith(".ts"))
    .sort();
  return { matched: matched.length, unmatched };
}

/** 書いたファイルの一覧を返す。 */
export function init(root: string, options: InitOptions = INIT_DEFAULTS): string[] {
  return [
    write(root, CONFIG_FILENAME, `${JSON.stringify(configFor(options), null, 2)}\n`),
    write(root, ".claude/settings.json", mergeSettings(readIfPresent(root, ".claude/settings.json"))),
    write(root, ".claude/skills/gauntlet/SKILL.md", SKILL),
    write(root, ".gitignore", mergeGitignore(readIfPresent(root, ".gitignore"))),
  ];
}

export function parseInitOptions(argv: readonly string[]): InitOptions {
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
  };
}
