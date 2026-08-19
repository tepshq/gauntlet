/**
 * extreme mutation の変異スイッチング化。
 * 候補関数の body の先頭に 1 回だけガードを仕込む:
 *   - 当番（__XMUT__ が自分の id）なら return undefined（= 変異が有効）
 *   - トレース中なら「踏まれた」と名乗る（実行ベースの覆いテスト地図を作る）
 * 以降の変異切り替えは「当番票ファイル」の書き換えだけで、再変換が起きない。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.argv[2]!);
const candidates = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as any[];
const OUT = resolve(process.argv[4]!); // id マップ

const withId = candidates.map((t, i) => ({ ...t, id: `m${i}` }));
const byFile = new Map<string, any[]>();
for (const t of withId) {
  if (!byFile.has(t.file)) byFile.set(t.file, []);
  byFile.get(t.file)!.push(t);
}

for (const [file, targets] of byFile) {
  const path = resolve(ROOT, file);
  let src = readFileSync(path, "utf8");
  // 後ろから編集すればオフセットが崩れない
  for (const t of [...targets].sort((a, b) => b.bodyStart - a.bodyStart)) {
    const guard =
      `if ((globalThis as any).__XMUT__ === "${t.id}") return undefined; ` +
      `(globalThis as any).__XMUT_TRACE__ && (globalThis as any).__XMUT_TRACE__.add("${t.id}"); `;
    if (t.block) {
      // ブロック body: 開き括弧の直後に差し込む（行番号を動かさない）
      src = src.slice(0, t.bodyStart + 1) + " " + guard + src.slice(t.bodyStart + 1);
    } else {
      // 式 body のアロー: ブロック化して同じ形にする
      const expr = src.slice(t.bodyStart, t.bodyEnd);
      src = src.slice(0, t.bodyStart) + `{ ${guard}return (${expr}); }` + src.slice(t.bodyEnd);
    }
  }
  writeFileSync(path, src);
}
writeFileSync(OUT, JSON.stringify(withId, null, 2));
console.log(`仕込み完了: ${withId.length} 関数 / ${byFile.size} ファイル`);
