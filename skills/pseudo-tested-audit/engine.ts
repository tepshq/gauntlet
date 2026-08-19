/**
 * 変異スイッチング版エンジン（監査用）。
 * 使い方: npx tsx engine.ts <対象root> <ids.json> <結果out.json> [reuse] [added-tests.txt]
 *   reuse           … .xmut-switch/trace が残っていれば地図作りを省く（ソース不変のときだけ）
 *   added-tests.txt … 渡すと killed を killed-by-new / killed-by-old に分類（ブランチ検証用）
 * 前提: instrument.ts で仕込み済み・xmut-setup.ts 配線済み。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.argv[2]!);
const ids = JSON.parse(readFileSync(resolve(process.argv[3]!), "utf8")) as any[];
const OUT = resolve(process.argv[4]!);
const REUSE_MAP = process.argv[5] === "reuse";
const addedTests = process.argv[6] ? new Set(readFileSync(resolve(process.argv[6]!), "utf8").split("\n").filter(Boolean)) : null;
const SW = join(ROOT, ".xmut-switch");
const ACTIVE = join(SW, "active-id");
const TRACE = join(SW, "trace");

// cwd 依存のテストがある（例: duct の yahoo-categories-csv.test.ts が process.cwd() 基準で
// fixture を読む）ので、CLI 実行と同じ条件に揃える。
process.chdir(ROOT);
const { createVitest } = await import(pathToFileURL(join(ROOT, "node_modules/vitest/dist/node.js")).href);
let t0 = Date.now();
const lap = (m: string) => { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`); t0 = Date.now(); };

const vitest = await createVitest("test", { root: ROOT, project: process.env.XMUT_PROJECTS?.split(",") ?? ["node", "dom"], watch: false, coverage: { enabled: false } } as any);
await (vitest as any).init(); // 省くと reporter が onInit を受け取れず、失敗の要約で落ちる（実測）
await (vitest as any).collect();
lap("暖機（変換と地図の器）");

const isTest = (f: string) => /\.(test|spec)\.tsx?$/.test(f) && !/\.db\.test\.tsx?$/.test(f);
function testsImporting(abs: string): string[] {
  const tests = new Set<string>();
  for (const project of (vitest as any).projects) {
    const mg = project.vite?.moduleGraph;
    if (!mg) continue;
    const seeds = mg.getModulesByFile(abs);
    if (!seeds) continue;
    const stack = [...seeds]; const seen = new Set(stack);
    while (stack.length) {
      const m: any = stack.pop();
      if (m.file && isTest(m.file)) { tests.add(m.file); continue; }
      for (const imp of m.importers) if (!seen.has(imp)) { seen.add(imp); stack.push(imp); }
    }
  }
  return [...tests];
}
function moduleOk(m: any): boolean {
  if (typeof m.ok === "function") return m.ok();
  if (typeof m.state === "function") return m.state() === "passed";
  return true;
}

// --- 1. 地図作り（当番なし・健康診断を兼ねる） ---
writeFileSync(ACTIVE, "");
const hasMap = (() => { try { return readdirSync(TRACE).length > 0; } catch { return false; } })();
if (REUSE_MAP && hasMap) {
  lap("地図を再利用（作り直しと健康診断を省略）");
} else {
  const dryFiles = [...new Set(ids.flatMap((t) => testsImporting(resolve(ROOT, t.file))))];
  const drySpecs = dryFiles.flatMap((f) => (vitest as any).getModuleSpecifications(f));
  const dryIds = new Set(drySpecs.map((s: any) => s.moduleId));
  const dry = await (vitest as any).runTestSpecifications(drySpecs, false);
  const sick = dry.testModules.filter((m: any) => dryIds.has(m.moduleId) && !moduleOk(m)).map((m: any) => m.moduleId);
  if (sick.length > 0) { console.log("健康診断で赤（このテストは変異と無関係に落ちる。直すか除外してから）:", sick); process.exit(1); }
  lap(`地図作り（${dryFiles.length} テストファイルを 1 回実行、全緑）`);
}

const covering = new Map<string, Set<string>>();
for (const f of readdirSync(TRACE)) {
  const { testPath, ids: hit } = JSON.parse(readFileSync(join(TRACE, f), "utf8"));
  for (const id of hit) {
    if (!covering.has(id)) covering.set(id, new Set());
    covering.get(id)!.add(testPath);
  }
}
lap(`地図: ${covering.size}/${ids.length} 関数に踏むテストが見つかった`);

// --- 2. 変異ループ ---
const results: any[] = [];
const tally: Record<string, number> = {};
const started = Date.now();
for (const [i, t] of ids.entries()) {
  const runStart = Date.now();
  const files = [...(covering.get(t.id) ?? [])];
  let verdict = "no-executing-tests";
  let killers: string[] = [];
  if (files.length > 0) {
    writeFileSync(ACTIVE, t.id);
    const specs = files.flatMap((f) => (vitest as any).getModuleSpecifications(f));
    const specIds = new Set(specs.map((s: any) => s.moduleId));
    const result = await (vitest as any).runTestSpecifications(specs, false);
    // 結果は今回渡した spec の分だけ読む。vitest の返す testModules は過去の実行の
    // 成績も含むので、素通しで読むと前の変異の失敗が居座る（実測で踏んだ）。
    killers = result.testModules.filter((m: any) => specIds.has(m.moduleId) && !moduleOk(m)).map((m: any) => String(m.moduleId).replace(`${ROOT}/`, ""));
    verdict = killers.length === 0 ? "survived"
      : addedTests === null ? "killed"
      : killers.some((f) => addedTests.has(f)) ? "killed-by-new" : "killed-by-old";
  }
  tally[verdict] = (tally[verdict] ?? 0) + 1;
  results.push({ ...t, verdict, killers, ms: Date.now() - runStart, coveringFiles: files.length });
  const scope = t.scope?.length ? `${t.scope.join(".")} 内の ` : "";
  console.log(`${String(i + 1).padStart(4)}/${ids.length} ${String(Date.now() - runStart).padStart(6)}ms ${verdict.padEnd(13)} cc=${t.cc} cov=${(t.coverage * 100).toFixed(0)}%  ${t.file}:${t.startLine} ${scope}${t.name ?? "<無名>"}`);
}
writeFileSync(ACTIVE, "");
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\n集計: ${JSON.stringify(tally)} / 変異ループ ${((Date.now() - started) / 1000).toFixed(1)}s`);
await vitest.close();
process.exit(0);
