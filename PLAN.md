# 実装計画

[DESIGN.md](DESIGN.md) を実装する順序。上から順に進める。
各ステップは「前のステップが動いていることを前提に、次の判断材料を得る」ように並べてある。

閾値・tier・差分の起点といった確定値は [DESIGN.md](DESIGN.md) にあり、ここには再掲しない。

## 実測済みのベースライン（2026-08-07）

設計判断の根拠になった数値。再取得には各リポジトリでテストスイートを回す必要があるので残す。

| repo | test files | tests | src LOC | 実測 |
| --- | --- | --- | --- | --- |
| hue | 20 | 412 | 4.6k | `vitest run --coverage` **4.96s** / stmt 87.8% branch 81.4% func 78.5% |
| teps | 183 | 2222 | 31k | `vitest run` **7.89s**（coverage provider 未導入）/ `tsc --noEmit` **1.65s** |
| duct | 397 | — | 60k | 依存が未 install（`typescript` も `vitest` も無い） |
| qm | 530 | — | 123k | `node --test`・vitest 無し → v1 対象外 |
| ccaf | 4 | — | 3.3k | workspaces → v1 対象外 |

teps の `vitest run` は real 7.89s に対し user 49.96s で、既にコアを飽和させている。
並列化による短縮の余地は小さい。

### `oxc-parser` の実測（リポジトリ全体、`turn` は変更ファイルのみなので上限値）

| repo | files | size | parse | walk | parse errors |
| --- | --- | --- | --- | --- | --- |
| hue | 45 | 262 KiB | 37ms | 9ms | **0** |
| teps | 372 | 2.9 MiB | 187ms | 43ms | **0** |
| qm | 1049 | 9.4 MiB | 712ms | 137ms | **0** |

対象 3 本は TypeScript 5.5 / 5.8 / 5.9 とバラバラだが、全て 0 エラーで読めた。
全関数が位置情報を持つ（qm: 22,817 / 22,817）。名前が直接取れるのは 2〜3 割。

### 部分実行 coverage の完全性（hue、`--changed HEAD~5`）

マージ方式を捨てた根拠。

| | full | partial |
| --- | --- | --- |
| 実行時間 | 4.96s | **4.88s**（節約ほぼ無し） |
| 変更された 4 ファイル | 20/20, 214/238, 17/17, 213/263 | **全て完全一致** |
| 変更されていない 17 ファイル | 計測あり | **全て欠落**（過少は 0 件） |

`--changed` は変更ファイルを import する全テストをモジュールグラフから選ぶので、変更ファイルの coverage は部分実行で完全になる。
なお hue は vitest 側に coverage 閾値（lines 89% / functions 80% / statements 89% / branches 82%）を設定しており、部分実行がそれに引っかかって落ちた。gauntlet は実行時にこれを無効化する必要がある。

### hue に対する CRAP の実測（閾値 8）

| 項目 | 値 |
| --- | --- |
| 対象関数 | 406（解析 23ms） |
| CRAP > 8 | **1 件**（0.2%） |
| 網羅率 0 の関数 | 71 |
| CC 分布 | 1:240, 2:54, 3:49, 4:23, 5:23, 6+:17 |
| 最も複雑な関数 | CC=8・網羅率 100% → CRAP ちょうど 8 で通過 |

`coverage-final.json` 全体の stmt は 1392/1557 = 89.40% で、vitest 報告の covered 数と一致する（割り当ての検算）。
よく整備されたリポジトリに対して閾値 8 はほとんど赤を出さない。ただし CC=8 の関数は判定点があと 1 つで落ちる。

---

## ステップ

進捗の正はここ。各ステップの見出しに状態を書く。

### 1. リポジトリ初期化と dogfooding の土台 — 完了

`package.json` / `tsconfig.json` / `vitest.config.ts`、および自分自身用の `gauntlet.config.json`。

TypeScript 7 要求の一次検証を兼ねる。ここで詰まるなら、パイロット投入前に設計へ戻れる。

**完了条件** — `npm install` が通り、`npx tsc --noEmit` と `npx vitest run` が両方緑。
`node_modules/typescript` の実バージョンが 7 系であることを確認済み。

TypeScript 7.0.2 で通った。ただし TS 7 の compiler API が無い件が判明し、パーサを `oxc-parser` に切り離した（DESIGN §2）。

### 2. 2 枚の抽象を先に固定する — 完了

共用すべきものは契約であって機構なので、先にここを書く。

