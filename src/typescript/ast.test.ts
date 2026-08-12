import { describe, expect, it } from "vitest";
import { type Node, childrenOf, columnAt, isNode, lineAt, lineStarts } from "./ast.ts";

const node = (type: string, extra: Record<string, unknown> = {}): Node => ({ type, start: 0, end: 1, ...extra });

// oxc は `loc` を持たないので、gauntlet が出す行番号・列番号は全部ここを通る。
// ここがずれると、違反の指す場所が黙って 1 つずれる（直しにいく先が変わる）。
describe("isNode", () => {
  it("type を持つオブジェクトを Node と見なす", () => {
    expect(isNode(node("Identifier"))).toBe(true);
  });

  // type を見ずに「オブジェクトなら Node」にすると、AST の中の
  // ただのデータ（位置情報の入れ物など）まで子として歩くことになる。
  it.each([
    ["type が無い", { start: 0, end: 1 }],
    ["type が文字列でない", { type: 42, start: 0, end: 1 }],
    ["null", null],
    ["配列", []],
    ["文字列", "Identifier"],
    ["数値", 3],
    ["undefined", undefined],
  ])("%s は Node ではない", (_label, value) => {
    expect(isNode(value)).toBe(false);
  });
});

describe("childrenOf", () => {
  it("直下のオブジェクトを拾う", () => {
    const child = node("Identifier");
    expect(childrenOf(node("Declaration", { id: child }))).toEqual([child]);
  });

  it("配列の中の Node を拾う", () => {
    const a = node("A");
    const b = node("B");
    expect(childrenOf(node("Program", { body: [a, b] }))).toEqual([a, b]);
  });

  // 配列には Node でないものも入る（`directives` の文字列など）。
  // 素通しすると、type を持たないものを親として walk が続く。
  it("配列の中の Node でないものは拾わない", () => {
    const a = node("A");
    expect(childrenOf(node("Program", { body: [a, "raw", 42, null] }))).toEqual([a]);
  });

  it("Node でない値は拾わない", () => {
    expect(childrenOf(node("Literal", { value: "x", raw: 1, parent: null }))).toEqual([]);
  });
});

describe("lineStarts", () => {
  it("先頭は必ず 0 から始まる", () => {
    expect(lineStarts("")).toEqual([0]);
  });

  it("改行の次のオフセットを積む", () => {
    expect(lineStarts("a\nbb\nccc")).toEqual([0, 2, 5]);
  });

  // 空行を飛ばすと、以降の行番号が全部ずれる。
  it("連続する改行も 1 行ずつ数える", () => {
    expect(lineStarts("x\n\ny")).toEqual([0, 2, 3]);
  });

  it("末尾の改行の後ろも 1 行として積む", () => {
    expect(lineStarts("a\n")).toEqual([0, 2]);
  });
});

describe("lineAt / columnAt", () => {
  // 行の先頭・行の末尾・改行そのもの・ソースの末端を、境界ごとに固定する。
  it.each([
    [0, 1, 0],
    [1, 1, 1],
    [2, 2, 0],
    [4, 2, 2],
    [5, 3, 0],
    [8, 3, 3],
  ])("offset %i は %i 行 %i 列", (offset, line, column) => {
    const starts = lineStarts("a\nbb\nccc");
    expect(lineAt(starts, offset)).toBe(line);
    expect(columnAt(starts, offset)).toBe(column);
  });

  it("空のソースは 1 行 0 列", () => {
    const starts = lineStarts("");
    expect(lineAt(starts, 0)).toBe(1);
    expect(columnAt(starts, 0)).toBe(0);
  });

  it("改行だけのソースの末端は 2 行 0 列", () => {
    const starts = lineStarts("\n");
    expect(lineAt(starts, 1)).toBe(2);
    expect(columnAt(starts, 1)).toBe(0);
  });

  // オフセットは UTF-16 の単位。バイト数で数えると日本語のある行がずれる。
  it("日本語があってもオフセットは UTF-16 の単位で数える", () => {
    const starts = lineStarts("日本語\n二行目");
    expect(starts).toEqual([0, 4]);
    expect(lineAt(starts, 3)).toBe(1);
    expect(columnAt(starts, 3)).toBe(3);
    expect(lineAt(starts, 4)).toBe(2);
    expect(columnAt(starts, 4)).toBe(0);
  });
});
