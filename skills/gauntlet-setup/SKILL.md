---
name: gauntlet-setup
description: gauntlet の導入・更新と、測る範囲の見直し。
disable-model-invocation: true
---

# gauntlet の導入と更新

この skill は `npx skills add tepshq/gauntlet -a claude-code` が置く。gauntlet 本体の
インストールから種置きまで、全部ここの手順で行う。

**新しい版に上げるだけなら「更新する」へ。0〜6 は新規導入の手順。**

**測る範囲はユーザーと決める。** 範囲が狭いまま緑になるのが、このツールで一番気づけない
失敗だから、判断が割れる場所は必ず訊く。

## 0. 何をするか説明して、進めてよいか訊く

**リポジトリに触る前に、これを言う。** 相手は gauntlet を知らない前提で、専門語を使わずに:

> gauntlet は、エージェントが書いたコードを人間が読まずに済ませるための品質ゲートです。
> 入れると **`git commit` のたびに検査が走り、通らなければコミットできなくなります**。
> 検査するのは 3 つ — テストが通るか、型が合うか、**複雑なのにテストが薄い関数が無いか**。
>
> 検査の対象にする範囲はこれから一緒に決めます。**対象に入れた場所は、触ったときに
> テストを書く圧力がかかります。外した場所は今までどおりです。**
>
> 入れるものは devDependencies が 3 つと、設定ファイルが 3 つ（`gauntlet.config.json` /
> `.claude/settings.json` / `.gitignore` への追記）。CI に 1 行足すのも後で相談します。
> （pnpm のリポジトリでは `pnpm-workspace.yaml` にも 1 行入ります。理由は入れるときに説明します）

**完了条件** — ユーザーが「コミットが止まること」と「対象に入れると何が起きるか」を
理解した上で、進めてよいと言っていること。

## 1. 依存を入れる

リポジトリのパッケージマネージャに合わせる（`packageManager` フィールドが正。無ければ
`pnpm-lock.yaml` / `yarn.lock` / `bun.lock` / `package-lock.json` から判定する）。
`node_modules` が無ければ、先にリポジトリ自体を install する — 後の手順でテストを走らせる。
**`postinstall` で落ちることがある**（Prisma の `generate` が `DATABASE_URL` を要求する等。
clone 直後や DB を持っていない手元では必ず落ちる）。要求された環境変数にダミー値を渡して
通す — 値は使われない。gauntlet の導入とは無関係な工程なので、ここで止まらない。

**版は `npm view` で調べて明示する。** pnpm は既定で**公開から 24 時間**経った版しか
選ばない（`minimumReleaseAge`。供給網対策）。だから `latest` を任せると古い版が黙って入る
（実測: latest が 0.18.0 のとき `pnpm add` も `@latest` も 0.13.0。公開日の差は 31 時間）。
古い gauntlet は挙動が違い、skill を上書きしたり `.githooks/` を作ったりする。

```
V=$(npm view @teps/gauntlet version)
pnpm add -D "@teps/gauntlet@$V" @stryker-mutator/core @stryker-mutator/vitest-runner
```

- `-w` — pnpm の workspace root では要る（無いと `ERR_PNPM_ADDING_TO_ROOT`）
- `@teps/gauntlet` — フックが `npx gauntlet` で呼ぶ本体
- `@stryker-mutator/*` — `full` の mutation 用

npm / yarn / bun に 24 時間の待ちは無い。版の明示だけで足りる。

### pnpm が `pnpm-workspace.yaml` を書き換えたら、それでよい

24 時間経っていない版を名指しすると、pnpm は `minimumReleaseAgeExclude` に除外行を書く
（**そのファイルが無ければ新規に作る**）。宣言した 3 ファイルの外なので**ユーザーに伝える**が、
**元に戻さない** — これが唯一の正しい経路。

`--config.minimumReleaseAge=0` で書き換えを避けるのは**間違い**（実測）。解決時にしか効かず、
書き上がった lockfile が以降**すべての pnpm コマンド**で弾かれる:

```
✗ Lockfile failed supply-chain policy check
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] @teps/gauntlet@0.18.1 was published at ...
```