- **アダプタが吐く JSON のスキーマ** — 関数単位の `{ file, name, line, cc, coverage, crap }` と実行メタ情報
- **tier の契約** — `turn` / `pr` がそれぞれ何を実行し、何を返し、どの exit code を出すか
- `gauntlet.config.json` の JSON Schema と起動時検証

**完了条件** — 不正な `gauntlet.config.json` を渡すと非ゼロで落ち、それを固定するテストがある。
レポート JSON の型が 1 か所に定義され、`turn` と `pr` が同じ型を返す。

実装で決まったこと:

- **config は「リポジトリの事実」だけを持つ。** 閾値やポリシーは全社共通なので入らない。`additionalProperties: false` にして、書いたつもりの設定が黙って無視されるのを防ぐ。
- **CRAP の式は core が持つ。** アダプタは cc と coverage を報告するだけ。2 言語目で式が 2 つになるのを防ぐ。
- **`CheckResult` に `skip` が無い。** 走らなかったチェックがあると緑の意味が実行ごとに変わる。走れないなら fail。
- **exit code は 0 と 2 のみ。** 違反も内部エラーも 2。`Stop` フックは exit 2 だけを阻止として扱い、それ以外を素通しするため、走れなかった gauntlet が緑になってはいけない。区別はメッセージで伝える。

### 3. CRAP の計算 — 完了

- 関数単位の cyclomatic complexity（AST）
- Istanbul coverage JSON から関数単位の coverage を引く
- `vitest --changed <merge-base> --coverage` の実行と、プロジェクト側 coverage 閾値の無効化

**キャッシュとマージは実測の結果、捨てた**（上の実測表と DESIGN §2）。部分実行の coverage は変更ファイルについて完全で、マージすると加算により偽の緑を作る。

**完了条件** — hue の変更ファイルについて、部分実行から出した CRAP がフル実行から出した CRAP と一致する。
テストが 1 つも無い変更ファイルが網羅率 0 として落ちる。
CRAP を超えた関数が、名前を持たないアロー関数であっても一意に名指しされている。

hue に対する通しの実測（起点 `HEAD~5`）:

| 項目 | 値 |
| --- | --- |
| 変更ファイル | 7（うち src の非テスト 4） |
| テスト | 412 件緑・**4.7 秒** |
| coverage に現れたファイル | 4（変更されたものだけ） |
| 触った関数 | 160 |
| CRAP > 8 | 1 件 — `src/server.ts:582 buildChannels > (anonymous)` CRAP 12.0 |

フル実行から出した違反と同一。152 関数を照合して不一致 0 件。
「テストが 1 つも無い変更ファイル」はユニットテストで固定してあり、通しでの確認は未実施。

**vitest の exit code は使わない。** プロジェクトが coverage 閾値を設定していると部分実行は必ず下回って exit 1 になり、しきい値の CLI 上書きは glob キー付き設定に効かない（hue で実測）。JSON reporter でテスト結果を、`coverage-final.json` で網羅率を別々に読む。これで設定の形に依存しなくなる。

### 4. ratchet と baseline ガード — 完了

- 触った関数 → 絶対閾値
- リポジトリ全体 → baseline 比較、悪化で fail
- baseline は改善時のみ自動更新、後退は明示フラグ
- `PreToolUse` で `Bash` と `Edit|Write`(baseline パス) を塞ぐ

**完了条件** — baseline を悪化させる変更が fail する。
エージェントとして baseline を書き換える 2 経路（`Bash` / `Edit`）が両方ブロックされることを、実際に試して確認済み。

実装で決まったこと:

- **差分は行単位で見る。** ファイル単位だと 1 行直しただけでそのファイルの全関数が絶対閾値の対象になり、既存リポジトリが即座に赤くなる。
- **未コミットの変更と新規ファイルを含める。** エージェントはコミットせずにターンを終えるので、コミット済みだけでは書いたばかりのコードが素通りする。
- **リポジトリ全体のラチェットは `pr` でだけ判定する。** 部分実行の coverage を全体に当てると偽陽性が出る（hue で 201 件）。
- **改善は gauntlet 自身が自動で baseline に固定する。** エージェントは baseline を触れないので、改善の記録は道具側の仕事になる。
- baseline の後退を git HEAD と比較して弾く仕組みは**作らなかった**。`PreToolUse` ガードで足りているうちは二重にしない。

gauntlet 自身に対する通し（dogfooding）:

