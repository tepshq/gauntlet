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
| `quick` | **エージェントが `git commit` する直前**（手動でも叩ける） | 赤なら**コミットできず**、理由がエージェントに届いてそのまま直しにいく |
| `full` | CI | 赤なら**マージできない** |

`quick` が効くのが一番の違いです。人間が「テスト通してね」と言わなくても、エージェントは
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

裏返すと、**閾値 8 は複雑度そのものの上限でもあります** — 網羅率 100% では `CRAP = 複雑度` に
なるので、**複雑度 9 以上はどれだけテストを足しても通りません**（触った関数だけ。触らなければ
baseline が現状維持を許します）。そこで要るのはテストではなく関数を割ることなので、
gauntlet は違反 1 件ごとにどちらなのかを言います:

```
CRAP 30.0 (> 8)  複雑度 5 / 網羅率 0%  src/a.ts:10 f  → 網羅率 51% で通ります
CRAP 31.0 (> 8)  複雑度 31 / 網羅率 100%  src/proxy.ts:278 proxy  → 複雑度 9 以上はテストでは通りません。関数を割ってください
```

### mutation testing — テストが本当に効いているか

コードを 1 か所ずつ機械的に壊し、テストが気づくか見ます。気づかなければ「その壊し方は誰も
見ていない」ということです。

**カバレッジ 100% でも起きます** — コードは実行されているが結果を誰も確かめていない、という状態を
捕まえます。gauntlet の中で唯一、**テストを増やすだけでは通せない**ゲートです。

### 重複 — コピペを見る唯一のゲート

テストごと複製されたコードは CRAP も mutation も通ります。jscpd で重複トークン数を測り、
**増やさないこと**だけを要求します（絶対閾値なし・`full` のみ・減れば自動で締まる）。
jscpd は gauntlet が同梱するので、対象リポジトリに入れるものはありません。

### 型チェック

リポジトリの `tsc --noEmit` を走らせ、診断が出たら落とします。gauntlet が見るのは
「文句を言ったか」だけなので、2 パスや `vue-tsc` などコマンドが違っても
`commands.typecheck` に書けば動きます。

**lint は見ません。** どのルールを有効にするかはリポジトリが決めることで、gauntlet は
そこに判断を持ちません — 何を守っているか言えないゲートは置かない、という判断です
（0.18.0 で外しました。lint は各リポジトリの CI が回してください）。

## 既存のリポジトリが赤で埋まらないか

**埋まりません。** 導入時点の違反数を `gauntlet.baseline.json` に記録し、**それを増やさないこと
だけ**を要求します。減れば自動で締まります。

- **触った関数** — 絶対的に CRAP ≤ 8 を要求（これから書くコードには厳しい）
- **触っていない箇所** — 現状維持でよい

「初日から全部直せ」にはなりません。触ったところから良くなっていきます。

`gauntlet.baseline.json` はエージェントが編集できないよう `PreToolUse` フックで守られます。
赤を消す最短経路が「基準を緩める」になってしまうためです。人間は編集できます。

記録されるのは**数**だけなので、中身は `list` で見ます（ゲートではないので通ります）。

```bash
npx gauntlet list
```

```
CRAP 違反 35 件 / 測る対象 411 関数（50 ファイル）（gauntlet.baseline.json の許容 35）
  CRAP 132.0 (> 8)  複雑度 11 / 網羅率 0%  src/utils/internal/path.ts:12 joinURL  → 複雑度 9 以上は…
```

悪い順に全部並ぶので、上から手を付けられます（h3 では未参照のまま残っていた関数が
2 つと、網羅率 0 の公開 API が 1 つ、この一覧から見つかりました）。

## 導入

**出発点は 1 コマンドです。** gauntlet のインストールも不要です:

```bash
npx skills add tepshq/gauntlet -a claude-code
```

置かれるのは skill 1 枚（`.claude/skills/gauntlet-setup/`）と `skills-lock.json` だけ。
**この時点では何も有効になりません** — ゲートも設定も、範囲が決まってから入ります。

