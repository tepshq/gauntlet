/**
 * TypeScript アダプタ。
 *
 * 責務は「ソースと coverage から、関数単位の cc と網羅率を出す」ことだけ。
 * git の差分も閾値も CRAP の式も core 側にある。
 */

import { globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { GauntletConfig } from "../config.ts";
import { REPORT_SCHEMA_VERSION, type AdapterReport, type ExcludedFile, type FunctionReport } from "../report.ts";
import { extractFunctions } from "./complexity.ts";
import { type IstanbulCoverage, coverageByFunction } from "./coverage.ts";

export const ADAPTER_NAME = "typescript";

/** 区切りを常に `/` に揃える。Windows と macOS で違うキーになると照合が壊れる。 */
function toPosix(path: string): string {
  return path.split("\\").join("/");
}

export function listSourceFiles(root: string, source: GauntletConfig["source"]): string[] {
  const found = globSync(source.include, {
    cwd: root,
    ...(source.exclude === undefined ? {} : { exclude: source.exclude }),
  });
  return found.map(toPosix).sort();
}

/** coverage-final.json は絶対パスをキーに持つので、リポジトリ相対に直して引けるようにする。 */
function indexCoverageByRelativePath(root: string, coverage: IstanbulCoverage): Map<string, IstanbulCoverage[string]> {
  const index = new Map<string, IstanbulCoverage[string]>();
  for (const [absolute, entry] of Object.entries(coverage)) {
    index.set(toPosix(relative(root, absolute)), entry);
  }
  return index;
}

export function analyze(root: string, config: GauntletConfig, coverage: IstanbulCoverage): AdapterReport {
  const index = indexCoverageByRelativePath(root, coverage);
  const functions: FunctionReport[] = [];
  const excluded: ExcludedFile[] = [];

  for (const file of listSourceFiles(root, config.source)) {
    const source = readFileSync(resolve(root, file), "utf8");
    const extracted = extractFunctions(file, source);
    if (extracted.length === 0) {
      excluded.push({ file, reason: "関数がありません" });
      continue;
    }
    const rates = coverageByFunction(extracted, index.get(file));
    for (const fn of extracted) {
      functions.push({ location: fn.location, cc: fn.cc, coverage: rates.get(fn)! });
    }
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    adapter: { name: ADAPTER_NAME, version: "0.0.0" },
    root,
    functions,
    excluded,
  };
}
