/**
 * 火消しブランチで「新しく覆われるようになった関数」を選ぶ。
 * main で網羅率 0（または存在しない）→ ブランチで > 0 のもの。
 * ここは効率の問題でしかなく、正否は変異の判定が出す。
 */
import { readFileSync, writeFileSync } from "node:fs";

const mainTargets = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as any[];
const branchTargets = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as any[];
const OUT = process.argv[4]!;

const key = (t: any) => `${t.file}|${(t.scope ?? []).join(".")}|${t.name ?? ""}`;
const mainCov = new Map<string, number>();
for (const t of mainTargets) {
  const k = key(t);
  mainCov.set(k, Math.max(mainCov.get(k) ?? 0, t.coverage));
}

const candidates = branchTargets.filter((t) => {
  if (t.coverage === 0 || t.empty) return false;
  const before = mainCov.get(key(t));
  return before === undefined || before === 0;
});
console.log(`ブランチの関数 ${branchTargets.length} / 新しく覆われた候補 ${candidates.length}`);
const byCc: Record<number, number> = {};
for (const c of candidates) byCc[c.cc] = (byCc[c.cc] ?? 0) + 1;
console.log("CC 分布:", JSON.stringify(byCc));
writeFileSync(OUT, JSON.stringify(candidates, null, 2));