決めてもらうことが 1 つある。pnpm が書くのは版ピン（`@teps/gauntlet@0.18.1`）なので
上げるたびに増える。`@teps/gauntlet*` のワイルドカードにすると 1 行で済むが、
**この依存を供給網の待ちから恒久的に外す**判断になる。どちらにするか訊く。

**間接依存が同じ理由で弾かれることがある**（h3 では stryker 経由の
`update-browserslist-db`）。自動では除外されないので、名指しされたものを
`minimumReleaseAgeExclude` に足すか、24 時間経った版に落とす。
**pnpm 11 の overrides は `pnpm-workspace.yaml`** — `package.json` の
`resolutions` も `pnpm.overrides` も読まれない。

**coverage provider（`@vitest/coverage-v8`）は gauntlet に任せる。** vitest の**完全一致**の版を
peer に要求するので、版を選び損ねると install ごと失敗する。足りなければ `gauntlet quick` が
版を埋めた 1 行を出すので、それをそのまま打つ。

vitest が無いリポジトリは対象外（gauntlet の要件）。その場合はユーザーに伝えて止まる。

**テストが 1 件も無いリポジトリは、先に 1 件書いてもらう。** ゲート自体は 0 件でも通るが、
step 6 の `doctor` が「mutation が回るか」を確かめられない（Stryker はテストを 1 本も
走らせられないと落ちる）。純粋関数のテスト 1 件で足りる。

**完了条件** — `npx gauntlet --version` が npm の latest と一致していること
（pnpm は 24 時間ルールで古い版を選ぶので、**指定した版が入ったとは限らない**）。

## 2. リポジトリを読む

- `tsconfig.json` の `include` は手がかりであって答えではない。生成物（`.next/types`）、
  設定ファイル（`next.config.ts`, `vitest.config.ts`）、e2e が混ざっていることが多い
- TypeScript が置かれている最上位ディレクトリを実際に列挙する
- **ルート直下の `.ts` も 1 つずつ分類する。** 設定ファイルに紛れて製品コードが置かれて
  いることがある（duct ではルートの `proxy.ts` が Auth0 の認証ゲート本体で、最初の導入は
  これを測り漏らした）。**取りこぼしを見つけるのはここだけの仕事** — `init` は範囲について
  何も言わない
- テストファイルの命名規則（`*.test.ts` / `*.spec.ts` / `__tests__/`）
- 既定ブランチ（`git symbolic-ref --short HEAD` や `origin/HEAD`）
- **`vitest.config.*` の `coverage.exclude`。** ここで消されたファイルは網羅率が
  永久に 0% になる（gauntlet は `coverage.include` は上書きするが、`exclude` は
  上書きできない）。測る範囲に入れるなら、vitest 側の除外から外してもらう
- **`-test` / `-spec` を名前に含む製品コードは、設定を読んでも見つからない。**
  vitest 3 の既定 `coverage.exclude` は `**/*{.,-}{test,spec}?(-d).?(c|m)[jt]s?(x)` で、
  **ハイフン区切りにも当たる** — `settings/connection-test.ts` のような製品コードが
  テスト扱いで測定から消える（報告例あり。`full` が「網羅率を測っていないファイルが
  あります」で落ちる）。設定ファイルには何も書かれていないので、**ファイル名の側から
  探す**（`ls`/`glob` で `*-test.*` `*-spec.*` を当てる）。vitest 4 は既定の除外が
  空になったので、この形は 3 系だけの罠（実測）

### どう型チェックしているか

`package.json` の `typecheck` / `type-check` スクリプトを読む。**tsconfig が複数ある場合は要注意** —
`tsc -p tsconfig.src.json --noEmit && tsc --noEmit` のように 2 パスのことがある（teps が実例）。
gauntlet の既定は `tsc --noEmit --incremental` なので、そのままだと**半分しか見ない**。

上書きする場合も `--incremental` は残す — 2 回目以降の `quick` が数秒速くなる
（duct 実測 8.5s → 1.9s）。キャッシュ（`*.tsbuildinfo`）は速さだけを変え、診断は変えない。

