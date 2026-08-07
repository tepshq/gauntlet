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

**完了条件** — TypeScript を含む最上位ディレクトリを 1 つ残らず挙げ、それぞれについて
「製品コードか、テストか、生成物か、設定か」を言えること。

## 2. 提案してユーザーに確認する

測る対象と、外すものを**理由つきで**示す。例:

> \`src\` と \`bin\` を測ります。\`e2e\` は Playwright の受け入れテストなので外します。
> \`scripts\` は 3 ファイルありますが、リリース作業用で本体ではないので外します。これでよいですか。

**判断が割れる場所は必ず訊く。** 迷わず決められる場所だけ黙って含める。

**完了条件** — ユーザーが範囲に同意していること。

## 3. 入れる

\`\`\`
npx gauntlet init --default-branch=<branch> --include=<glob,glob> --exclude=<glob,glob>
\`\`\`

出力の「測る対象: N ファイル」が想定と合っているか確かめる。
「対象外に TypeScript があります」が出たら、それが意図した除外か確認する。

**完了条件** — \`npx gauntlet run --tier=turn\` が通り、測った件数が想定と一致していること。

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
