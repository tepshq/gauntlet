/** 任意のリポジトリで extreme mutation の変異対象を列挙する。root を引数で取る。 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { childrenOf, columnAt, lineAt, lineStarts, type Node } from "../../src/typescript/ast.ts";
import { analyze, listSourceFiles } from "../../src/typescript/adapter.ts";
import type { IstanbulCoverage } from "../../src/typescript/coverage.ts";

const ROOT = resolve(process.argv[2]!);
const OUT = process.argv[3]!;
// db project は実 Postgres を要求するので外す。
const PROJECTS = (process.argv[4] ?? "node,dom").split(",");
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const config = JSON.parse(readFileSync(join(ROOT, "gauntlet.config.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "xmut-"));
const args = [
  "vitest", "run", "--coverage", "--coverage.provider=v8", "--coverage.reporter=json",
  ...config.source.include.map((g: string) => `--coverage.include=${g}`),
  ...PROJECTS.map((p) => `--project=${p}`),
  `--coverage.reportsDirectory=${join(dir, "coverage")}`, "--silent", "--reporter=dot", "--passWithNoTests",
];
console.log(`coverage を取ります: npx ${args.join(" ")}`);
execFileSync("npx", args, { cwd: ROOT, stdio: "inherit", timeout: 30 * 60_000 });
const coverage = JSON.parse(readFileSync(join(dir, "coverage", "coverage-final.json"), "utf8")) as IstanbulCoverage;

const report = analyze(ROOT, config, coverage);
const files = listSourceFiles(ROOT, config.source);
console.log(`analyze: 測る対象 ${report.functions.length} 関数 / ${files.length} ファイル`);

interface Span { file: string; bodyStart: number; bodyEnd: number; block: boolean; empty: boolean }
const spans = new Map<string, Span>();
for (const file of files) {
  const source = readFileSync(resolve(ROOT, file), "utf8");
  const starts = lineStarts(source);
  const walk = (node: Node): void => {
    if (FUNCTION_TYPES.has(node.type)) {
      const body = node["body"] as Node;
      const text = source.slice(body.start, body.end);
      spans.set(`${file}:${lineAt(starts, node.start)}:${columnAt(starts, node.start)}`, {
        file, bodyStart: body.start, bodyEnd: body.end,
        block: body.type === "BlockStatement",
        // 誤検知系統 1: body が既に空。stub と意味が同じなので必ず生き残る。
        empty: /^\{\s*\}$/.test(text),
      });
    }
    for (const child of childrenOf(node)) walk(child);
  };
  try {
    walk(parseSync(file, source).program as unknown as Node);
  } catch {
    console.log(`  パース不能で飛ばす: ${file}`);
  }
}

const targets = report.functions.flatMap((fn) => {
  const span = spans.get(`${fn.location.file}:${fn.location.startLine}:${fn.location.startColumn}`);
  return span === undefined ? [] : [{ ...span, cc: fn.cc, coverage: fn.coverage, name: fn.location.name, scope: fn.location.scope, startLine: fn.location.startLine }];
});
const covered = targets.filter((t) => t.coverage > 0 && !t.empty);
console.log(`span 付き ${targets.length} / 網羅率 > 0 が ${targets.filter((t) => t.coverage > 0).length} / うち空 body を除いた変異候補 ${covered.length}`);
writeFileSync(OUT, JSON.stringify(targets, null, 2));