```
gauntlet turn: pass (559ms)     差分なし
  ✓ typecheck (174ms)  ✓ tests (0ms)  ✓ crap (18ms)

gauntlet turn: fail (685ms)     未テストで CC 5 の関数を足した状態  exit 2
  ✗ crap  CRAP 30.0 (> 8)  複雑度 5 / 網羅率 0%  src/bad.ts:1 messy
```

### 5. `init` と setup skill — 完了

置くのは薄いファイルのみ: `.claude/settings.json` のフックエントリ / `gauntlet.config.json` / CI workflow / setup skill 1 枚。

キャッシュを温める工程は無い（ステップ 3 でキャッシュごと捨てた）。
`gauntlet doctor` は作らない — TypeScript の下限は gauntlet のチェック項目であって別コマンドではなく、今それを読む呼び出し元が無い。

**完了条件** — 素の TypeScript プロジェクトに `init` を打つと、その直後の最初のターンで `turn` が緑になる。
既にある `.claude/settings.json` を壊さない。

素の vitest プロジェクト（2 テスト）での通し:

```
$ gauntlet init
  gauntlet.config.json / .claude/settings.json
  .github/workflows/gauntlet.yml / .claude/skills/gauntlet/SKILL.md

$ gauntlet run --tier=turn          差分なし
gauntlet turn: pass (1390ms)  ✓ typecheck (603ms) ✓ tests (0ms) ✓ crap (27ms)

$ gauntlet run --tier=turn          未テストで CC 5 の関数を足した状態   exit 2
gauntlet turn: fail (670ms)
  ✗ crap  CRAP 30.0 (> 8)  複雑度 5 / 網羅率 0%  src/broken.ts:1 tangled
```

**新規ファイルにテストが無いと `tests` は 0 件で通る。** `--changed` が選ぶテストが無いため。
これは crap 側が網羅率 0 として捕まえるので穴にはならないが、2 つのチェックの合わせ技で成立している。

パッケージ名は **`@tepshq/gauntlet`**。開発中止した旧 gauntlet と同名で、registry 上のものは作り直す。

### 6. mutation testing（`pr` のみ）— 完了

Stryker + vitest runner。変更されたソースだけを `--mutate` に渡す。

**完了条件** — assert を取り除いた弱いテストを入れると `pr` が赤くなる。
その状態で `turn` は緑のまま（tier の役割分担が意図通り）。

**`--inPlace` が必須。** Stryker は既定でサンドボックスにコピーし、その過程で
`ts.parseConfigFileTextToJson` を呼ぶ。TypeScript 7 にその API は無く落ちる
（Volar や ts-jest が壊れているのと同じ根っこ）。`--inPlace` はコピーしないので前処理が走らない。
実ファイルを書き換えるが、mutation は CI でしか走らせないので作業ツリーは使い捨て。
Stryker 9.6.1 が最新で、修正版は無い。

`--since` は CLI に無い。`--mutate` が `file:startLine:startCol-endLine:endCol` の範囲指定を取れるので、
必要になればそちらで行単位に絞れる。今は変更ファイル丸ごと渡している。

`NoCoverage` は数えない。それは網羅率の話で CRAP が既に見ている。
mutation が独自に捕まえるのは「テストは通るが assert が弱い」ケースなので `Survived` だけを違反にする。

**変異対象は「変更されたファイル」ではなく「この差分で走ったテストが触れたソース」。**
変更ファイルだけを対象にすると、テストの assert を消しただけの差分では対応するソースが
変異対象から外れ、mutation ゲートを素通りできた（gameable）。完了条件の検証で実際に踏んだ。
coverage レポートに現れたファイルを渡すことで塞いだ。

gauntlet 自身に対する `pr` の推移:

| 状態 | Survived | 備考 |
| --- | --- | --- |
| 変更ファイルのみを対象 | 23 | うち 1 件は等価変異（`Stryker disable` で除外） |
| 上を全て潰した | 0 | 変異 347 件中 |
| 対象をテストが触れたソースに拡大 | **53** | 対象が広がって新しい穴が出た |

変異の種類（`StringLiteral` 等）だけで信号かノイズかは判断できない。
実際 `PreToolUse` の `matcher` を空文字にしてもテストが気づかなかった —
つまり「baseline ガードが起動しなくなっても緑」の状態だった。

**mutation にもファイル単位のラチェットを置いた**（DESIGN §3）。gauntlet 自身の種は:

```
config.ts 17 / complexity.ts 12 / coverage.ts 10 / ast.ts 8 / guard.ts 4 / その他 0〜1
```