### 外部サービスを要するテストはどれか

DB・ネットワーク・実ファイルシステムに触れるテストを探す。手がかり:

- `PrismaClient` / `new Pool(` / `$queryRaw` / `createClient(` の import
- `beforeAll` での接続や `listen(`
- 「ローカル DB に接続できません」のようなガード

**確定させるのは grep ではなく実行。** 候補が出そろったら、`.env` / `.env.local` を一時的に
別の場所へ退避して unit テストを走らせる。落ちるものだけが本物。環境変数を unset するだけ
では足りない — テストファイルが自前で dotenv を読む設計は普通にある（duct で実測。grep は
16 候補中 15 が偽陽性で、本物 1 件を取りこぼしていた）。

見つかったテストは**専用の vitest project に分けて、gauntlet の宣言から外す**。gauntlet は
`tests.projects` に**宣言された project だけ**を走らせる（実行・coverage・mutation 全部。
宣言が無ければ全部走る）。手元に DB が無いだけで赤くなるゲートは環境で答えが変わるし、
そういうテストの coverage は「通りすがりに実行しただけ」の行をテスト済みに見せる。
それらを回す場所は各リポジトリの既存 CI。

### CI はどうなっているか

**PR を使っているかを先に確かめる。** `git log --merges | head` が空なら、既定ブランチへ
直コミットする運用。そのリポジトリに `on: pull_request` の workflow を置くと**一度も
走らない** — 設定はあるので済んだように見えるのに、全量検査が事実上存在しない状態になる
（実際に踏まれた）。

**PR 運用へ移すのを勧める。** `on: push` にもできるが、その `full` は**何も止められない**
（既にコミット済みのものを事後に検査するだけ）。ゲートのつもりで置いたものが通知に
なるのは、`pull_request` のまま一度も走らないのと同じ種類の失敗。止める力があるのは
PR を塞ぐ `full` と、コミットを止める `quick`（フック）の 2 つだけ。
PR 運用へ移すなら branch protection の話になるが、**private + GitHub Free では ruleset が
使えない**（`Upgrade to GitHub Pro or make this repository public`）ので、そこも伝える。

`.github/workflows/` を全部見て、**`full` を足せる job** を探す。lint / 型チェック / テストを
回している job が普通は該当する。条件は 2 つ:

- `actions/checkout` に `fetch-depth: 0`（merge-base を取るのに全履歴が要る）
- Node が **22 以上**（gauntlet が `node:fs` の `globSync` を使う）
- **`timeout-minutes` が足りるか。** `full` は全テスト + mutation なので、既存の job の
  timeout では足りないことがある（duct は 15 分で打ち切られ、`full` 単体で 10 分 30 秒、
  mutation が走る差分では 30 分でも足りなかった）。**mutation が走る回の見積もりは
  「全テストの所要 × 数回」** — 変異を仕込む前に全スイートを 1 回走らせ、そのあと
  変異ごとに関係するテストだけを回すため。CI のテストが 10 分なら、mutation 込みで
  30 分は見ておく

gauntlet は宣言されたテストしか走らせないので、**`full` の job にサービスコンテナや DB の
初期化は要らない**。宣言外のテストは既存 CI の job がそのまま担う。

**完了条件** — TypeScript を含む最上位ディレクトリを 1 つ残らず挙げ、それぞれについて
「製品コードか、テストか、生成物か、設定か」を言えること。型チェックのコマンド、外部
サービスを要するテストの一覧、そして `full` を足せる job があるかどうかを言えること。

## 3. 測る範囲を提案して合意する

**それぞれについて、入れる理由か外す理由を言う。** ここでも専門語は使わない:

> `src`（63 ファイル）を検査の対象にします。ここが本体なので、触ったときにテストを
> 書く圧力がかかるのが狙いです。
>
> 外すのは 3 つ。`test` はテストそのもの、`playground` は動作確認用の遊び場、
> `bench` は速度計測です。どれも製品コードではないので、テストを要求しても意味が
> ありません。
>
> ひとつ相談です。`lib/import/session.test.ts` は DB が無いと落ちるので、このままだと
> DB を持っていない人の手元で毎回赤くなります。テストの設定を分けて、gauntlet からは
> 見えないようにしていいですか。

