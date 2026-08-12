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

  it("tests.projects の宣言を通す", () => {
    expect(parse({ tests: { projects: ["node", "dom"] } })).toMatchObject({ tests: { projects: ["node", "dom"] } });
  });

  // 空の宣言は「テストを 1 つも走らせない」で、書き間違いとしか考えられない。
  it("tests.projects が空なら落とす", () => {
    expect(() => parse({ tests: { projects: [] } })).toThrow(ConfigError);
  });

  it("tests に知らないキーがあれば落とす", () => {
    expect(() => parse({ tests: { project: ["node"] } })).toThrow(ConfigError);
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

/**
 * メッセージの**書式**を見る。
 *
 * 上の `/defaultBranch/` のような部分一致は、ajv の文がキー名を含むので
 * gauntlet 側の整形が丸ごと空を返しても通ってしまう（実測: detailOf を `""` にしても
 * 緑のままだった）。gauntlet が足している分 — 行頭の字下げ、`/` のルート表記、
 * 行末の `: <名前>` — をそれぞれ名指しで見る。
 * ajv の文言そのものには寄りかからない（版が変わると書き換わるため）。
 */
function messageOf(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("落ちませんでした");
}

describe("parseConfig のメッセージ", () => {
  // エージェントは 1 回の実行で全部直したい。最初の 1 件で切ると往復が増える。
  it("違反が 2 つあれば 2 行に並べる", () => {
    const lines = messageOf(() => parse({ schemaVersion: 2, adapter: "python" })).split("\n").slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ {2}\/schemaVersion \S/);
    expect(lines[1]).toMatch(/^ {2}\/adapter .+: typescript$/);
  });

  // ルート直下の違反は instancePath が空。そのまま出すと行頭が空いて読めない。
  it("ルート直下の違反は / と書く", () => {
    expect(messageOf(() => parse({ crapThreshold: 30 }))).toMatch(/^ {2}\/ .+: crapThreshold$/m);
  });

  // ajv の文にもキー名は出るので、行末の `: <名前>` まで見ないと detailOf を検査できない。
  it("欠けているキーを行末で名指しする", () => {
    expect(messageOf(() => parse({ defaultBranch: undefined }))).toMatch(/^ {2}\/ .+: defaultBranch$/m);
  });

  // 名指しするものが無い違反に何かを足すと、読み手は無い詳細を探しにいく。
  //
  // ここだけ ajv の文言を丸ごと固定する。「何も足していない」は行全体を見ないと言えず、
  // 部分一致では detailOf が別の文字列を返しても通ってしまう（実測で 1 件取り逃した）。
  // ajv を上げてこの 1 行が落ちたら、新しい文言に置き換えれば済む。
  it("示すものが無ければ何も足さない", () => {
    const lines = messageOf(() => parse({ defaultBranch: "" })).split("\n").slice(1);
    expect(lines).toEqual(["  /defaultBranch must NOT have fewer than 1 characters"]);
  });

  // catch を素通しさせても、data が undefined のままスキーマ検証に落ちて
  // 「スキーマに一致しません」という**別の理由**で ConfigError になる。
  // 種類だけ見ていると緑になるので、理由の方を見る。
  it("JSON として読めない理由を出す", () => {
    expect(messageOf(() => parseConfig("{ not json", "test.json"))).toMatch(/^test\.json が JSON として読めません: \S/);
  });
});
