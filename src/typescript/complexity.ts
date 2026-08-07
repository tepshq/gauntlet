/**
 * 関数単位の循環的複雑度。
 *
 * CC = 判定点の数 + 1。判定点は「実行経路が分岐する場所」。
 * 入れ子の関数は自分の CC を持ち、外側には算入しない。
 */

import { parseSync } from "oxc-parser";
import type { FunctionLocation } from "../report.ts";
import { type Node, childrenOf, columnAt, lineAt, lineStarts } from "./ast.ts";

/** 本体を持つ関数。`TSDeclareFunction` は本体が無いので対象外。 */
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * 判定点。`&&` `||` `??` は短絡するので経路が分かれる。
 * `else` と `default:` は分岐を増やさないので入らない。
 */
const DECISION_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "ConditionalExpression",
  "CatchClause",
  "LogicalExpression",
]);

function isDecision(node: Node): boolean {
  // `default:` は test を持たず、経路を増やさない。
  if (node.type === "SwitchCase") return node["test"] != null;
  return DECISION_TYPES.has(node.type);
}

function identifierName(value: unknown): string | null {
  const node = value as Node | undefined;
  if (node?.type === "Identifier") return String(node["name"]);
  return null;
}

/** `{ key: fn }` や `class { key(){} }` の key。計算プロパティは名前として扱わない。 */
function propertyKeyName(parent: Node): string | null {
  if (parent["computed"] === true) return null;
  const key = parent["key"] as Node | undefined;
  if (key?.type === "Identifier") return String(key["name"]);
  if (key?.type === "Literal") return String(key["value"]);
  return null;
}

const NAME_FROM_PARENT: Record<string, (parent: Node) => string | null> = {
  VariableDeclarator: (parent) => identifierName(parent["id"]),
  AssignmentExpression: (parent) => identifierName(parent["left"]),
  MethodDefinition: propertyKeyName,
  PropertyDefinition: propertyKeyName,
  Property: propertyKeyName,
  ExportDefaultDeclaration: () => "default",
};

/** 関数自身の名前。取れなければ親から推測し、それでも無ければ null。 */
function nameOf(node: Node, parent: Node | null): string | null {
  const own = identifierName(node["id"]);
  if (own !== null) return own;
  if (parent === null) return null;
  return NAME_FROM_PARENT[parent.type]?.(parent) ?? null;
}

/** スコープに積む名前。クラスと名前付き関数だけが積まれる。 */
function scopeNameOf(node: Node, parent: Node | null): string | null {
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    return identifierName(node["id"]);
  }
  if (FUNCTION_TYPES.has(node.type)) return nameOf(node, parent);
  return null;
}

export interface ExtractedFunction {
  location: FunctionLocation;
  cc: number;
}

interface WalkState {
  file: string;
  starts: readonly number[];
  found: ExtractedFunction[];
}

function toLocation(state: WalkState, node: Node, name: string | null, scope: readonly string[]): FunctionLocation {
  return {
    file: state.file,
    name,
    scope: [...scope],
    startLine: lineAt(state.starts, node.start),
    startColumn: columnAt(state.starts, node.start),
    endLine: lineAt(state.starts, node.end),
    endColumn: columnAt(state.starts, node.end),
  };
}

function walk(state: WalkState, node: Node, parent: Node | null, scope: string[], current: ExtractedFunction | null): void {
  const isFunction = FUNCTION_TYPES.has(node.type);
  let owner = current;

  if (isFunction) {
    owner = { location: toLocation(state, node, nameOf(node, parent), scope), cc: 1 };
    state.found.push(owner);
  } else if (owner !== null && isDecision(node)) {
    // 判定点は、それを直接囲む関数のものになる。
    owner.cc++;
  }

  const pushed = scopeNameOf(node, parent);
  if (pushed !== null) scope.push(pushed);
  for (const child of childrenOf(node)) walk(state, child, node, scope, owner);
  if (pushed !== null) scope.pop();
}

/** パースできなかったときに投げる。gauntlet が読めないコードは緑にしない。 */
export class ParseError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} をパースできません: ${detail}`);
    this.name = "ParseError";
  }
}

export function extractFunctions(file: string, source: string): ExtractedFunction[] {
  const parsed = parseSync(file, source);
  const failure = parsed.errors[0];
  if (failure !== undefined) throw new ParseError(file, failure.message);

  const state: WalkState = { file, starts: lineStarts(source), found: [] };
  walk(state, parsed.program as unknown as Node, null, [], null);
  return state.found;
}