**テストファイルは数に入れない。** `*.test.ts` / `*.spec.ts` は gauntlet が測る対象から
自動で外す（テストにテストは書けないので、複雑なテストは網羅率 0% で必ず違反になる）。
提案するファイル数も、この後の検算も**テストを除いた数**で言う。

**完了条件** — 対象と除外のそれぞれについてユーザーが可否を答え、**外した場所は
検査されないと理解した上で**同意していること。

## 4. 入れる

```
npx gauntlet init --default-branch=<branch> --include=<glob,glob> --exclude=<glob,glob> --test-projects=<name,name>
```

**`--include` はファイルを名指しする glob で書く。** 3 で合意したのはディレクトリ名だが、
`--include=src` はディレクトリ自身にマッチして**中の `.ts` を 1 つも連れてこない**
（glob として成立するので、綴りの誤りと見分けがつかない形で対象が 0 になる。h3 で実測）。
渡す形は `--include='<dir>/**/*.ts'`、複数なら `--include='<dir>/**/*.ts,<dir>/**/*.ts'`。
**シェルの展開を避けるため引用符で囲む。**

**範囲を書き換えるのはフラグを渡したときだけ。** フラグ無しの `init` は骨組み（フック・
.gitignore）の整備だけで、既存の `gauntlet.config.json` はそのまま（出力が「変更なし」と言う）。
だから gauntlet を上げたあと叩き直しても範囲は消えない。`--test-projects` は project を
使っていないリポジトリでは省く（全部走る）。

型チェックの上書きが要る場合は `gauntlet.config.json` の `commands.typecheck` に書く
（`init` にフラグは無い）。範囲を直すために `init` を叩き直しても `commands` は残る。

測った件数の検算は 5 の完了条件で行う。基準を 2 か所に置かない。

### 起動点は自動で配線される

`quick` は Claude Code の `PreToolUse` フックが、**エージェントがコミットしようとした瞬間**に
呼ぶ。`init` が `.claude/settings.json` に書き、このファイルはコミットで伝播するので、
**配線の手作業は無い**（clone した全員に効く）。

### 外部サービスを要するテストを分ける

2 で見つけていたら、ここで vitest の設定を分ける:

```ts
projects: [
  { extends: true, test: { name: "unit", include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/*.db.test.ts"] } },
  { extends: true, test: { name: "db", include: ["**/*.db.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**"] } },
]
```

この例なら宣言は `--test-projects=unit`。**宣言できるのはインラインの project だけ**
（別ファイルへの glob 参照は名前が読めないため、mutation で残せない）。

`**/.claude/**` の除外は全 project に入れる。Claude Code の worktree が `.claude/worktrees/` に
リポジトリ丸ごとのコピーを作ることがあり、その中のテストまで拾うと件数が倍増する
（duct で 600 ファイル拾った実例）。

## 5. CI で `full` を回す

**既に動いている job に 1 行足す**のが基本形。サービス・Node・認証・`fetch-depth: 0` が
その job には全部揃っているので、一番確実で重複も生まない。

```yaml
      - run: npx gauntlet full
```

足せる job が無ければ作る。以後これは**リポジトリのファイル**で、gauntlet は二度と触らない。
`postinstall` が環境変数を形式上要求する場合（Prisma の `generate` 等）はダミー値を `env:` に置く。

```yaml
name: gauntlet
# 直コミット運用なら on: push も置けるが、それは通知であってゲートではない（上記）
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
```

**job の Node が 22 未満なら、別 job を作るか、CI の Node を上げてもらうかを訊く**
（アプリが載る Node を変える話なので、gauntlet の都合で決めてよいことではない）。

### ゲートが実際に止めることを確かめる

`init` が設定を正しく書いたことはテスト済みだが、**書いた設定で本当にコミットが止まるか**は
Claude Code 側の話なので gauntlet からは検査できない。ここで一度だけ実地に確かめる。

