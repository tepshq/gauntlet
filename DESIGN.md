# gauntlet — 設計

チーム共用の品質ゲート。エージェントが書いたコードを、人間がコードを読まずに機械的な制約で縛る。

Robert C. Martin が 2026年7月に述べた方針（コードは読まず、テスト・カバレッジ・複雑度・mutation testing で囲む）を、チームの複数リポジトリに適用できる形にしたもの。

## 設計を貫く 2 つの語

以降の判断はほぼすべてこの 2 語に還元される。

**flaky** — 走ったり走らなかったりするゲート、環境によって答えが変わるゲートは、数回の食い違いで無視されるようになる。緑は常に同じ意味でなければならない。

**gameable** — エージェントが自分の書いたテストで自分を採点する構造では、通すための最短経路が「品質を上げる」ではなく「測定をすり抜ける」になる。最短経路を塞ぐ。

## 1. 位置づけ

- **人間のコードレビューは行わない。** コードレビューはエージェントが担当し、gauntlet は機械的な不変条件を担保する。
- **人間が書く受け入れ仕様（Gherkin 等）は当面持たない。** エージェント同士の閉ループを明示的に選択している。Gherkin は将来的な展望で、移行トリガーは設けていない。
- 帰結として、**gauntlet の数値が唯一の品質信号**になる。閾値を甘くする根拠が無い前提で以下が決まっている。

## 2. 構造

**単一コマンドが真実の源。** フックも CI も同じコマンドを呼ぶ。tier は 2 段、いずれも同期実行。

| tier | 起動点 | 中身 | 予算 |
| --- | --- | --- | --- |
| `turn` | Claude Code の `Stop` フック（exit 2 でエージェントに差し戻し） | 型チェック + 関連テスト + CRAP | 数秒 |
| `pr` | CI（PR をブロック） | 全テスト + 全体 coverage + CRAP + mutation + lint | 分単位可 |

番号ではなく起動点で呼ぶ。中間の tier（commit 時など）は作らない。

### 差分の起点

**両 tier とも「デフォルトブランチとの merge-base」。** 両者が違う集合を判定すると flaky になる。

### パーサ

**`oxc-parser` を gauntlet 自身の依存として固定し、対象プロジェクトの TypeScript から切り離す。**
対象の TypeScript でパースすると、リポジトリごとのバージョン差で同じコードの CC が変わりうる（flaky）。gauntlet が固定したパーサで測れば、全リポジトリで同じ関数が同じ CC になる。

TypeScript 7 の npm パッケージは従来の in-process な compiler API を持たない（`import ts from "typescript"` は `{version, versionMajorMinor}` のみ）。AST は `typescript/unstable/*` 経由でしか届かず、それは Go バイナリへの RPC クライアントで、呼び出しごとの起動コストが `turn` の予算を直撃する。7.1 で programmatic API が復活する見込みだが、切り離す判断はそれとは独立に成立する。

**coverage データから CC を導く経路は使えない。** v8 リマップ後の Istanbul JSON は `loc.end.column` が `null`、関数名が `(anonymous_0)`、`branchMap` が疎で、「どの関数が危ないか」を名指しできない。

**関数の識別は「位置 + 囲っている名前付きスコープ」で行う。** 実コードでは名前が直接取れる関数は 2〜3 割で、残りはアロー関数のコールバック等。`file.ts:47 の fetchUser 内の無名アロー` の形で報告する。

### `turn` の CRAP 算出

**`vitest --changed <merge-base> --coverage` の結果をそのまま使う。キャッシュもマージもしない。**

`--changed` は変更ファイルを import する全てのテストをモジュールグラフから選ぶため、**変更ファイルの coverage は部分実行でも完全になる**。絶対閾値をかける対象は触った関数だけなので、これで足りる。hue の実測では変更 4 ファイルの被覆数がフル実行と完全に一致し、変更されていない 17 ファイルは部分的に混ざるのではなく丸ごと欠落した（PLAN.md の実測）。

キャッシュ済みの全体 coverage とマージする案は捨てた。`istanbul-lib-coverage` のマージは**ヒット数を加算する**ので、弱められたテストの古い網羅率が残って偽の緑を作る（gameable）。しかも hue では部分実行 4.88s / フル実行 4.96s で、節約がほぼ無い。

**`CRAP 未計測` という状態は作らない。** 変更ファイルにテストが 1 つも無ければ、そのファイルは coverage に現れない。これは網羅率 0 として扱い、CC 3 以上なら落とす。飛ばさない。

**プロジェクト側の coverage 閾値は無効化して実行する。** 部分実行はリポジトリ全体の網羅率を下回るのが当然なので、そのまま走らせるとプロジェクトの `thresholds` 設定で誤って落ちる（hue で実測）。リポジトリ全体の網羅率は `pr` の ratchet が見る。

### mutation testing

**`pr` のみ。** 非同期フィードバックも常駐デーモンも作らない。
Stryker の vitest runner は `coverageAnalysis` を強制的に `perTest` にするため設定不要。`--since` + `--incremental` を使う。

gauntlet の中で**唯一「テストを増やすだけでは通せない」ゲート**であり、gameable を塞ぐ主要な役割を持つ。

## 3. 閾値とラチェット

**CRAP ≤ 8**（Uncle Bob の crap4java と同値）。CC の独立ゲートは持たない。
`CRAP = CC² × (1 − coverage)³ + CC` なので、実質的な意味は:

| coverage | 許される CC |
| --- | --- |
| 100% | 8 |
| 80% | 7 |
| 50% | 4 |
| 0% | 2 |

CRAP は「テストすれば複雑さを許す」自己調整機構を内蔵しているため、CC の独立ゲートは冗長。共用ツールとしてノブが 1 つで済む利点も大きい。