あとは **Claude Code で `/gauntlet-setup` を実行するだけ**です（「gauntlet を入れて」と
言っても起動します）。skill がここから先の全部 — 依存の投入（パッケージマネージャの
検出込み）、測る範囲の決定、外部サービスを要するテストの分離、CI への 1 行、
ラチェットの種置き、ゲートが実際に噛むことの確認 — をユーザーと対話しながら進めます。

推測で範囲を入れると、狭いまま緑になり、それが一番気づけない失敗になります。
エージェントがリポジトリを読み、理由つきで範囲を提案し、合意してから確定する流れに
してあるのはそのためです（`tsconfig.json` の `include` は当てになりません —
生成物・設定ファイル・e2e が混ざります）。

skill が更新されたら `npx skills update` で追随できます。

<details>
<summary>Claude Code を使わず手で入れる場合</summary>

```bash
# パッケージマネージャはリポジトリに合わせる（pnpm なら pnpm add -D）
# 版は npm view で調べて明示する — pnpm は既定で公開から 24 時間経った版しか選ばないので、
# latest を任せると古い版が黙って入ります（minimumReleaseAge。実測）。
npm i -D "@teps/gauntlet@$(npm view @teps/gauntlet version)" @stryker-mutator/core @stryker-mutator/vitest-runner
npx gauntlet init --default-branch=main --include='src/**/*.ts' --exclude='src/**/*.test.ts'
npx gauntlet quick
```

**coverage provider は手で足さないでください。** `@vitest/coverage-v8` はリポジトリの
vitest と**完全一致**する版でなければ install 自体が失敗します（`peer vitest@"3.2.7"` —
範囲ではありません）。足りなければ `gauntlet quick` が**版を埋めた 1 行**を出すので、
それをそのまま打てば済みます。範囲の決め方・CI・種置きは
[`skills/gauntlet-setup/SKILL.md`](skills/gauntlet-setup/SKILL.md) に全手順があります。

> 0.0.13 以前を GitHub Packages から入れていたリポジトリは、`.npmrc` の
> `@tepshq:registry=https://npm.pkg.github.com` の行と、workflow の
> `registry-url` / `scope` / `NODE_AUTH_TOKEN`（gauntlet のためだけのもの）を消してください。
> 残っていると新しいバージョンが見えません。

</details>

skill が範囲を決めたあと `gauntlet init --include=...` を叩き、**薄いファイル 3 枚**が
置かれます。ロジックは全てパッケージ側にあるので、更新は npm のバージョンを上げて
`init` を叩き直すだけで済みます（フックの形が変わっても、あなたの設定はそのままに配線だけ
入れ替わります）。

| 置くもの | 内容 |
| --- | --- |
| `.claude/settings.json` | **フック 2 つ**（下記）。既存の設定は壊しません |
| `gauntlet.config.json` | このリポジトリの事実。閾値は入りません |
| `.gitignore` | 足りない行だけ追記 |

既にある `.claude/settings.json` や `.gitignore` は**置き換えません**（足りないものだけ
追記）。**測る範囲を書き換えるのはフラグを渡したときだけ**なので、gauntlet を上げたあと
`npx gauntlet init` を叩き直しても、決めた範囲も手書きの `commands` も消えません。

**CI の workflow は置きません。** CI が要るもの（Node のバージョン、`postinstall` が
要求する環境変数など）は gauntlet からは見えないので、
**既に動いている job に 1 行足す**のが基本形です。

```yaml
      - run: npx gauntlet full
```

その job には `fetch-depth: 0`（差分の起点に全履歴が要る）と **Node 22 以上**が必要です。
足せる job が無い場合の雛形は skill が持っています。

### Claude Code の挙動が変わります

`init` が `.claude/settings.json` に `PreToolUse` フックを 2 つ足します。
**配線の手作業はありません** — このファイルはコミットで伝播するので、clone した全員に効きます。

**1. コミットの検問** — エージェントが `git commit` しようとすると `gauntlet quick` が走り、
赤なら**コミットそのものが実行されません**。「履歴に入った状態はすべて検査済み」が
不変条件になります。違反の内容はエージェントに直接届くので、そのまま直しにいきます:

```
PreToolUse:Bash hook error: [npx gauntlet quick]: gauntlet quick: fail
  ✗ crap  CRAP 42.0 (> 8)  複雑度 6 / 網羅率 0%  src/probe.ts:1 tangled
```

**2. baseline の保護** — エージェントが `gauntlet.baseline.json` を編集しようとすると
止めます。赤を消す最短経路が「基準を緩める」になってしまうためです。人間は普通に編集できます。

> 人間がターミナルで直接打つコミットは検査されません（Claude Code のフックなので）。
> gauntlet の前提は「コードを書くのはエージェント」です。

既に `.claude/settings.json` がある場合、**既存のフックやプラグイン設定はそのまま残ります**
（追記するだけで、同じものは二度足しません）。

また `.claude/skills/gauntlet-setup/` に skill が 1 枚入ります。測る範囲を決め直すときに
「gauntlet の設定を見直して」と言えば起動します。

## gauntlet が走らせるテストは宣言する

gauntlet は `gauntlet.config.json` の `tests.projects` に**宣言された vitest project だけ**を
走らせます（実行・coverage・mutation すべて。宣言が無ければ全部走ります）。

DB・ネットワーク・実ファイルシステムに触れるテストは、専用の project に分けて**宣言から
外して**ください。そういうテストを走らせる場所は各リポジトリの既存 CI です。project の
名前も分け方も自由です — gauntlet に「integration テスト」という概念はありません。

```ts
// vitest.config.ts — 分け方の例
projects: [
  { extends: true, test: { name: "unit", include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.db.test.ts"] } },
  { extends: true, test: { name: "db", include: ["**/*.db.test.ts"] } },
]
```

```json
// gauntlet.config.json — この例なら unit だけを宣言する
"tests": { "projects": ["unit"] }
```

宣言は `init` のフラグでも書けます: `npx gauntlet init ... --test-projects=unit`

**手元に DB が無いだけで毎ターン赤になると、ゲートが環境によって答えを変えます。** それが数回
起きると、緑の意味が信じられなくなって誰も見なくなります。mutation も同じで、変異ごとに DB
テストを走らせると実行不能になります。

`projects` を使っていないリポジトリでは何もしなくて構いません（宣言なし = 全部）。

> glob でファイル名を除外する案は**動きません** — vitest の `--exclude` は `projects` に
> 伝わらず、project を使うリポジトリで黙って無効になります。project が vitest の選択を
> 正しく解釈する唯一の境界です。
>
> **宣言し忘れは黙って通りません。** 新しい project を作って宣言し忘れると、そのテストの
> coverage が gauntlet に届かず、触った関数が CRAP で赤になります。そのとき宣言を直して
> ください。

## 使う

```bash
npx gauntlet quick
npx gauntlet full
npx gauntlet list   # ゲートではない。baseline が許容している CRAP 違反を全部並べる
```

通れば exit 0、違反または gauntlet 自身が走れなければ exit 2 です。**「走れなかった」を緑に
しません** — 走らないゲートが緑に見えると、緑の意味が実行ごとに変わってしまうためです。

## 要件

- Node >= 22
- vitest
- 単一パッケージ（workspaces は未対応）
- TypeScript のバージョンに下限はありません。gauntlet がパースできれば構いません

## 実測

| repo | テスト数 | `quick` | `full` |
| --- | --- | --- | --- |
| gauntlet 自身 | 398 | 1.0 秒 | 20 秒 |
| hue | 412 | 5.5 秒 | 24 秒（CI） |
| teps | 3822 | 10.4 秒 | 199 秒（CI） |
| duct | 7213 | 64 秒 | 75 秒（手元） |

`quick` は差分に関係するテストだけを走らせるので、変更したファイルによって前後します。

## 設計

判断とその理由、**何を意図的に入れていないか**は [DESIGN.md](DESIGN.md)。
実装の経緯と実測は [PLAN.md](PLAN.md)。