**`--include` に渡したディレクトリの直下**に `gauntlet-probe.ts` を作り、これを丸ごと書く
（CC 4・網羅率 0 で CRAP 20。閾値 8 を確実に超え、型チェックは通るので**落ちる理由が
CRAP に一意に定まる**）:

```ts
export function probe(a: number, b: number): number {
  if (a > 0) return 1;
  if (b > 0) return 2;
  if (a === b) return 3;
  return 0;
}
```

`git add <probe パス> && git commit -m "probe"` を**エージェント自身の Bash 呼び出しで**行う
（スクリプトに包むとフックがコマンド文字列から `git commit` を見つけられず、
素通りして確認にならない）。

**`git add -A` にしない。** init が書いた 3 ファイルはまだコミットされていないので、
`-A` だと probe commit に巻き込まれ、取り消しで一緒に消える。結果は 3 通り:

- **拒否され、出力に `CRAP` と `gauntlet-probe.ts` が出た** → 期待どおり。`rm <path>` だけで
  片付く。フックは**呼び出し全体を実行前に止める**ので `git add` も走っておらず、
  ステージは空のまま（`git restore --staged` は「そんなファイルは知らない」で落ちる）
- **コミットが通った** → ゲートが発火していない。`git reset HEAD~1 && rm <path>` で取り消し、
  **Claude Code を再起動**してやり直す（フックはセッション開始時に読まれる可能性があり、
  `init` と同じセッションでは効かないことがある）。**`--hard` は使わない** —
  コミットの中身に関わらず未コミットの変更を全部捨てるので、init の設定ごと消える
- **`CRAP` 以外で落ちた**（テストや型） → ゲートの確認になっていない。そちらを直してから戻る

**完了条件** — `npx gauntlet quick` が通り、`測る対象 N 関数（M ファイル）` の **M** が
3 で合意した**テストを除いたファイル数**と一致すること（関数の数は数えていないので
突き合わせない）。テスト込みの数と突き合わせると、テストまで測っている状態が
「検算済み」として確定する（duct では 1475 でぴったり一致してしまった）。
**上の probe でコミットが拒否され、`git log` の HEAD が動かず、片付け後に `git status` が
probe を作る前と同じに戻っていること。** 外部サービスが無い状態でも `quick` と `full` が
通ること（宣言が効いている証拠）。`full` を回す job が 1 つあり、上の 2 条件を満たすこと。

## 6. ラチェットの種を置く

`full` を**手元で一度回して**、できた記録のファイルをコミットする。

**`full` の mutation は実ファイルを書き換える**（Stryker の `--inPlace`）。正常に終われば
戻すが、**途中で止めると計装コードが残り、戻す手段は `git checkout` しかない** —
同じファイルの未コミットの作業も一緒に消える。**書きかけを持ったまま回さない。**
導入コミットの時点では変異対象が 0 なので実害は無いが、以降は毎回これが当てはまる。

```
npx gauntlet full
```

初回は「`gauntlet.baseline.json` を作りました。…コミットしてください」で**落ちる**。
これが正常。ファイルはできているので、コミットしてもう一度回せば通る。コミットは
`git add gauntlet.baseline.json` でも `git add -A` でも構わない — フックが止めるのは
**書き換える形**の Bash コマンド（リダイレクト・`sed -i`・`rm`・`git restore` 等）だけで、
読む・add するコマンドは通る。

**種を置くのは手元の仕事。** CI が置いた種はコンテナの中に書かれて捨てられ、毎 PR が
その PR の状態を許容値として置き直すので、ラチェットが一度も噛まない。

置いた種は数字だけ（`{ "crap": 35, ... }`）。**中身はユーザーに見せる**:

```
npx gauntlet list
```

許容している違反を悪い順に、次の一手（要る網羅率 / 割るしかない）つきで全部並べる。
ここで未参照コードや網羅率 0 の公開 API が見つかることがある（h3 では 3 件）。
直すかどうかは導入とは別の判断なので、一覧を見せて終わりでよい。

### mutation が実際に走ることを確かめる

