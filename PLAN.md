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

### 4. ratchet と baseline ガード

- 触った関数 → 絶対閾値
- リポジトリ全体 → baseline 比較、悪化で fail
- baseline は改善時のみ自動更新、後退は明示フラグ
- `PreToolUse` で `Bash` と `Edit|Write`(baseline パス) を塞ぐ

**完了条件** — baseline を悪化させる変更が fail する。
エージェントとして baseline を書き換える 2 経路（`Bash` / `Edit`）が両方ブロックされることを、実際に試して確認済み。

### 5. `init` と setup skill

- 置くのは薄いファイルのみ: `.claude/settings.json` のフックエントリ / `gauntlet.config.json` / CI workflow / setup skill 1 枚
- `init` の最後にフル計測してキャッシュを温める
- `gauntlet doctor`（TypeScript バージョン判定を含む）

**完了条件** — 素の TypeScript プロジェクトに `init` を打つと、その直後の最初のターンで `turn` が緑になり、キャッシュが温まっている。config の中身は skill 経由でエージェントが決めている。

### 6. mutation testing（`pr` のみ）

Stryker + vitest runner、`--since` + `--incremental`。

**完了条件** — assert を取り除いた弱いテストを入れると `pr` が赤くなる。
その状態で `turn` は緑のまま（tier の役割分担が意図通り）。

### 7. パイロット投入

- **hue** — 機構そのものの検証。既に 87.8% カバー済みなので、テストを書く作業と混ざらない
- **teps** — 規模（2222 テスト）と coverage provider 導入の検証
- **duct** — まず `npm install` が通るかの確認から

**完了条件** — hue で実際の PR が 1 本 gauntlet を通ってマージできる。
3 リポジトリそれぞれで `turn` の実測時間を記録し、上のベースライン表に追記済み。

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
