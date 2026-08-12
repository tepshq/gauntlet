/**
 * `gauntlet.config.json` の読み込みと検証。
 *
 * config の中身はエージェントがリポジトリを読んで決めるので、
 * 起動時に必ずスキーマ検証する。不正なら走らせずに落とす。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type AnySchema, type ErrorObject } from "ajv";

export const CONFIG_FILENAME = "gauntlet.config.json";

export interface GauntletConfig {
  schemaVersion: 1;
  adapter: "typescript";
  runner: "vitest";
  defaultBranch: string;
  source: { include: string[]; exclude?: string[] };
  /** gauntlet が走らせる vitest project の宣言。無ければ全部走らせる。 */
  tests?: { projects: string[] };
  commands?: { typecheck?: string };
}

/** config が使えないときに投げる。メッセージだけ読めば直せる形にする。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "gauntlet.config.schema.json");

function loadValidator(): (data: unknown) => ErrorObject[] | null {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema;
  const ajv = new Ajv({
    // 1 件目で切ると、エージェントが config を直す往復がその分だけ増える。
    allErrors: true,
    // Stryker disable next-line BooleanLiteral: 現行スキーマは strict でも同じ結果を返す
    // （実測で確認）。将来 strict が弾く構文が入ったときに、ajv の例外ではなく
    // ConfigError で落とし続けるための保険なので、今は結果に差が出ない。
    strict: false,
  });
  const validate = ajv.compile(schema);
  return (data) => (validate(data) ? null : (validate.errors ?? []));
}

/** ajv の params には違反したキーや許容値が入る。config はエージェントが書くので必ず出す。 */
function detailOf(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const additional = params["additionalProperty"];
  if (typeof additional === "string") return `: ${additional}`;
  const allowed = params["allowedValues"];
  if (Array.isArray(allowed)) return `: ${allowed.join(" | ")}`;
  const missing = params["missingProperty"];
  if (typeof missing === "string") return `: ${missing}`;
  return "";
}

function formatErrors(errors: readonly ErrorObject[]): string {
  return errors
    .map((error) => `  ${error.instancePath || "/"} ${error.message ?? "invalid"}${detailOf(error)}`)
    .join("\n");
}

/** JSON として読む。パースできない時点で config は使えない。 */
export function parseConfig(text: string, source: string): GauntletConfig {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`${source} が JSON として読めません: ${(cause as Error).message}`);
  }

  const errors = loadValidator()(data);
  if (errors) {
    throw new ConfigError(`${source} がスキーマに一致しません:\n${formatErrors(errors)}`);
  }
  return data as GauntletConfig;
}

export function loadConfig(root: string): GauntletConfig {
  const path = join(root, CONFIG_FILENAME);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`${path} がありません。\`gauntlet init\` を実行してください。`);
  }
  return parseConfig(text, path);
}