`full` の mutation は差分から対象を決めるので、**導入コミット（設定ファイルだけ）では
必ず「変異対象 0 ファイル」で緑になる**。4 つのゲートのうち mutation だけが一度も
動かないまま終わるので、ここで一度だけ確かめる。

```
npx gauntlet doctor
```

Stryker が対象リポジトリの vitest を起動できるかだけを見る（変異は作らない）。
落ちたら Stryker の出力が添えられるので、それを読んで直す。

**完了条件** — `gauntlet.baseline.json` が履歴にあり、`npx gauntlet full` が通ること。
`npx gauntlet doctor` が通ること。

## 触らないもの

`gauntlet.baseline.json` は許容する違反数の記録で、減らすのは gauntlet が自動で行う。
編集と、書き換える形の Bash コマンド（リダイレクト・`sed -i`・`rm`・`git restore` 等）は
`PreToolUse` フックで止まる。読む・`git add` は通る。赤を消すには違反そのものを直す。
マージで衝突したときも手で直さない — `npx gauntlet quick` を一度実行すると
厳しい側で自動解決されるので、あとは `git add` してコミットする。

## 記録を締める作業は、コミットしてから測る

生き残りや未計測を潰したあと、**`full` を 2 回回さないこと。** 記録が締まるのは
clean なツリーの実測だけなので（作業途中の値を基準にしないため）、コミット前に測ると
その計測は捨てられ、コミット後にもう一度測ることになる。mutation は一番高い段なので、
これが 1 ファイル直すたびに 2 回分の時間になる（報告例では 79 秒 × 2）。

```
潰す → git commit → npx gauntlet full   # ここで測って、そのまま記録される
```

得られる情報は同じで、計測は 1 回。落ちたら直してまたコミットする。**結果を知る前に
コミットすることになるが、`quick` は commit のたびに走っているので型もテストも CRAP も
既に緑**で、mutation の判定だけが後から出る形になる。

記録が動いたら「許容値を締めました」と出るので、その記録をコミットする（実装と記録で
2 コミットに割れるのは意図どおり — 記録の変化が差分に出る方がレビューの目が届く）。

**この手順は「コミットしても差分が空にならない運用」が前提。** 既定ブランチへ直接
コミットしていると、コミットした瞬間に差分の起点が HEAD に並んで**変異対象が 0 に落ち、
測ることすらできなくなる**。PR 運用（feature ブランチ）なら起点は既定ブランチのままなので
成立する。直コミット運用でこの作業をするなら、作業用のブランチを切ってからにする。

## 更新する

すでに入っているリポジトリを新しい版に追随させる手順。範囲は変わらないので、
確認を挟まず上から通す。

**最初にこの skill 自身を最新にする。**

```
npx gauntlet --version              # 上げる前の版。控えておく（下の「版ごとの後始末」の引き金）
npx skills add tepshq/gauntlet -a claude-code -s gauntlet-setup -y
```

**そのうえで `SKILL.md` を読み直してから下へ進む。** いま読んでいるのは上書きされる前の
本文で、新しい版が要求する後始末はそこに書かれていない。記録の形式が変わったことも
配線が変わったことも知らないまま緑に見える、というのがこれを飛ばしたときの失敗の形。

**差分の有無で読み直しを分岐しない。** 過去に `skills update` を打ったリポジトリは実体が
`.agents/skills/` にあり `.claude/skills/` は symlink なので、中身が古くても `git status` は
空になる。読み直しはタダなので、条件を付けると偽の緑を作るだけになる。
skill に版番号も無い（lock が持つのは内容ハッシュだけ）。

```
V=$(npm view @teps/gauntlet version)
npm i -D "@teps/gauntlet@$V"        # 上げるのはこれだけ。PM の判定と pnpm の 24 時間ルールは 1 と同じ
npx gauntlet init                   # フラグ無し
npx gauntlet quick
```

**フラグ無しの `init` は範囲を書き換えない**（4）。`gauntlet.config.json` の
`include` / `exclude` / `tests.projects` も手書きの `commands` もそのまま残り、
`.claude/settings.json` のフックと `.gitignore` だけが今の版の形に揃う。旧配線は撤去される。