**「触った関数の中の変異だけを絶対的に見る」は入れなかった。** ラチェットが既に
「増やさない」を保証しており、その上に 2 つ目の機構を足す根拠がまだ無い（CLAUDE.md の YAGNI）。
ラチェットだけでは足りない証拠が出たら足す。

gauntlet 自身に対する `pr`: **12.6 秒**で `lint`（未実装）以外すべて緑。

**baseline は記録が無ければ最初の実測値を種にする。** 0 から始めると既存リポジトリは
導入した瞬間に赤で埋まって誰も入れられない。gauntlet 自身では 12 が置かれた。

### 6.5 lint — 完了

eslint を `--format json` で叩き、ファイルごとのエラー数を mutation と同じラチェット
（`ratchetByFile`）に載せた。ルールは対象リポジトリが持つ。warning は数えない。

この過程で **TypeScript 7 の下限要求を撤回**した（DESIGN §5）。`typescript-eslint` の
peer 範囲が `<6.1.0` で、TS 7 では lint ゲートそのものが成立しないため。
gauntlet 自身も TypeScript 6.0.3 に落とし、`typescript` は runtime 依存から外した
（`oxc-parser` に切り替えて以降どこも import していない死んだ依存だった）。

ランタイム依存は **ajv / istanbul-lib-coverage / oxc-parser** の 3 つだけ。

gauntlet 自身に対する `pr`: **14.6 秒で全 5 ゲート緑**（typecheck 0.5s / tests 0.7s /
crap 0s / lint 0.5s / mutation 12.8s）。テスト 203 件。

### CI の実測（tepshq/gauntlet#1、GitHub Actions）

| | ローカル | CI | 比 |
| --- | --- | --- | --- |
| mutation | 13.8 秒 | **86 秒** | **6.2 倍** |
| `pr` 全体 | 15.6 秒 | 92 秒 | — |

CI で確認できたこと: `merge-base` の `origin/main` フォールバックが効く、
`--inPlace` の Stryker が動く、全 5 ゲートが緑になる。

**mutation が予算の支配項。** hue はローカル 137 秒なので CI では 10 分超が見込まれる。
teps（2222 テスト）と duct はさらに大きい。実数が出てから、以下のどれかを検討する:
`--concurrency` を CI のコア数に合わせる / 対象を触った関数の行範囲まで絞る（保留していた案）/
mutation を別ジョブにして PR のブロックから外す。

### private パッケージのアクセス（GitHub の手続き）

消費側リポジトリの `secrets.GITHUB_TOKEN` は、別リポジトリが所有する private パッケージを読めない。
hue の CI が `403 permission_denied: read_package` で落ちて判明した。

`Internal` 可視性なら解決するが、**tepshq は Team プランで internal が使えない**
（UI には出るが「organization administrators によって無効」と表示される）。
org レベルの secret に PAT を置く案は、寿命の長い個人トークンを org 全体の CI に置くことになるので採らない。

→ パッケージ設定の **Manage Actions access** で導入先リポジトリを個別に Read 許可する。
gauntlet の機能ではなく GitHub 側の手続きなので、`init` にも skill にも入れず README に書く。

### teps（進行中、`adopt-gauntlet` ブランチ）

測る範囲は対話で決めた。`tsconfig.include` は当てにならず、機械的には決まらない例:

| 除いたもの | 理由 |
| --- | --- |
| `tests/` | 133 ファイル中 132 がテスト。ここを測るとテストを測ることになる |
| `e2e/` | Playwright。vitest では走らないので coverage も mutation も意味を持たない |
| `scripts/` | デモと一度きりの移行スクリプト。出荷される製品コードではない |
| ルート直下の `.ts` | `next.config` `vitest.config` 等の設定 |

測る対象は `src` / `components` / `app` / `lib` の **170 ファイル**。

| | 実測 |
| --- | --- |
| `turn`（ソース 1 ファイル変更） | **10.4 秒**（typecheck 2.6s / tests 7.6s） |
| `pr` | **64 秒**（typecheck 2.6s / tests 9.6s / lint 2.3s / mutation 40.9s） |

`turn` の 10.4 秒は目標の 10 秒を超えている。テスト 7.6 秒が支配項で、
`src/dsl/schema.ts` のような中核ファイルは多くのテストから import されるため。

teps で見つけて直したもの:

- **`commands.typecheck` がシェルを通っていなかった。** teps は `tsc -p a.json --noEmit && tsc --noEmit`
  の 2 パスで、`&&` が tsc の引数になって `error TS5042` で落ちた。`sh -c` 経由にし、
  `node_modules/.bin` を PATH の先頭に置く。
