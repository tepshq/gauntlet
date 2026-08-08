# gauntlet

エージェントが書いたコードを、**人間がコードを読まずに機械的な制約で縛る**ための品質ゲート。

Robert C. Martin が 2026 年 7 月に「自分はもうエージェントのコードを読まない。代わりにテスト・
カバレッジ・複雑度・mutation testing で囲む」と述べた方針を、社内の複数リポジトリに適用できる形に
したものです。

人間がコードを読む速度がボトルネックになるなら、読まずに済ませる。ただし「読まない」を成立させる
だけの機械的な保証を敷く、というのが考え方です。

## 入れると何が変わるか

**2 か所で止まるようになります。**

| | いつ | 何が起きる |
| --- | --- | --- |
| `turn` | Claude Code が応答を終えるたび | 赤ならエージェントが**終了できず**、そのまま直しにいく |
| `pr` | CI | 赤なら**マージできない** |

`turn` が効くのが一番の違いです。人間が「テスト通してね」と言わなくても、エージェントは
緑になるまで終われません。数秒で終わるように作ってあります（実測: 5.5〜20 秒）。

## 何を見るか

### CRAP — 複雑さと網羅率をひとつの数にする

`CRAP = 複雑度² × (1 − 網羅率)³ + 複雑度`。**閾値は 8。** 意味はこの表が分かりやすいです。

| その関数の網羅率 | 許される複雑度 |
| --- | --- |
| 100% | 8 |
| 80% | 7 |
| 50% | 4 |
| 0% | **2** |

**テストすれば複雑さを許す**という自己調整が組み込まれています。単純な関数はテストが無くても通り、
複雑な関数はテストが無いと通りません。ノブがひとつで済むので、全社で同じ数字を使えます。

### mutation testing — テストが本当に効いているか

コードを 1 か所ずつ機械的に壊し、テストが気づくか見ます。気づかなければ「その壊し方は誰も
見ていない」ということです。

**カバレッジ 100% でも起きます** — コードは実行されているが結果を誰も確かめていない、という状態を
捕まえます。gauntlet の中で唯一、**テストを増やすだけでは通せない**ゲートです。

### lint と型チェック

ルールは各リポジトリが持ちます。gauntlet は件数を増やさせないだけで、どのルールを有効にするかには
口を出しません。

## 既存のリポジトリが赤で埋まらないか

**埋まりません。** 導入時点の違反数を `gauntlet.baseline.json` に記録し、**それを増やさないこと
だけ**を要求します。減れば自動で締まります。

- **触った関数** — 絶対的に CRAP ≤ 8 を要求（これから書くコードには厳しい）
- **触っていない箇所** — 現状維持でよい

「初日から全部直せ」にはなりません。触ったところから良くなっていきます。

`gauntlet.baseline.json` はエージェントが編集できないよう `PreToolUse` フックで守られます。
赤を消す最短経路が「基準を緩める」になってしまうためです。人間は編集できます。

## 導入

### 1. パッケージのアクセス許可（リポジトリごとに一度だけ）

gauntlet は private パッケージなので、消費側リポジトリの `secrets.GITHUB_TOKEN` は既定では読めません。

