import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.ts";

const valid = {
  schemaVersion: 1,
  adapter: "typescript",
  runner: "vitest",
  defaultBranch: "main",
  source: { include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"] },
};

function parse(overrides: Record<string, unknown>): unknown {
  return parseConfig(JSON.stringify({ ...valid, ...overrides }), "test.json");
}

describe("parseConfig", () => {
  it("有効な config を通す", () => {
    expect(parse({})).toMatchObject({ adapter: "typescript", defaultBranch: "main" });
  });

  it("commands は省略できる", () => {
    expect(parse({})).not.toHaveProperty("commands");
  });

  // config はエージェントが書くので、検証は「落とす」側に倒す。
  // 黙って既定値で走ると、リポジトリごとに違うものを測って flaky になる。
  it.each([
    ["JSON として壊れている", "{ not json"],
    ["空", ""],
  ])("%s と落ちる", (_label, text) => {
    expect(() => parseConfig(text, "test.json")).toThrow(ConfigError);
  });

  it.each([
    ["schemaVersion が無い", { schemaVersion: undefined }],
    ["schemaVersion が違う", { schemaVersion: 2 }],
    ["adapter が未対応", { adapter: "python" }],
    ["runner が未対応", { runner: "jest" }],
    ["defaultBranch が空", { defaultBranch: "" }],
    ["source.include が空配列", { source: { include: [] } }],
    ["source が無い", { source: undefined }],
  ])("%s と落ちる", (_label, overrides) => {
    expect(() => parse(overrides)).toThrow(ConfigError);
  });

  // typo を黙って無視すると、書いたつもりの設定が効かないまま緑になる。
  it("知らないキーがあると落ちる", () => {
    expect(() => parse({ crapThreshold: 30 })).toThrow(ConfigError);
  });

  // config はエージェントが書くので、メッセージだけ読んで直せる必要がある。
  it.each([
    ["違反したパスを示す", { adapter: "python" }, /adapter/],
    ["許容値を示す", { adapter: "python" }, /typescript/],
    ["未知のキー名を示す", { crapThreshold: 30 }, /crapThreshold/],
    ["欠けているキー名を示す", { defaultBranch: undefined }, /defaultBranch/],
  ])("%s", (_label, overrides, pattern) => {
    expect(() => parse(overrides)).toThrow(pattern);
  });
});