- **eslint はマッチしない glob が 1 つでもあると即エラーで死ぬ。** 測る範囲の指定として
  `src/**/*.tsx` のように空になる組み合わせは普通にある。`--no-error-on-unmatched-pattern` を渡す。
- **eslint の失敗原因を握り潰していた。** 標準エラーにしか出ないので、報告に混ぜる。
- **`tsc` は出力に実行ビットを付けない。** ローカルパス install で `Permission denied` になる。
  ビルドで `chmod +x` する。

### 一巡したら決めたいこと

**~~mutation が「0 件検査して緑」と「検査して問題なし」を区別していない。~~ 解決（0.0.10）。**
判定は足さず、全チェックが「何を見たか」を必ず出す形にした（`CheckResult.scope`、DESIGN §2）。
`✓ mutation (0ms)  変異対象 0 ファイル` と読めるので、沈黙が主張になった。

**重複（duplication）のゲートが無い。** 「検討して外したもの」にも入っておらず、単に
考えていなかった。旧版は jscpd で持っていた。実際、gauntlet 自身で同じ `capture` を
2 か所に書いてしまい、CRAP が 2 件の違反として並べたのを人間が読んで気づいた
— ツールは重複を検出していない。名前が違えば見逃していた。

**mutation の判定が run 間でブレる（hono で実測）。** 同じコード・同じテストの 2 回の `pr` で、
差分が触れていないファイルの Survived が 9 → 10 になり ratchet が落ちた。並列実行下の
timeout 揺れが疑わしい。ratchet は「増やさない」を厳密比較で課しているので、
ブレ 1 件がそのまま赤になる。許容幅・リトライ・timeout 隣接の扱いのどれで受けるかは未決。

**~~integration テストを gauntlet が見るべきか~~ 決着（2026-08-08）: どの tier も見ない。**
実行・coverage・mutation から束で除外した（DESIGN §2）。Stryker には project フィルタが
無いので、リポジトリの vitest 設定から `integration` project を濾した一時設定を生成して
渡す形にした。**duct への影響**: 次に gauntlet を更新すると全体 CRAP が 761 → 772 に
増えるため、baseline の明示的な後退更新（フラグ + PR 説明）が一度だけ要る。
判断の根拠になった実測（duct、25 ファイル・134 テスト）:

| | 全テスト | integration なし | 差 |
| --- | --- | --- | --- |
| テスト | 7355 | 7221 | 134 |
| 覆われている関数 | 5979 | 5947 | **32**（全て `lib/`） |
| CRAP > 8（全体） | 761 | 772 | **+11**（+1.4%） |

integration でしか覆われていない関数は 6669 中 32（0.5%）で、`lib/import/session.ts`・
`lib/destructive/audit.ts`・`lib/diff-preview/build-input.ts` 等の DB 境界に集中。
新たに違反になる 11 件の多くは `jsonOrNull` や `uniqueProductIds` のような
ユニットテスト可能な純粋ヘルパーで、要求される圧力は「DB をモックしろ」ではなく
「ヘルパーに単体テストを書け」に近い。hue は integration を持たず、teps は単一 project
（e2e は Playwright で vitest の外）なので、影響があるのは duct と今後の導入先だけ。
なお hono の変異対象膨張（27 ファイル）は integration project では**なく** fan-in の大きい
ユニットテストが原因なので、この除外では解決しない — 別の問題として残っている。

### 7. パイロット投入

- **hue** — 機構そのものの検証。既に 87.8% カバー済みなので、テストを書く作業と混ざらない
- **teps** — 規模（2222 テスト）と coverage provider 導入の検証
- **duct** — まず `npm install` が通るかの確認から

**完了条件** — hue で実際の PR が 1 本 gauntlet を通ってマージできる。
3 リポジトリそれぞれで `turn` の実測時間を記録し、上のベースライン表に追記済み。

### hue（完了、`adopt-gauntlet` ブランチにコミット済み）

旧 `@tepshq/gauntlet` 0.8.0 を完全に除去（`.gauntlet/` 5 ファイル・`gauntlet.config.mjs`・
依存・scripts 5 本）。`lint` と `depcruise` は旧 gauntlet 経由で eslint と dependency-cruiser を
呼んでいただけなので、下地のツールを直接叩く形に戻した。