[パッケージ設定](https://github.com/orgs/tepshq/packages/npm/gauntlet/settings) →
**Manage Actions access** → 導入先リポジトリを **Read** で追加。

飛ばすと CI の `npm ci` が `403 permission_denied: read_package` で落ちます。

> `Internal` 可視性ならこの手順は要りませんが、Team プランでは使えません。

### 2. 入れる

`.npmrc` に scope の指定が要ります（無いと npmjs.com を見て 404 になります）。

```
@tepshq:registry=https://npm.pkg.github.com
```

```bash
V=$(node -p "require('vitest/package.json').version")
npm i -D @tepshq/gauntlet "@vitest/coverage-v8@$V" @stryker-mutator/core @stryker-mutator/vitest-runner
```

**`@vitest/coverage-v8` はリポジトリの vitest とバージョンを揃えます**（上の 1 行目）。
無指定だと最新（4.x）が入り、vitest 3.x のリポジトリでは peer 依存の衝突で
`npm i` 自体が失敗します（duct で実測）。

入れたら、そのまま一度叩きます:

```bash
npx gauntlet init
```

これが skill（`.claude/skills/gauntlet`）を含む 4 ファイルを置きます。この時点の
測る範囲は既定値なので、たいてい「測る対象: 0 ファイル」と警告が出ます — それで正常です。
範囲は次の手順で決めます。

### 3. 測る範囲を決める

**Claude Code で `.claude/skills/gauntlet` を使ってください**（手順 2 の `init` が
置いたものです）。推測で入れると測る範囲が狭いまま緑になり、それが一番気づけない失敗になります。

エージェントがリポジトリを読み、理由つきで範囲を提案し、合意してから `init` を叩く流れです。
`tsconfig.json` の `include` は当てになりません（生成物・設定ファイル・e2e が混ざります）。

```bash
npx gauntlet init --default-branch=main --include='src/**/*.ts' --exclude='src/**/*.test.ts'
```

`init` が置くのは薄いファイルだけです。ロジックは全てパッケージ側にあるので、更新は npm の
バージョンを上げるだけで済みます。何度叩いても結果は同じです。

| 置くもの | 内容 |
| --- | --- |
| `.claude/settings.json` | **フック 2 つ**（下記）。既存の設定は壊しません |
| `.claude/skills/gauntlet/SKILL.md` | 測る範囲を決め直すときに使う skill |
| `gauntlet.config.json` | このリポジトリの事実。閾値は入りません |
| `.gitignore` | 足りない行だけ追記 |

**CI の workflow は置きません。** CI が要るもの（DB などのサービス、マイグレーション、
Node のバージョン、private パッケージの認証）は gauntlet からは見えないので、
**既に動いている job に 1 行足す**のが基本形です。

```yaml
      - run: npx gauntlet run --tier=pr
```

その job には `fetch-depth: 0`（差分の起点に全履歴が要る）と **Node 22 以上**が必要です。
足せる job が無い場合の雛形は skill が持っています。

### Claude Code の挙動が変わります

`init` は `.claude/settings.json` にフックを 2 つ足します。**このリポジトリで Claude Code を
使う全員に効きます。**

**`Stop` フック** — エージェントが応答を終えようとするたびに `gauntlet run --tier=turn` が走り、
赤なら**終了できずに直しにいきます**。人間が「テスト通してね」と言わなくてよくなる代わりに、
毎ターン数秒〜数十秒かかります（実測は下の表）。

**`PreToolUse` フック** — エージェントが `gauntlet.baseline.json` を編集しようとすると止めます。
赤を消す最短経路が「基準を緩める」になってしまうためです。人間は普通に編集できます。

既に `.claude/settings.json` がある場合、**既存のフックやプラグイン設定はそのまま残ります**
（追記するだけで、同じものは二度足しません）。

また `.claude/skills/gauntlet/` に skill が 1 枚入ります。測る範囲を決め直すときに
「gauntlet の設定を見直して」と言えば起動します。

## 規約: 外部サービスを要するテストは `integration` project に置く

DB・ネットワーク・実ファイルシステムに触れるテストは、vitest の `projects` で `integration` と
いう名前の project にまとめてください。gauntlet は **`turn` でこれを除外し、`pr` でのみ
走らせます**。設定項目はありません。

```ts
projects: [
  { extends: true, test: { name: "unit", include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"] } },
  { extends: true, test: { name: "integration", include: ["**/*.integration.test.ts"] } },
]
```

**手元に DB が無いだけで毎ターン赤になると、ゲートが環境によって答えを変えます。** それが数回
起きると、緑の意味が信じられなくなって誰も見なくなります。mutation も同じで、変異ごとに DB
テストを走らせると実行不能になります。

`projects` を使っていないリポジトリでは何もしなくて構いません（統合テストが増えるまで無害です）。

> JS/TS にはこれといった標準がありません（Java の `*IT.java`、Go のビルドタグ、pytest の
> マーカーに相当するものが無い）。ファイル名だけで除外する案は**動きません** — vitest の
> `--exclude` は `projects` に伝わらず、project を使うリポジトリで黙って無効になります。
>
> **誰も強制しません。** project に入れ忘れた DB テストは `turn` に入り、DB を持たない人の
> 環境でだけ落ちます。そのときは project を直してください。

## 使う

```bash
npx gauntlet run --tier=turn
npx gauntlet run --tier=pr
```

通れば exit 0、違反または gauntlet 自身が走れなければ exit 2 です。**「走れなかった」を緑に
しません** — 走らないゲートが緑に見えると、緑の意味が実行ごとに変わってしまうためです。

## 要件

- Node >= 22
- vitest
- 単一パッケージ（workspaces は未対応）
- TypeScript のバージョンに下限はありません。gauntlet がパースできれば構いません

## 実測

| repo | テスト数 | `turn` | `pr` |
| --- | --- | --- | --- |
| gauntlet 自身 | 241 | 1.0 秒 | 12 秒 |
| hue | 412 | 5.5 秒 | 24 秒（CI） |
| teps | 3822 | 10.4 秒 | 199 秒（CI） |
| duct | 3770 | 20 秒 | 未計測 |

`turn` は差分に関係するテストだけを走らせるので、変更したファイルによって前後します。

## 設計

判断とその理由、**何を意図的に入れていないか**は [DESIGN.md](DESIGN.md)。
実装の経緯と実測は [PLAN.md](PLAN.md)。