**触った関数は絶対閾値。リポジトリ全体は baseline ratchet。**
既存リポジトリを一括で赤にせず、触った箇所だけ確実に良くなる方向へ動かす。
副次的に「リポジトリごとに閾値を上書きする」機能が不要になり、閾値は全社で 1 つに保てる。

**baseline は改善時のみ自動更新。** 後退方向の更新は明示フラグ + PR 説明が必須。
**`PreToolUse` フックで 2 経路を塞ぐ**: `Bash`（baseline 更新コマンド）と `Edit|Write`（baseline ファイルパス）。塞がなければ「赤 → baseline 更新 → 緑」が最短経路になる（gameable）。

## 4. 配布と設定

- `npx @teps/gauntlet init` が**薄いファイルだけ**置く:
  `.claude/settings.json` のフックエントリ / `gauntlet.config.json` / CI workflow / setup skill 1 枚。
  ロジックはすべて npm パッケージ側にあり、生成物にロジックを持たせない。
- **更新 = devDependency のバージョン上げ。** 再生成も差分適用も managed block も無い。
  バージョンは固定する（`npx` のバージョン無指定は CI で非決定的になり flaky）。
- **config の中身はエージェントが repo を読んで決める**（同梱の setup skill 経由）。
  ユーザーは必ず Claude Code を使っている前提。対話式ウィザードは作らない。
- **JSON Schema を同梱し、`gauntlet run` が起動時に必ず検証する。** 不正なら即 fail。
  エージェントが自由に書くからこそ、機械的な検証が要る。

### 抽象は 2 枚だけ

1. **アダプタが吐く JSON のスキーマ**
2. **tier の契約**

プラグイン解決機構・レジストリ・設定 DSL は作らない。TypeScript アダプタは core に同梱し、2 言語目が現れるまで切り出さない。共用すべきなのは契約であって機構である。

## 5. v1 が測るもの

**coverage・CRAP・mutation の 3 つ。** 対象は:

| 項目 | 決定 |
| --- | --- |
| テストランナー | **vitest**（qm の `node --test` は保留） |
| プロジェクト構造 | **単一パッケージ**（ccaf の workspaces は保留） |
| パイロット | **hue → teps → duct** |
| dogfooding | gauntlet 自身にも適用する。不都合が出たら外してよい |

### TypeScript のバージョン

**2 つの別々のチェックとして扱う。**

1. **パースできるか** — `oxc-parser` が読めなければ、ファイル名と構文を名指しして落とす。
   バージョン番号は gauntlet が直接観測できるものの代理変数にすぎず、代理変数は陳腐化する。パース失敗そのものを見れば表のメンテが要らず、メッセージも行動可能になる。
2. **新しい TypeScript に載っているか** — チームの標準化ポリシー。パーサとは無関係。
   **下限の既定値は「gauntlet が検証済みの最新バージョン」**（パイロット 3 本を CI で回して確認しているもの）。ハードコードした数字ではなく、gauntlet が裏付けを持てる主張にする。

どちらも `init` の拒否条件にはしない。要求の強さを保ったまま「移行の進捗が gauntlet 自身で可視化される」形にするため。移行が終わるまで gauntlet が何も見えない状態を避ける。

## 6. 検討して外したもの

再検討の余地はあるが、v1 では意図的に持たない。理由込みで残す。

| 外したもの | 理由 |
| --- | --- |
| 人間が書く受け入れ条件 / Gherkin | §7-1 のリスクを承知の上で、閉ループを選択した |
| dependency structure・module size | Uncle Bob は使っているが、ノブを増やす価値が未検証 |
| supply chain / secret スキャン | gauntlet の主題（コードを読まない代替）と別軸 |
| property-based testing / flaky 検出 / 実行時検証 | v1 の 3 指標が機能してから判断する |
| 常駐デーモン / 非同期フィードバック | `turn` を数秒に収める手段として不要と判断した |
| Claude Code plugin marketplace 配布 | `init` が薄い以上、運用コストに見合わない |
| node:test 対応 / workspaces 対応 | パイロット 3 本に該当が無い |
| 対話式ウィザード | ユーザーは必ず Claude Code を使っているため skill で足りる |

## 7. 承知の上で残るリスク

1. **閉ループ。** エージェントが書き・テストし・レビューし、gauntlet が測る。
   「動くが求めていたものと違う」は素通りする。mutation はテストの*弱さ*を捕まえるが、テストが*間違ったことを正しくテストしている*ケースは捕まえない。Gherkin を持たない選択の代償であり、最大の穴。
2. **Grady Booch の批判は未対応。** メトリクスは脆弱性とデッドコードを見ない。
   エージェントのコードレビューがどれだけ代替するかは未検証。
3. **TypeScript の下限要求で qm・duct が詰まる可能性。** 赤として可視化はされる。
4. **CRAP ≤ 8 が TypeScript でどれだけ厳しいか未検証。** dogfooding が最初の実測になる。
5. **`turn` の coverage マージは近似。** 前回のフル計測が古いほど精度が落ちる。
6. **`oxc-parser` は 0.x。** TypeScript 公式 conformance の AST パースは 9779/9779 だが、AST の形は安定化作業中。上がるときに CC の値が動く可能性がある。

## 参考

- Robert C. Martin, X (2026-07): エージェントのコードを読まず、制約で囲む方針
- [unclebob/crap4java](https://github.com/unclebob/crap4java) — CRAP 閾値 8.0、`CC² × (1 − coverage)³ + CC`
- CRAP metric: Alberto Savoia & Bob Evans (2007)
- [Stryker vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/) — `coverageAnalysis` は常に `perTest`
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) — `Stop` は exit 2 で停止を阻止、`PreToolUse` は exit 2 でツールを実行前に阻止