| | 実測 |
| --- | --- |
| `turn` | **5.36 秒**（typecheck 0.6s / tests 4.7s / crap 0s） |
| `pr` | **142 秒**（うち mutation **137 秒**） |
| 測る対象 | 24 ファイル（`src` + `bin`） |
| CRAP 違反 | 1（seed 済み） |
| mutation 生き残り | 590（seed 済み。`server.ts` 137 / `stream.ts` 103 / `runner.ts` 68 が上位） |

`turn` の 4.7 秒はテスト実行。設定ファイルを変更しているため vitest が全テストを選んでいる状態で、
ソースだけの変更ならもっと短くなる。

**CI（0.0.2、差分スコープ前）: 成功。ただし 948 秒（うち mutation 932 秒）。**
GitHub Packages の認証経路がこれで検証できた（パッケージ設定の Manage Actions access で
`tepshq/hue` に Read を付与した後）。同時に、mutation の範囲を絞る修正が
必要だったことの裏付けにもなった — 24 ファイル全部を変異させて 15.5 分かかっている。

パイロットで見つけて直したもの（いずれも hue で実際に踏んだ）:

- **`init` が冪等でなかった。** 測る範囲を直すために 2 回叩いた結果フックが二重登録され、
  毎ターン gauntlet が 2 回走る状態になっていた。同じ内容は二度足さないようにした（0.0.2）。
- **CI の workflow に GitHub Packages の認証が無かった。** `npm ci` の時点で必ず落ちる。
- **CI では `git merge-base HEAD main` が解決できない。** checkout は対象ブランチしか
  ローカルに作らないため。`origin/main` へフォールバックする。
- **`--inPlace` の Stryker が `stryker-setup-*.js` と `.stryker-tmp/` を残す。**
  前者は実行後に消し、後者は `init` が `.gitignore` に足す。

- **`npx stryker` が対象リポジトリに Stryker が無いと npm から非推奨の別パッケージを取ってくる。**
  `node_modules/.bin/stryker` を直接見て、無ければ導入コマンドを示して止める。
- **下位ツールのエラーを握り潰していた。** レポートが出ていないときは Stryker の出力を添えて落とす。
- **`init` が測る範囲を黙って推測していた。** 対象外に TypeScript がある場所を出すようにし、
  skill を「エージェントがリポジトリを読み、理由つきで提案し、ユーザーの同意を得てから
  `init` を叩く」流れに書き直した（DESIGN §4）。tsconfig の `include` から機械的に導けるかを
  3 本で試したが、hue は正解・teps と duct は不正解で、判断が要ることが確認できた。

### duct（CI 緑、`try-gauntlet` ブランチ / tepshq/duct#563 — マージ待ち）

**唯一、リポジトリの持ち主が導入ガイドに沿って自分で入れた例**（skill はまだ実地で
試されていない — 開発者が読んだのはアーティファクトのガイド）。こちらが用意した
`adopt-gauntlet-v2`（#559）は使わず閉じた。導入手順そのものの検証がここで取れる。

測る対象は `lib` / `components` / `app` の `.ts` + `.tsx`（`src/` は無い）。

| | 手元 | CI |
| --- | --- | --- |
| `pr`（0.0.10、差分にソース無し） | 68〜82 秒 | 523〜791 秒 |
| うちテスト（7355 件） | 52〜66 秒 | 463〜694 秒 |

**注意: 3 本のパイロット全部で、これまでの緑は「触った関数 0 / 変異対象 0」。**
差分が設定とバージョン上げだけなので正しいが、ゲートが実際にソースを検査した緑は
まだ 1 つも無い（0.0.11 の検証で一時変更を作って mutation が判定を出すことだけは確認済み）。
各リポジトリで実際にソースを触る最初の PR が本当の試験。
→ 「実際にソースを検査した」実行そのものは hono の再生実験（下）で初めて取れた。
チームのリポジトリでの実 PR はまだ。

duct で見つけて直したもの:

- **`--exclude` の glob は vitest の `projects` に伝わらない。** 統合テストが `turn` でも走っていた。
  project 名で `--project=!integration` を指定する形に変えた。project を使っていない
  リポジトリでは無害なので、1 つの仕組みで両方に効く。
- **vitest はテストが落ちると coverage を書き出さない。** `coverage-final.json を読めません` が
  出て、本当の原因（テストの失敗）が見えなくなっていた。落ちていたら coverage を読まない。
- **`git ls-files` は非 ASCII のパスを 8 進エスケープする。** 日本語ファイル名で `ENOENT`。
  全 git 呼び出しに `core.quotePath=false` を付け、読めないファイルは 0 行として扱う。
