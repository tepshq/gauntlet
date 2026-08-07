/**
 * 導入。置くのは薄いファイルだけで、ロジックは全てパッケージ側に残す。
 *
 * 生成物が薄いほど「更新」は npm のバージョンを上げるだけで済む。
 * 再生成も差分適用も managed block も持たない。
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
    $schema: "./node_modules/@tepshq/gauntlet/schema/gauntlet.config.schema.json",
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

const WORKFLOW = `name: gauntlet
on: pull_request

jobs:
  gauntlet:
    runs-on: ubuntu-latest
    # gauntlet は GitHub Packages の private パッケージなので読み取り権限が要る。
    permissions:
      contents: read
      packages: read
    steps:
      - uses: actions/checkout@v4
        with:
          # merge-base を取るために全履歴が要る。浅いと差分の起点が決まらない。
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json
          registry-url: https://npm.pkg.github.com
          scope: "@tepshq"
      - run: npm ci
        env:
          NODE_AUTH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - run: npx gauntlet run --tier=pr
`;

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

**規約: そういうテストは \`*.integration.test.ts\` と名付ける。** gauntlet は \`turn\` でこれを
除外し、\`pr\` でのみ走らせる。設定項目は無い。名前が合っていないファイルは**リネームしてもらう**。
手元に DB が無いだけで毎ターン赤になると、ゲートが環境によって答えを変えることになる。

### 既に CI があるか

\`.github/workflows/\` を見る。lint / 型チェック / テストを回している workflow が既にあれば、
gauntlet の workflow と**重複する**。どう扱うかはリポジトリの持ち主が決めることなので、
見つけたら必ず挙げる。

**完了条件** — TypeScript を含む最上位ディレクトリを 1 つ残らず挙げ、それぞれについて
「製品コードか、テストか、生成物か、設定か」を言えること。型チェックのコマンド、
外部サービスを要するテストの一覧、既存 workflow との重複を言えること。

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

\`init\` は**これを自動ではやらない**。1 で見つけていたら、ここで 3 つとも行う。

**a. vitest に \`integration\` project を作る。** 既存の project があれば、そこから
\`*.integration.test.*\` を除外して二重に走らないようにする。

\`\`\`ts
projects: [
  { extends: true, test: { name: "unit", include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"] } },
  { extends: true, test: { name: "integration", include: ["**/*.integration.test.ts"] } },
]
\`\`\`

**b. 命名が合っていないファイルをリネームする。** 外部サービスを要するのに
\`*.integration.test.*\` でないものは \`turn\` に入ってしまう。

**c. CI workflow に必要なサービスを足す。** \`pr\` では統合テストが走るので、
DB などのサービスコンテナと、マイグレーション・シードの手順が要る。
既存 workflow が同じものを持っていれば、そこから写す。

**完了条件** — \`npx gauntlet run --tier=turn\` が通り、測った件数が想定と一致していること。
外部サービスが無い状態でも \`turn\` が通ること（\`--project=!integration\` が効いている証拠）。

## 4. ラチェットの種を置く

\`pr\` を**手元で一度回して**、できた \`gauntlet.baseline.json\` をコミットする。

\`\`\`
npx gauntlet run --tier=pr
\`\`\`

外部サービスを要するテストも走るので、DB などを立てた状態で回す。
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
    write(root, ".github/workflows/gauntlet.yml", WORKFLOW),
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
