# gauntlet

エージェントが書いたコードを、人間がコードを読まずに機械的な制約で縛る、チーム共用の品質ゲート。

`turn` は Claude Code の `Stop` フックから毎ターン走り、exit 2 でエージェントを差し戻す。
「done と言う前に緑」が機械的に強制される。`pr` は CI から走り、PR をブロックする。

| tier | 起動点 | 中身 | 実測（hue） |
| --- | --- | --- | --- |
| `turn` | `Stop` フック | 型チェック + 関連テスト + CRAP | 5.5 秒 |
| `pr` | CI | 全テスト + ラチェット + lint + mutation | 142 秒 |

## 何を測るか

- **CRAP** — `CC² × (1 − coverage)³ + CC`。閾値 **8**。触った関数に絶対、リポジトリ全体は baseline ラチェット。
  網羅率 0% なら CC 2 まで、50% で 4、80% で 7、100% で 8。テストすれば複雑さを許す。
- **mutation** — コードを 1 箇所ずつ壊してテストが気づくか見る。**テストを増やすだけでは通せない**唯一のゲート。
- **lint** — ルールは各リポジトリが持つ。gauntlet は件数を増やさせないだけ。

**既存リポジトリを導入初日に赤で埋めない。** 導入時点の違反数は `gauntlet.baseline.json` に記録され、
以後それを増やせない（減れば自動で締まる）。baseline は `PreToolUse` フックでエージェントの編集から守られる。

## 導入

### 1. パッケージのアクセス許可（リポジトリごとに一度だけ）

gauntlet は private パッケージなので、消費側リポジトリの `secrets.GITHUB_TOKEN` は既定では読めない。

[パッケージ設定](https://github.com/orgs/tepshq/packages/npm/gauntlet/settings) →
**Manage Actions access** → 導入先リポジトリを **Read** で追加。

これを飛ばすと CI の `npm ci` が `403 permission_denied: read_package` で落ちる。

> `Internal` 可視性ならこの手順は要らないが、Team プランでは使えない。

### 2. 入れる

```bash
npm i -D @tepshq/gauntlet @stryker-mutator/core @stryker-mutator/vitest-runner
```

`.npmrc` に `@tepshq:registry=https://npm.pkg.github.com` が要る。

### 3. 測る範囲を決める

Claude Code で `.claude/skills/gauntlet` を使う。**推測で入れない** — エージェントがリポジトリを読み、
理由つきで範囲を提案し、合意してから `init` を叩く。`tsconfig.json` の `include` は当てにならない
（生成物・設定ファイル・e2e が混ざる）。

```bash
npx gauntlet init --default-branch=main --include='src/**/*.ts' --exclude='src/**/*.test.ts'
```

`init` は薄いファイルだけ置く。ロジックは全てパッケージ側にあるので、更新は npm のバージョンを上げるだけ。

- `.claude/settings.json` — `Stop` と `PreToolUse` のフック（既存の設定は壊さない）
- `gauntlet.config.json` — このリポジトリの事実。閾値は入らない
- `.github/workflows/gauntlet.yml`
- `.claude/skills/gauntlet/SKILL.md`
- `.gitignore` — 足りない行だけ追記

何度叩いても結果は同じ（冪等）。

## 使う

```bash
npx gauntlet run --tier=turn   # 通れば exit 0、違反または gauntlet 自身が走れなければ exit 2
npx gauntlet run --tier=pr
```

## 要件

- Node >= 22 / vitest / 単一パッケージ（workspaces 未対応）
- TypeScript のバージョンに下限は無い。gauntlet がパースできれば良い

## 設計

判断とその理由は [DESIGN.md](DESIGN.md)、実装の経緯と実測は [PLAN.md](PLAN.md)。