- **`coverage.include` のずれを黙って緑にしていた。** 既定の `src/**/*.ts` のまま入れると
  duct には `src/` が無いので対象 0 件で緑になる。`measurementFaults` を入れた（0.0.8）。
- **baseline が履歴に無いままだった。** `pr` を CI でしか回していないので種が捨てられ、
  ラチェットが一度も噛んでいなかった。種を置いた回は落とすようにした（0.0.8）。
- **変異の範囲が設定ファイルの変更で爆発した。** `--changed` が選んだテストの coverage を
  範囲にしていたため、`package.json` / `vitest.config.ts` を触る差分では全テストが選ばれる。
  duct の実測で **全 664 テストファイル・7230 テストが走り、変異対象が 520 ファイル**
  （teps は 135 ファイルで 47 分）。導入 PR 自身が必ず設定ファイルを触るので、
  種を置くための最初の `pr` が最も回らなかった。「変更されたソース ∪
  変更されたテストが覆うソース」に変えて、上限を差分が決める形にした（0.0.9）。
- **既存の `ci.yml` が壊れた。** `@tepshq/gauntlet` は private なので、gauntlet に依存した
  瞬間、認証を持たない他の workflow の `npm ci` が 401 で落ちる。`init` は自分の workflow に
  認証を書くだけで、他の workflow のことを何も言っていなかった。
- **`init` が CI workflow を配るのをやめた（0.0.10）。** 生成された workflow は既存 CI と
  重複した上、Postgres も migrate も seed も無く、手で足したそれは `init` の再実行で消える。
  CI が要るものは gauntlet からは見えない。既に動いている job に 1 行足す形を基本にし、
  雛形は skill が持つ。今日踏んだ CI 側の問題 5 件のうち 4 件がこの形なら起きなかった。
- **mutation が判定を出せなかった（0.0.11）。** 30 行の `.tsx` に 2 分 07 秒かけて
  11 変異中 8 件が timeout、`.ts` は dry run が落ちて 1 件も走らなかった。原因は 2 つ:
  退避先の `.stryker-tmp/` が**リポジトリ内**なので duct の vitest がそのコピーを
  テストとして拾い（22 件の照合エラー、DB 行の二重書き込み）、加えて static 変異が
  変異ごとに全スイート（55 秒）を走らせていた。退避先を外に出し、`--ignoreStatic` を入れた。

  | | 元 | 退避先を外へ | + `ignoreStatic` |
  | --- | --- | --- | --- |
  | 時間 | 127 秒 | 69 秒 | **27 秒** |
  | Timeout | 8 | 7 | **0** |
  | 判定が出た変異 | 3 | 4 | **1** |

  `--ignoreStatic` は取引で、timeout していなかった判定（Killed 2・Survived 1）も失う。
  失った件数は出力に出す。副作用として、`describe` 直下で値を作るテストが変異を
  殺せなくなった（以前は静的変異として全テストが変異込みで走るので偶然殺せていた）。
  gauntlet 自身のテスト 2 か所がこれに該当し、`it` の中に移した。
- **Node 22 未満で読めないエラーになった（0.0.10）。** `node:fs` の `globSync` を使うので
  22 以上が要る。`engines` は宣言してあるが npm は警告だけで通し、実行時にモジュール解決で
  `does not provide an export named 'globSync'` だけを出して落ちる。入口を薄い層に分けて、
  中身を読み込む前にバージョンを見る。Node 20 の docker で文言と exit 2 を実測して確認した。

duct 側で片付いたもの（#563 上で解消。いずれもガイド／skill の穴として gauntlet 側に還元済み）:

- ~~CI の `npm ci` が 403~~ — Manage Actions access に `tepshq/duct` を Read で追加した
- ~~workflow に Postgres が無い~~ — `ci.yml` と同じ service container・migrate・seed を足した
- ~~`jscpd` / `dependency-cruiser` / `"gauntlet"` キー~~ — 削除した（中止した旧版の名残だった）
- ~~baseline が履歴に無い~~ — 手元で `pr` を回して種を置き、コミットした（crap 761）

### hono（パブリックリポジトリでの再生実験、2026-08-08）

honojs/hono（★31k、vitest 4、単一パッケージ、テスト 4795 件・src 177 ファイル）に
ローカルの scratch clone で導入し、**マージ済み PR を merge-base に再生**して
「エージェントがターンを終えた直後」と同じ形（未コミットのソース差分）を作った。
gauntlet は設計通り `origin/main` を優先するので、再生では起点用のローカル ref
（`replay/base` のような `/` 入りの名前）を `defaultBranch` に指す必要がある。

