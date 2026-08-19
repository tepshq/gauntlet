---
name: pseudo-tested-audit
description: リポジトリの pseudo-tested 関数（テストに覆われているのに、本体を消しても 1 本も落ちない関数）を extreme mutation で棚卸しする
disable-model-invocation: true
---

# pseudo-tested-audit

対象リポジトリの関数を 1 つずつ「本体を `return undefined` に差し替えてもテストが落ちないか」で検査し、
**pseudo-tested**（覆われているだけで守られていない関数）の一覧を出す。coverage が言えない
「テストが本物か」に答える。ゲートではない — 出力は直す候補の一覧で、直す判断は人に残す。

計測の設計判断と実測値（duct で 17.5%、gauntlet 自身 0%、速度 188ms/変異 等）は gauntlet の
PLAN.md「extreme mutation」「positive control」の節が正。

## 既定の動き（引数なしで呼ばれたら）

**いま作業しているリポジトリ**が対象。origin の defaultBranch（gauntlet.config.json が
あればその `defaultBranch`、無ければ main）を**使い捨て clone** に取り、網羅率 > 0 の
**全関数**を回して、survived の一覧を報告する。
引数は上書きしたいときだけ: 別リポジトリ（`tepshq/duct`）、ブランチ、対象の絞り込み
（ディレクトリや「このブランチで新しく覆われた関数だけ」= ブランチ検証モード）。

## 前提

- gauntlet リポジトリの checkout から実行する（enumerate2.ts が `src/` の複雑度・coverage 実装を
  import する）。手元に無ければ使い捨てに clone する: `gh repo clone tepshq/gauntlet`
- 対象は vitest のリポジトリ。**使い捨て clone に対して回す**（ソースを一時的に書き換えるため）
- 外部サービスを要する vitest project（DB 等）は対象外にする。既定は `node,dom` — 対象の
  vitest.config を見て `XMUT_PROJECTS` 環境変数で合わせる

## 手順

1. **使い捨て clone を作って依存を入れる。** `postinstall` が環境変数を要求したらダミーで通す
   （例: prisma は `DATABASE_URL=postgresql://x:x@localhost:5432/x` で generate だけ通る）。
   フルスイートを 1 回回して全緑を確認してから先へ進む。赤いテストがあると全変異の判定が濁る。

2. **対象関数を列挙する（coverage 1 回 + AST）。**
   ```
   npx tsx skills/pseudo-tested-audit/enumerate2.ts <対象root> targets.json node,dom
   ```
   gauntlet の `analyze` と同じ関数集合に、変異位置（body の span）と網羅率が付く。
   網羅率 0 の関数は検査対象外（coverage が既に「テストが無い」と言っている）。

3. **仕込む（1 回だけ）。**
   ```
   npx tsx skills/pseudo-tested-audit/instrument.ts <対象root> targets.json ids.json
   ```
   全対象関数の body 先頭に「当番なら return undefined / 踏まれたら名乗る」の 1 行が入る。
   以降の変異切り替えはファイル書き換えなし（当番票 `.xmut-switch/active-id` の書き換えだけ）。

4. **配線する。** `xmut-setup.template.ts` の `__SW__` を `<対象root>/.xmut-switch` の絶対パスに
   置換して `<対象root>/xmut-setup.ts` に置き、対象の vitest.config の**全 project** の
   `setupFiles` に `"./xmut-setup.ts"` を足す。`mkdir -p <対象root>/.xmut-switch/trace` も忘れずに。

5. **回す。**
   ```
   npx tsx skills/pseudo-tested-audit/engine.ts <対象root> ids.json results.json
   ```
   地図作り（1 回の実行で「どのテストがどの関数を踏むか」を実測）→ 変異ループ。
   2 回目以降ソースが不変なら末尾に `reuse` で地図を使い回せる。
   ブランチ検証（「足されたテストは本物か」）は、`select-candidates.ts` で
   「新しく覆われた関数」に絞り、差分のテスト一覧を第 6 引数に渡すと
   killed-by-new / killed-by-old に分類される。

6. **復元して報告する。** `git checkout -- .` + `xmut-setup.ts` と `.xmut-switch` を消し、
   `git status --porcelain` が空であることを確認してから結果をまとめる。
   報告は survived の一覧（CC・網羅率・位置・関数名）+ 集計 + 測定条件（コミット SHA・対象 project）。
   **survived が成果物。** killed は flaky なテストの巻き添えで偽 kill になりうるので、
   kill の確定が要る文脈では、落ちたテストファイル単独で再実行して再現したときだけ kill と数える。

## 直しモード（頼まれたとき。既定は報告まで）

survived 1 件ごとに 3 択で仕分けて直す。着手順は件数ではなく**被害**で決める
（認可・外部送信・不可逆な書き込みが先。表示ラベルや dev 専用パスは後回し）。

1. **assert を足す・強める** — テストが踏んでいるのに落ちない = assert が居ない。
   戻り値か副作用への expect を、その関数の契約が分かる最小の形で足す。
2. **消す** — どのテストも気づかない関数は、そもそも呼ばれていないことがある。
   参照を数えて、死んでいれば実装ごと削除する（テストを足すより価値が高い）。
3. **受け入れる** — 意図して守らない場所（dev 専用・版差 shim）は、その旨のコメントを
   関数に書いて一覧から除外する。黙って放置はしない。

完了条件（1 件ごと・機械的）:
(a) engine を `reuse` で回し直して当該 id が **killed に反転**している
(b) スイート全緑
(c) diff が当該関数とそのテストの周りに閉じている

(a) があるので、このモードで足すテストは**構造的に飾りになれない** —
本体を消したら落ちることを確認してからしか完了できない。

## 規模感（実測）

| 対象 | 関数 | 所要 |
| --- | ---: | --- |
| gauntlet（269 関数） | 241 変異 | 数分 |
| duct の 1 ブランチ差分 | 117 変異 | 暖機 43s + 地図 28s + ループ 22s |
| duct 全量（未実施） | 約 6,900 変異 | 30〜60 分の見込み |

## 罠（全部実測で踏んだもの）

- **地図の保存名にテストのパスを使わない** — 長い clone パスで ENAMETOOLONG。template は sha1 済み
- **対象リポジトリに cwd 依存のテストがありうる** — engine は `process.chdir(対象root)` 済み。外すと壊す前から赤くなる
- **`=> ({...})` 形式のアローは括弧の内側に文を置けない** — instrument.ts はブロック化で処理済み
- **健康診断が赤のまま進めない** — その赤は全変異の判定に混ざる。engine は赤で止まる設計
