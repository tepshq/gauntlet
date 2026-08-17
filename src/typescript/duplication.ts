/**
 * 重複（コピペ）の測定。jscpd を叩いて、リポジトリ全体の重複トークン数を 1 つ返す。
 *
 * **jscpd は gauntlet が同梱してバージョンを固定する。** 対象リポジトリごとに版が
 * ずれると、同じコードで数字が変わる（flaky）。eslint と違って対象側の
 * 何にも合わせる必要が無いので、同梱できる。
 *
 * **単位はトークン。** 行だと整形（改行位置の変更）だけで数字が動く。
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { capture } from "../exec.ts";
import { toPosix } from "./adapter.ts";
import { RunnerError, lastLines } from "./runner.ts";

/** 全社で 1 つ。リポジトリごとに変えると「重複」の意味が repo ごとに違ってしまう。 */
export const MIN_TOKENS = 50;

/** クローン 1 か所。どちらが「先」かに意味は無く、対として読む。 */
export interface DuplicateClone {
  files: readonly [string, string];
  tokens: number;
}

export interface DuplicationResult {
  /** 重複しているトークンの総数。ratchet が持つ数。 */
  duplicatedTokens: number;
  /** 解析したファイル数。scope の報告用。 */
  sources: number;
  /** どこが重複しているか。`runDuplication` が返す時点で root からの相対パス。 */
  clones: DuplicateClone[];
}

/**
 * 対象は解決済みのファイル一覧を位置引数で渡す。glob を渡すと jscpd の glob 実装と
 * `listSourceFiles` の解決がずれうる — CRAP が測るのと同一の集合であることを保証する。
 *
 * **`--absolute` はファイル名のために要る。** 位置引数で渡すと jscpd 5.0.14 は
 * `duplicates[].firstFile.name` を空文字で返し、総数しか分からない（#41: 4 ファイルに
 * 複製された並行処理ヘルパー 338 トークンが、聞かれるまで誰にも見えなかった）。
 * ディレクトリ + `--ignore` に変えても名前は出るが、それだと対象集合の解決が jscpd の
 * glob 側に移る — 上で避けている当のものを踏む。数（`statistics.total`）は
 * このフラグでは動かない（#41 で 26 ファイルの実測、gauntlet でも合成クローンで追試）。
 */
export function jscpdArgs(files: readonly string[], outDir: string): string[] {
  return [
    ...files,
    "--min-tokens",
    String(MIN_TOKENS),
    "--reporters",
    "json",
    "--output",
    outDir,
    "--silent",
    "--absolute",
  ];
}

/** 空文字（`--absolute` が効いていない形）は名前として認めない。 */
function cloneName(file: unknown): string | null {
  const name = (file as { name?: unknown } | null)?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

/**
 * クローン一覧。**空欄を並べるくらいなら落とす。**
 *
 * 名前が空で出るのは `--absolute` が効いていないときで、それは同梱 jscpd を上げた回に
 * しか起こらない（対象リポジトリの都合では動かない）。数は別経路（`statistics.total`）
 * なのでゲートの判定は無傷だが、`(空) ↔ (空)` を並べる `list` は #41 が報告した
 * 「総数は出るが辿り着けない」状態そのもので、出す意味が無い。
 */
function parseClones(duplicates: unknown, detail: string): DuplicateClone[] {
  if (!Array.isArray(duplicates)) {
    throw new RunnerError(`jscpd のレポートに duplicates がありません:\n${lastLines(detail, 15)}`);
  }
  return duplicates.map((raw: { firstFile?: unknown; secondFile?: unknown; tokens?: unknown }) => {
    const first = cloneName(raw.firstFile);
    const second = cloneName(raw.secondFile);
    if (first === null || second === null || typeof raw.tokens !== "number") {
      throw new RunnerError(`jscpd のクローンにファイル名がありません（--absolute が効いていない）:\n${lastLines(detail, 15)}`);
    }
    return { files: [first, second], tokens: raw.tokens };
  });
}

/**
 * レポートの形が想定とずれたとき、黙って 0 と読まない。
 *
 * パスは jscpd が返したまま（`--absolute` なので絶対）。相対化は `runDuplication`。
 */
export function parseDuplication(text: string, detail: string): DuplicationResult {
  let report: { statistics: { total: { duplicatedTokens?: unknown; sources?: unknown } }; duplicates?: unknown };
  let total: { duplicatedTokens?: unknown; sources?: unknown };
  try {
    report = JSON.parse(text) as typeof report;
    total = report.statistics.total;
  } catch {
    throw new RunnerError(`jscpd のレポートを読めません:\n${lastLines(detail, 15)}`);
  }
  const { duplicatedTokens, sources } = total;
  if (typeof duplicatedTokens !== "number" || typeof sources !== "number") {
    throw new RunnerError(`jscpd のレポートに statistics.total がありません:\n${lastLines(detail, 15)}`);
  }
  return { duplicatedTokens, sources, clones: parseClones(report.duplicates, detail) };
}

/**
 * jscpd が返す絶対パスを root からの相対に戻す。**基準は realpath。**
 *
 * `--absolute` の名前は realpath 解決済みで返る。root 自体が symlink の下にあると
 * （macOS の `mkdtemp` は `/var/…` を返し、jscpd は `/private/var/…` を返す）
 * `relative(root, name)` が `../../../…` に化ける。baseline の一覧と
 * 同じ表記に揃わないと、一覧から開けない。
 */
export function relativizeClones(base: string, clones: readonly DuplicateClone[]): DuplicateClone[] {
  return clones.map(({ files, tokens }) => ({
    files: [toPosix(relative(base, files[0])), toPosix(relative(base, files[1]))],
    tokens,
  }));
}

/**
 * 同梱した jscpd の実体。`exports` が bin への subpath 解決を塞ぐので package.json から辿り、
 * bin の場所も決め打ちしない — 5.x はプラットフォーム別実装へのラッパー（`run-jscpd.js`）で、
 * 置き場所はパッケージの都合で変わる。宣言（`bin.jscpd`）だけを信じる。
 */
function jscpdBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("jscpd/package.json");
  const declared = (require(pkgPath) as { bin: { jscpd: string } }).bin.jscpd;
  return join(dirname(pkgPath), declared);
}

/** 対象が 1 つ以上あることは呼び出し側が保証する。 */
export function runDuplication(root: string, files: readonly string[]): DuplicationResult {
  // 接頭辞は残骸を人が見分けるためのもの。
  const outDir = mkdtempSync(join(tmpdir(), "gauntlet-jscpd-"));
  try {
    const { combined } = capture("node", [jscpdBin(), ...jscpdArgs(files, outDir)], root);
    let text: string;
    try {
      // ファイル名は別の行に置く。同じ行に並べると、下の disable が
      // （行単位なので）**ファイル名の変異まで一緒に外してしまう**。
      const reportPath = join(outDir, "jscpd-report.json");
      text = readFileSync(reportPath, "utf8");
    } catch {
      throw new RunnerError(`jscpd がレポートを出しませんでした:\n${lastLines(combined, 15)}`);
    }
    const result = parseDuplication(text, combined);
    return { ...result, clones: relativizeClones(realpathSync(root), result.clones) };
  } finally {
    // `force` は付けない。消す相手は直前に自分で作ったディレクトリなので存在は確実で、
    // 無い場合を握り潰す意味が無い（`recursive` の方は、消し損ねを見つける網として要る）。
    rmSync(outDir, { recursive: true });
  }
}