**skill の追随は `add` を打ち直す。`npx skills update` は使わない** — 実体を
`.agents/skills/`（多数の agent が共有する置き場。`~/.agents` があると対象が広がる）へ
移して `.claude/skills/` を symlink にするため、**追跡済みの `SKILL.md` が「削除」扱いに
なる**（h3 で実測。6 行の変更が 324 行削除に化けた）。`update` のオプションは
`-g` / `-p` / `-y` だけで、置き場所を指定する `-a` を受け付けない。

**完了条件** — `npx gauntlet --version` が npm の latest と一致すること（1 の完了条件と
同じ理由）。`npx gauntlet quick` が通り、`package.json` / lockfile /
`.claude/settings.json` / `.claude/skills/gauntlet-setup/` / `skills-lock.json` が
コミットされていること（後ろの 2 つは `skills add` が書く）。

### 版ごとの後始末

**控えた「上げる前の版」を、下の各項目が名指ししている版と突き合わせる。** その版より前から
上げたなら当てる。全部より新しければ何も要らない。新しい後始末が増えれば項目が増えるので、
判断の根拠は常にこの一覧そのもので、覚えておく閾値は無い。

**記録の `mutation` を `{}` にする作業は、エージェントには実行できない。** guard が
`gauntlet.baseline.json` の書き換えを止めるからで、これは正しい動作（緩める経路を塞ぐ
仕組みに、更新のための例外を開けない）。**該当したらユーザーに編集を頼み、そのあと
`full` を回す。** 頼むときは、どの項目に当たったのかと、回し直すと何が置き直されるのかを
言う。

0.16 以前が入っていたリポジトリには残骸がある:

```
git config --unset core.hooksPath   # 0.13 の pre-commit 配線
rm -rf .githooks                    # 0.13 が置いたフック
rm -rf .claude/skills/gauntlet      # 0.9.x の旧名 skill
```

- `.claude/settings.json` に `Stop` フック（0.12 以前）が残っていたら消す
- **0.22.1 でフックが `hook` 1 本に変わった。** 上の `init` で配線が入れ替わる
  （guard / quick / precommit の旧配線は自動で撤去される）。旧配線のままだと
  二重に走るか、`if` の解釈が揺れる環境でコミット以外にも quick が走る
- **手元では通るのに CI でだけ mutation が落ち続ける場合**、0.23 より前の記録が原因
  （打ち切りの数を持たないため、速い機械の Timeout が遅い CI で Survived に流れた分を
  吸収できない）。記録の `mutation` を `{}` にして clean なツリーで `full` を回す
- **テストを足しただけで mutation が落ちる場合**、0.22 より前の記録が原因
  （測った変異の数を持たないため、テスト追加で測定範囲が広がった分を区別できない）。
  記録の `mutation` を `{}` にして clean なツリーで `full` を回すと、新形式で置き直される
- **`full` が「リポジトリ全体の違反が 0 → N に増えました」で恒久的に落ちる場合**、
  0.24.1 より前に置いた種が原因（crap が計測を中断した回に `"crap": 0` が書かれた。
  中断の合図は「網羅率を測っていないファイルがあります」や「テストが落ちているため
  計測できません」）。**触っていないのに大量に増えたと言われるのが目印。** 記録を
  丸ごと消してもらい、clean なツリーで `full` を回して置き直す。0.24.1 以降は、
  計測を完了しなかったゲートの欄は書かれない
- **0.20.0 より前に mutation を回した記録は、触っていないファイルの生き残りを含みうる。**
  0.19 までは「1 文でも実行された」で変異対象を決めていたので、バレルを import しただけの
  ファイルまで対象になり、その生き残りが許容値として記録された（duct では 17 ファイル
  587 件）。記録の `mutation` を空（`{}`）にして `full` を回し直し、置き直す
- `.npmrc` に `@tepshq:registry=https://npm.pkg.github.com` があれば消す。gauntlet は
  0.9.0 から public npm にあり認証は要らない（残っていると新しい版が見えない）。
  workflow の `registry-url` / `NODE_AUTH_TOKEN` も、gauntlet のためだけなら外す