| 実行 | 結果 | 時間 |
| --- | --- | --- |
| `turn`（設定のみの差分、全 4795 テスト選択） | pass 触った関数 0 | 8.1 秒 |
| `turn`（PR #5196 = etag 修正の実差分） | **fail CRAP 12.0** | **2.2 秒**（テスト 17 件） |
| `pr`（同差分。フル + lint + mutation） | fail（CRAP + 種置き） | **257 秒**（うち mutation 245 秒） |

**ゲートが実際にソースを検査した初の実行。** そして最初の実弾が
「CRAP ≤ 8 の厳しさ」（DESIGN §7-4）の実データになった:
hono のメンテナが普通にマージした etag の修正が、**網羅率 100% でも CC 12 で落ちる**。
リポジトリ全体では CRAP > 8 が **86 関数 / 1146（7.5%）**。hue の 1/406（0.2%）と桁が違う。
テストが良質でも CC > 8 の関数を触った瞬間にリファクタリングを要求される、が
このルールの実際の重さ。

mutation の実測も設計の想定を 1 つ超えた: 変更されたテストが etag の 1 本でも、
そのテストは `new Hono()` でフレームワーク全体を通すので、「変更されたテストが覆うソース」が
**27 ファイルに広がって 245 秒**（CI 換算 25 分規模）。単体テストでなく統合寄りのテストを
持つリポジトリでは、テスト 1 本の変更が変異対象を大きく引き延ばす。
生き残りの種は 230 件（url.ts 42 / buffer.ts 35 / reg-exp-router/node.ts 26 …）
— よく整備されたリポジトリでも assert の弱さは普通に残っている。

baseline をコミットして同じ差分で `pr` をもう一度回すと（260 秒）、**mutation の判定が
run 間でブレた**: 差分が触れていない `smart-router/router.ts` の生き残りが 9 → 10 になり、
ratchet が落ちた。同じコード・同じテストで 2 回走らせて答えが変わるのは flaky そのもの。
Stryker の verdict は並列実行下の timeout 揺れで Survived に流れうる。
「変更されたテストが覆うソース」が変異対象を広げるほど、触っていないファイルの
ブレを踏む面積が増える。→「一巡したら決めたいこと」に追加。

hono で見つけて直したもの（0.0.13 に入った）:

- **fault 判定が「触った関数 0 の turn」を誤検知していた。** vitest は `--changed` のとき
  coverage を変更ファイルだけに絞るので、設定だけの差分では「全テスト走行・coverage 空」が
  正常。それを「噛み合っていない」と誤認して落ちた（4795 テストで実測）。
  coverage を期待できる実行（`pr` は常に、`turn` は触った関数 > 0）でだけ当てる形に直した。
- **lint の scope が「エラーのあったファイル数」を言っていた。** hono は eslint エラー 0 なので
  「lint 対象 0 ファイル」になり、309 ファイル見たのに何も見ていないのと区別できなかった。
  eslint が報告したファイル数を言う形に直した。

duct 側に残っているもの（duct の判断待ち）:

- **Prisma client が schema とずれる**ことがある（`postinstall` の `prisma generate` が
  `DATABASE_URL` 無しで失敗するため）。gauntlet の問題ではない。
- **`ci.yml` と `gauntlet.yml` が lint / 型チェック / テストで重複している。** `ci.yml` が
  Node 20 なので 1 本にまとめられない。CI の Node を上げるかは duct の判断（#563 に記載）。
- **CI の `pr` が 13 分**（うちテスト 11.5 分。手元の 7 倍）。`gauntlet.yml` に timeout は無いが、
  テストが増えれば `ci.yml` の 15 分感覚を超えていく。

---

## 前提が崩れたら戻る先

| 起きたこと | 戻る判断 |
| --- | --- |
| TypeScript の下限要求で実プロジェクトの型チェックが通らない | 下限の設定（DESIGN §5） |
| `oxc-parser` が実コードをパースできない | パーサの選定（DESIGN §2） |
| `oxc-parser` の 0.x 更新で CC の値が動いた | パーサのバージョン固定方針（DESIGN §2） |
| CRAP ≤ 8 が dogfooding で機能しない厳しさだった | 閾値 8（DESIGN §3） |
| `turn` が数秒に収まらない | マージ方式（DESIGN §2）→ 最悪 CRAP を `pr` に移す |
| マージ済み coverage の精度が実用に足りない | マージ方式（DESIGN §2） |
| baseline の後退経路がまだ残っていた | ガードの網羅性（DESIGN §3） |
