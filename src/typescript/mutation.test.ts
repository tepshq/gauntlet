import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_PATH, type MutationReport, disableComments, reviewDisables, fileModes, lockHolder, lockPath, findRepoVitestConfig, ignoredBreakdown, measuredByFile, noCoverageFrom, restoreModes, strykerConfig, strykerFiles, strykerVitestWrapper, NO_TESTS_TO_MUTATE, dryRunFailure, requireMutationTools, survivedFrom, timeoutByFile, unplaceableMutators, vitestRunnerPlugin } from "./mutation.ts";
import { RunnerError, lastLines } from "./runner.ts";

// レポートが出ていないときは Stryker の出力が唯一の手がかりになる。
// 全部出すと埋もれるので末尾だけ。
describe("lastLines", () => {
  it("末尾から指定した行数だけ返す", () => {
    expect(lastLines("a\nb\nc\nd", 2)).toBe("c\nd");
  });

  it("行数が足りなければ全部返す", () => {
    expect(lastLines("a\nb", 5)).toBe("a\nb");
  });

  it("空なら空", () => {
    expect(lastLines("", 3)).toBe("");
  });

  // 前後の空白を落とさないと、報告の頭に空行が並ぶ。
  it("前後の空白を落とす", () => {
    expect(lastLines("\n  a  \n\n", 5)).toBe("a");
  });
});

// Stryker の json reporter は CLI から出力先を変えられないので、既定値に結合している。
// Stryker 側が変えたらここが最初に壊れる。
describe("REPORT_PATH", () => {
  it("Stryker の既定の出力先を指す", () => {
    expect(REPORT_PATH).toBe("reports/mutation/mutation.json");
  });
});

function report(entries: Record<string, [status: string, line: number][]>): MutationReport {
  return {
    files: Object.fromEntries(
      Object.entries(entries).map(([file, mutants]) => [
        file,
        {
          mutants: mutants.map(([status, line]) => ({
            mutatorName: "ConditionalExpression",
            status,
            location: { start: { line } },
          })),
        },
      ]),
    ),
  };
}

/**
 * 記録の母数と打ち切り。**ratchet の余裕（#24）の入力そのもの。**
 *
 * `measured` を多く数えると `fileRegression` の slack が広がり、生き残りが増えても
 * 通る（ゲートが黙って緩む）。`timeout` を別に数えるのは、Survived との境目が
 * 実行速度で動くため — 和なら揺れない。
 */
describe("measuredByFile", () => {
  it("Ignored と NoCoverage は母数に入れない", () => {
    const entries = report({
      "a.ts": [["Killed", 1], ["Survived", 2], ["Timeout", 3], ["Ignored", 4], ["NoCoverage", 5]],
    });
    expect(measuredByFile(entries)).toEqual({ "a.ts": 3 });
  });

  it("ファイルごとに数える", () => {
    const entries = report({ "a.ts": [["Killed", 1]], "b.ts": [["Survived", 1], ["Killed", 2]] });
    expect(measuredByFile(entries)).toEqual({ "a.ts": 1, "b.ts": 2 });
  });

  // 「全部外れて母数 0」と「報告に無い」は別物。0/0/0 の記録を作らせないために区別する。
  it("測ったものが 1 つも無ければ 0", () => {
    expect(measuredByFile(report({ "a.ts": [["Ignored", 1]] }))).toEqual({ "a.ts": 0 });
  });
});

describe("timeoutByFile", () => {
  it("打ち切りだけを数える", () => {
    const entries = report({ "a.ts": [["Timeout", 1], ["Timeout", 2], ["Killed", 3], ["Survived", 4]] });
    expect(timeoutByFile(entries)).toEqual({ "a.ts": 2 });
  });

  it("打ち切りが無ければ 0", () => {
    expect(timeoutByFile(report({ "a.ts": [["Killed", 1]] }))).toEqual({ "a.ts": 0 });
  });
});

describe("survivedFrom", () => {
  it("生き残った変異を場所つきで返す", () => {
    expect(survivedFrom(report({ "a.ts": [["Survived", 12]] }))).toEqual([
      { file: "a.ts", line: 12, mutator: "ConditionalExpression", replacement: null },
    ]);
  });

  // 位置と種類だけだと、正体を知るには Stryker の再実行（分単位）しかない。
  it("変異後のコードを残す", () => {
    const withReplacement: MutationReport = {
      files: {
        "a.ts": {
          mutants: [
            { mutatorName: "EqualityOperator", replacement: "<=", status: "Survived", location: { start: { line: 3 } } },
          ],
        },
      },
    };
    expect(survivedFrom(withReplacement)).toEqual([
      { file: "a.ts", line: 3, mutator: "EqualityOperator", replacement: "<=" },
    ]);
  });

  it("倒された変異は返さない", () => {
    expect(survivedFrom(report({ "a.ts": [["Killed", 1], ["Timeout", 2]] }))).toEqual([]);
  });

  // 直し方が違う（assert を強めるのか、呼べる形にするのか）。別の欄で記録する（#31）。
  it("NoCoverage は生き残りに数えない", () => {
    expect(survivedFrom(report({ "a.ts": [["NoCoverage", 1]] }))).toEqual([]);
  });

  it("複数ファイルをまとめる", () => {
    const survived = survivedFrom(report({ "a.ts": [["Survived", 1]], "b.ts": [["Survived", 2]] }));
    expect(survived.map((mutant) => mutant.file)).toEqual(["a.ts", "b.ts"]);
  });

  it("変異が無ければ空", () => {
    expect(survivedFrom(report({}))).toEqual([]);
  });
});

// #31: mutation は NoCoverage を違反に数えず、CRAP は複雑度 × 未網羅の積なので、
// 複雑度の低い未テストコードはどちらのゲートにも掛からない。件数を別軸で記録する。
describe("noCoverageFrom", () => {
  it("どのテストも通っていない変異を場所つきで返す", () => {
    expect(noCoverageFrom(report({ "a.ts": [["NoCoverage", 138]] }))).toEqual([
      { file: "a.ts", line: 138, mutator: "ConditionalExpression", replacement: null },
    ]);
  });

  // 生き残り・倒された・打ち切りは「テストが通っている」側。混ぜると二重に数える。
  it("それ以外の status は返さない", () => {
    const mixed = report({ "a.ts": [["Survived", 1], ["Killed", 2], ["Timeout", 3], ["Ignored", 4]] });
    expect(noCoverageFrom(mixed)).toEqual([]);
  });

  it("複数ファイルをまとめる", () => {
    const uncovered = noCoverageFrom(report({ "a.ts": [["NoCoverage", 1]], "b.ts": [["NoCoverage", 2]] }));
    expect(uncovered.map((mutant) => mutant.file)).toEqual(["a.ts", "b.ts"]);
  });
});

// static の除外と disable の除外はどちらも Ignored。混ぜると意図的な除外の総数が
// 見えなくなる（#25）。区別は statusReason — static は Stryker の固定文言。
describe("ignoredBreakdown", () => {
  const ignored = (statusReason?: string) => ({
    mutatorName: "X",
    status: "Ignored",
    ...(statusReason === undefined ? {} : { statusReason }),
    location: { start: { line: 1 } },
  });

  it("static と宣言を分けて数える", () => {
    const report: MutationReport = {
      files: {
        "a.ts": {
          mutants: [
            ignored('Static mutant (and "ignoreStatic" was enabled)'),
            ignored("後段の存在確認が同じ結果を返すため"),
            { mutatorName: "X", status: "Killed", location: { start: { line: 2 } } },
          ],
        },
      },
    };
    expect(ignoredBreakdown(report)).toEqual({ static: 1, declared: 1 });
  });

  // **理由のあるなしは報告からは分からない。** 理由を書かなかった disable にも
  // Stryker は "Ignored using a comment" を入れる（9.6.1 で実測）。だからここでは
  // 宣言として数え、理由の検査はソースを読む reviewDisables が担う（#32）。
  it("Stryker の既定文も宣言として数える", () => {
    const report: MutationReport = { files: { "a.ts": { mutants: [ignored("Ignored using a comment")] } } };
    expect(ignoredBreakdown(report)).toEqual({ static: 0, declared: 1 });
  });

  it("ファイルを跨いで合計する", () => {
    const report: MutationReport = {
      files: { "a.ts": { mutants: [ignored("理由")] }, "b.ts": { mutants: [ignored("理由")] } },
    };
    expect(ignoredBreakdown(report).declared).toBe(2);
  });

  // Stryker の固定文言そのもので判定する。別の文字列に変わると static が宣言側に化ける。
  it("Static mutant で始まらない理由は宣言と数える", () => {
    const report: MutationReport = {
      files: { "a.ts": { mutants: [{ mutatorName: "X", status: "Ignored", statusReason: "static っぽい話", location: { start: { line: 1 } } }] } },
    };
    expect(ignoredBreakdown(report)).toEqual({ static: 0, declared: 1 });
  });

  it("何も無ければ全部 0", () => {
    expect(ignoredBreakdown({ files: {} })).toEqual({ static: 0, declared: 0 });
  });
});

// #32: 宣言したのに 1 件も外れていない disable は、生き残りの数が動かないので
// 正常と区別が付かない。ソース側の宣言と報告側の理由文を突き合わせて見つける。
describe("disableComments", () => {
  function withSource(text: string, body: (root: string, file: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-disable-"));
    try {
      writeFileSync(join(root, "a.ts"), text);
      body(root, "a.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("next-line 付きの宣言を拾う", () => {
    withSource("const a = 1;\n// Stryker disable next-line StringLiteral: 理由の文\nconst b = 2;\n", (root, file) => {
      expect(disableComments(root, [file])).toEqual([
        { file: "a.ts", line: 2, mutators: ["StringLiteral"], reason: "理由の文" },
      ]);
    });
  });

  // 区間形式（next-line 無し）も宣言。拾わないと点検の外に落ちる。
  it("next-line の無い宣言も拾う", () => {
    withSource("  // Stryker disable ConditionalExpression: 理由\n", (root, file) => {
      expect(disableComments(root, [file])[0]!.mutators).toEqual(["ConditionalExpression"]);
    });
  });

  it("複数の mutator を分ける", () => {
    withSource("// Stryker disable next-line ArrayDeclaration,StringLiteral: 理由\n", (root, file) => {
      expect(disableComments(root, [file])[0]!.mutators).toEqual(["ArrayDeclaration", "StringLiteral"]);
    });
  });

  // 理由の無い宣言は Stryker が既定文を入れるので報告からは見分けが付かない。
  // ソース側だけが「書かれていない」を知っている。
  it("理由が無ければ空で返す", () => {
    withSource("// Stryker disable next-line all\n", (root, file) => {
      expect(disableComments(root, [file])[0]).toEqual({ file: "a.ts", line: 1, mutators: ["all"], reason: "" });
    });
  });

  // restore は抑制ではない。拾うと「効いていない宣言」として毎回名指ししてしまう。
  it("restore は宣言ではない", () => {
    withSource("// Stryker restore all\n", (root, file) => {
      expect(disableComments(root, [file])).toEqual([]);
    });
  });

  // 散文の中に出てくる語を拾うと、説明を書いただけで警告が出る。
  it("散文は拾わない", () => {
    withSource("// Stryker disable next-line が指すのは宣言行\n", (root, file) => {
      expect(disableComments(root, [file])).toEqual([]);
    });
  });
});

describe("reviewDisables", () => {
  const comment = (reason: string, mutators = ["StringLiteral"]) => ({ file: "a.ts", line: 5, mutators, reason });
  const ignoredWith = (statusReason: string, mutatorName = "StringLiteral"): MutationReport => ({
    files: { "a.ts": { mutants: [{ mutatorName, status: "Ignored", statusReason, location: { start: { line: 6 } } }] } },
  });

  it("理由で外れた変異があれば効いている", () => {
    expect(reviewDisables([comment("理由の文")], ignoredWith("理由の文")).ineffective).toEqual([]);
  });

  // 報告された症状そのもの。next-line が宣言行を指していて変異のある行に届いていない。
  it("その理由で外れた変異が無ければ効いていない", () => {
    expect(reviewDisables([comment("理由の文")], ignoredWith("別の理由")).ineffective).toHaveLength(1);
  });

  // mutator まで見る。名前が違えば、その宣言が外したものではない。
  it("mutator が違えば効いていない", () => {
    expect(reviewDisables([comment("理由", ["OptionalChaining"])], ignoredWith("理由")).ineffective).toHaveLength(1);
  });

  it("all はどの mutator にも当たる", () => {
    expect(reviewDisables([comment("理由", ["all"])], ignoredWith("理由", "ObjectLiteral")).ineffective).toEqual([]);
  });

  // 理由の無い宣言は突き合わせられない（Stryker が全部同じ既定文にする）。
  // 「理由が無い」として別に名指しし、効き目の判定はしない。
  it("理由の無い宣言は効き目を判定せず理由なしとして出す", () => {
    const review = reviewDisables([comment("")], { files: {} });
    expect(review.unexplained).toHaveLength(1);
    expect(review.ineffective).toEqual([]);
  });

  it("報告にそのファイルが無ければ効いていない", () => {
    expect(reviewDisables([comment("理由")], { files: {} }).ineffective).toHaveLength(1);
  });
});

// 呼び出しは必ず it の中で行う。describe の直下で値を作ると、
// 変異が有効になる前に計算が終わっていて、テストが変異を検知できない。
describe("vitestRunnerPlugin", () => {
  // Stryker の既定 plugins（"@stryker-mutator/*"）は自分の隣を readdir する。
  // pnpm の分離レイアウトでは vitest-runner が隣に無く、原理的に見つからない（h3 で実測）。
  // 対象リポジトリから解決した絶対パスを渡すことでレイアウトに依らなくなる。
  it("対象リポジトリから解決する", () => {
    const resolved = vitestRunnerPlugin(process.cwd());
    expect(resolved).toContain("@stryker-mutator/vitest-runner");
    // **対象リポジトリの中**まで固定する。名前の一致だけだと、解決の基点が
    // 親ディレクトリへずれる形を検知できない — リポジトリの中に入れ子で置いた
    // worktree では Node の解決が親の node_modules へ抜けて偶然通り、
    // 置き場所で結果が変わる（このリポジトリの worktree で実測）。
    expect(resolved).toContain(join(process.cwd(), "node_modules"));
    expect(isAbsolute(resolved)).toBe(true);
  });

  it("入っていなければ導入コマンドを添えて落とす", () => {
    withRepo((root) => {
      expect(() => vitestRunnerPlugin(root)).toThrow(/@stryker-mutator\/vitest-runner/);
      expect(() => vitestRunnerPlugin(root)).toThrow(RunnerError);
    });
  });
});

/** node_modules を持たない空のリポジトリ。 */
function withRepo(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-deps-"));
  try {
    writeFileSync(join(root, "package.json"), "{}");
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 変異対象 0 ファイルの回でも呼ばれる入口。ここが素通りすると、導入直後の種置き
// （差分にソースが無い）が緑になり、壊れていることが最初の実装 PR まで隠れる。
describe("requireMutationTools", () => {
  it("揃っていれば通る", () => {
    expect(() => requireMutationTools(process.cwd())).not.toThrow();
  });

  // 2 つとも「そのまま打てば直る 1 行」を添える。どちらが欠けても入れるものは同じ。
  const install = "npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner";

  it("Stryker 本体が無ければ落ちる", () => {
    withRepo((root) => {
      const message = `Stryker が入っていません。次で入れてください:\n  ${install}`;
      expect(() => requireMutationTools(root)).toThrow(message);

      // `.bin` があっても中身が無ければ同じ（existsSync はディレクトリにも真を返す）。
      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      expect(() => requireMutationTools(root)).toThrow(message);
    });
  });

  // 本体だけ入っている状態は pnpm で普通に起きる（h3 で実測）。
  it("本体があっても vitest-runner が無ければ落ちる", () => {
    withRepo((root) => {
      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(root, "node_modules", ".bin", "stryker"), "");
      expect(() => requireMutationTools(root)).toThrow(
        `Stryker の vitest-runner が見つかりません。次で入れてください:\n  ${install}`,
      );
    });
  });
});

// Stryker の --inPlace は元ファイルを読んで書き戻すので mode が既定に落ちる
// （h3 で bin/h3.mjs が 755 → 644）。gauntlet が対象リポジトリに残す変更は無いのが約束。
describe("fileModes / restoreModes", () => {
  it("実行ビットを戻す", () => {
    withRepo((root) => {
      const path = join(root, "bin.mjs");
      writeFileSync(path, "", { mode: 0o755 });
      const modes = fileModes(root, ["bin.mjs"]);

      chmodSync(path, 0o644);
      restoreModes(modes);

      expect(statSync(path).mode & 0o777).toBe(0o755);
    });
  });

  it("実行ビットの無いファイルはそのまま", () => {
    withRepo((root) => {
      const path = join(root, "src.ts");
      writeFileSync(path, "", { mode: 0o644 });
      restoreModes(fileModes(root, ["src.ts"]));
      expect(statSync(path).mode & 0o777).toBe(0o644);
    });
  });

  it("無いファイルは控えない", () => {
    withRepo((root) => {
      expect(fileModes(root, ["gone.ts"]).size).toBe(0);
    });
  });

  // 戻すのは finally の中。ここで例外になると、変異が落ちた本当の理由が消える。
  it("控えたあとに消えても落ちない", () => {
    withRepo((root) => {
      expect(() => restoreModes(new Map([[join(root, "gone.ts"), 0o644]]))).not.toThrow();
    });
  });
});

describe("strykerConfig", () => {
  // 既定の 5 分は全スイート + perTest coverage には足りない（duct の CI で 5 分 02 秒で
  // 打ち切られた）。手元では通り CI だけで落ちる、という形になるので必ず外側に置く。
  it("初回実行の打ち切りを CI job の外側に置く", () => {
    expect(strykerConfig([], "/tmp/out", null, "/p/x.js").dryRunTimeoutMinutes).toBe(60);
  });

  // 設定は丸ごと固定する。1 つ欠けると duct で踏んだ形（退避先をリポジトリ内に作り、
  // その中のテストを vitest が拾って coverage 解析が壊れる）や、h3 で踏んだ形
  // （plugins 未指定だと Stryker が自分の隣を readdir するので、pnpm の分離レイアウトでは
  // vitest-runner が原理的に見つからない）に戻る。
  it("丸ごと固定する", () => {
    expect(strykerConfig(["a.ts", "b.ts"], "/tmp/out", "/conf/vitest.config.mjs", "/p/vitest-runner/index.js")).toEqual({
      testRunner: "vitest",
      inPlace: true,
      disableTypeChecks: false,
      dryRunTimeoutMinutes: 60,
      tempDirName: "/tmp/out",
      ignoreStatic: true,
      reporters: ["json"],
      plugins: ["/p/vitest-runner/index.js"],
      mutate: ["a.ts", "b.ts"],
      vitest: { configFile: "/conf/vitest.config.mjs" },
    });
  });

  // 上流が置けないと言った 1 種類だけを外す。ここが消えると全損に戻る。
  it("外す mutator を渡されたら設定に載せる", () => {
    const config = strykerConfig(["a.ts"], "/tmp/out", null, "/p/x.js", ["StringLiteral"]);
    expect(config.mutator).toEqual({ excludedMutations: ["StringLiteral"] });
  });

  // 何も外していない回に空の指定を書くと、外したように読める。
  it("外すものが無ければ mutator キーを足さない", () => {
    expect(strykerConfig(["a.ts"], "/tmp/out", null, "/p/x.js", [])).not.toHaveProperty("mutator");
  });

  // リポジトリに vitest 設定が無ければラッパーも無い。既定の解決に任せる。
  it("ラッパーが無ければ vitest キーを足さない", () => {
    expect(strykerConfig([], "/tmp/out", null, "/p/vitest-runner/index.js")).not.toHaveProperty("vitest");
  });
});

// 上流は 2020 年から 1〜2 年おきに「置けない構文」で全損している（StringLiteral →
// MethodExpression → BooleanLiteral）。構文ごとの特例を持たず、エラー文が名乗る名前を読む。
// --inPlace はプロジェクト全体を退避して書き戻すので、同じ作業ツリーで 2 つ走ると
// 後に書き戻した方が勝ち、もう一方の未コミットの編集が消える（このリポジトリで実際に消えた）。
describe("lockPath / lockHolder", () => {
  it("リポジトリごとに別の印になる", () => {
    expect(lockPath("/a/repo")).not.toBe(lockPath("/b/repo"));
  });

  // 作業ツリーの中に置くと、印そのものが差分になる。
  it("印はリポジトリの外に置く", () => {
    expect(lockPath("/a/repo").startsWith("/a/repo")).toBe(false);
  });

  // 名前の形を固定する。長さや素材が変わると、同じリポジトリを別物と見て
  // 二重起動を素通しする（印は当たらなければ意味が無い）。
  it("印の名前の形を固定する", () => {
    expect(basename(lockPath("/a/repo"))).toMatch(/^gauntlet-mutation-[0-9a-f]{12}\.lock$/);
  });

  it("印が無ければ誰も握っていない", () => {
    withRepo((root) => {
      expect(lockHolder(join(root, "none.lock"))).toBe(null);
    });
  });

  it("生きているプロセスの印は握られている", () => {
    withRepo((root) => {
      const path = join(root, "live.lock");
      writeFileSync(path, String(process.pid));
      expect(lockHolder(path)).toBe(process.pid);
    });
  });

  // 改行つきで書かれても読めないと、印を残骸と誤認して素通しする。
  it("前後の空白があっても読む", () => {
    withRepo((root) => {
      const path = join(root, "padded.lock");
      writeFileSync(path, `${process.pid}\n`);
      expect(lockHolder(path)).toBe(process.pid);
    });
  });

  // 印を消さずに死ぬことはある（kill -9、電源断）。残骸で永久に止まってはいけない。
  it("死んだプロセスの印は握られていない", () => {
    withRepo((root) => {
      const path = join(root, "stale.lock");
      writeFileSync(path, "2147483647");
      expect(lockHolder(path)).toBe(null);
    });
  });
});

describe("unplaceableMutators", () => {
  const message =
    'ERROR Stryker SyntaxError: src/h3.ts:73:2 expressionMutantPlacer could not place mutants ' +
    'with type(s): "StringLiteral". Either remove this file from the list of files to be mutated';

  it("置けなかった mutator を読む", () => {
    expect(unplaceableMutators(message)).toEqual(["StringLiteral"]);
  });

  it("複数あれば全部読む", () => {
    expect(unplaceableMutators('could not place mutants with type(s): "StringLiteral", "BooleanLiteral".')).toEqual([
      "StringLiteral",
      "BooleanLiteral",
    ]);
  });

  it("同じものは畳む", () => {
    expect(unplaceableMutators('could not place mutants with type(s): "A", "A".')).toEqual(["A"]);
  });

  // 名前を読めなければ何も外さない。ここで例外になると Stryker の失敗が gauntlet の
  // クラッシュに化けて、原因が 1 段遠くなる。
  it("名前を読めなければ何も外さない", () => {
    expect(unplaceableMutators("could not place mutants with type(s): unknown.")).toEqual([]);
  });

  // 別の理由で落ちた回まで外すと、測る範囲が黙って狭くなる。
  it("別の失敗では何も外さない", () => {
    expect(unplaceableMutators("ERROR Stryker Something went wrong in the initial test run")).toEqual([]);
  });
});

// テストが 0 件のリポジトリは新規導入では珍しくない。Stryker はこれを ConfigError
// （"Please check your configuration"）として投げるので、設定を疑う方向へ誘導される。
describe("dryRunFailure", () => {
  const captured = (combined: string, code: number) => ({ stdout: combined, combined, code });

  it("通っていれば null", () => {
    expect(dryRunFailure(captured("INFO The dry-run has been completed successfully.", 0))).toBe(null);
  });

  it("テストが 0 件なら、設定ではなくテストの話だと言う", () => {
    expect(dryRunFailure(captured("ERROR Stryker No tests were executed. Stryker will exit prematurely.", 1))).toBe(
      NO_TESTS_TO_MUTATE,
    );
  });

  // Stryker は非ゼロで終わらないこともある（0 件はその形で踏んだ）。
  // 終了コードだけを見ると、生スタックのまま素通りする。
  it("終了コードが 0 でも、テスト 0 件は見逃さない", () => {
    expect(dryRunFailure(captured("INFO DryRunExecutor No tests were executed.", 0))).toBe(NO_TESTS_TO_MUTATE);
  });

  it("別の失敗では Stryker の出力を添える", () => {
    const message = dryRunFailure(captured("ERROR Stryker Something went wrong\n    at x (y.js:1:1)", 1));
    expect(message).toBe("Stryker が vitest を起動できませんでした:\nERROR Stryker Something went wrong");
  });

  // 「設定を見直せ」に読めた瞬間に、読み手は間違った方向へ行く。
  it("次にやることだけを言う", () => {
    expect(NO_TESTS_TO_MUTATE).toBe(
      "テストが 1 件も走らなかったので、mutation が回るかは確かめられません。" +
        "設定の誤りではありません — 最初のテストを 1 件書いてから、もう一度 doctor を叩いてください" +
        "（quick / full はテストが 0 件でも通ります）",
    );
  });
});

describe("strykerVitestWrapper", () => {
  // 生成する JS は丸ごと固定する。ここが 1 文字ずれても Stryker の vitest は
  // 黙って別の設定で走り、「宣言が効いているつもり」の緑になる。
  it("生成する設定を丸ごと固定する", () => {
    expect(strykerVitestWrapper("/repo/vitest.config.ts", "/repo", ["node", "dom"])).toBe(
      [
        "// gauntlet が生成した一時ファイル。リポジトリの vitest 設定から、宣言された project だけを残す。",
        'import base from "/repo/vitest.config.ts";',
        'const config = (await (typeof base === "function" ? base({ command: "serve", mode: "test" }) : base)) ?? {};',
        'config.root ??= "/repo";',
        "config.test ??= {};",
        "config.test.typecheck = { enabled: false };",
        'const declared = ["node","dom"];',
        "if (declared.length > 0 && Array.isArray(config.test?.projects)) {",
        "  config.test.projects = config.test.projects.filter(",
        '    (project) => typeof project !== "string" && declared.includes(project?.test?.name),',
        "  );",
        "}",
        "export default config;",
        "",
      ].join("\n"),
    );
  });

  // 宣言が無ければ濾さない（全部走らせる）。root の明示だけが残る。
  it("宣言が空なら projects を濾さないコードになる", () => {
    const wrapper = strykerVitestWrapper("/repo/vitest.config.ts", "/repo", []);
    expect(wrapper).toContain("const declared = [];");
    expect(wrapper).toContain("declared.length > 0 &&");
  });
});

describe("strykerFiles", () => {
  it("先頭が Stryker に渡す設定で、ラッパーの場所を指している", () => {
    const files = strykerFiles("/conf", "/tmp/out", "/repo", "/repo/vitest.config.ts", ["node"], ["a.ts"], "/p/vitest-runner/index.js");
    expect(files.map((file) => file.path)).toEqual(["/conf/stryker.conf.json", "/conf/vitest.config.mjs"]);
    expect(JSON.parse(files[0]!.content)).toEqual(strykerConfig(["a.ts"], "/tmp/out", "/conf/vitest.config.mjs", "/p/vitest-runner/index.js"));
    expect(files[0]!.content).toBe(JSON.stringify(strykerConfig(["a.ts"], "/tmp/out", "/conf/vitest.config.mjs", "/p/vitest-runner/index.js"), null, 2));
    expect(files[1]!.content).toBe(strykerVitestWrapper("/repo/vitest.config.ts", "/repo", ["node"]));
  });

  // リポジトリに vitest 設定が無ければ、濾すべき projects も無い。
  it("リポジトリに設定が無ければラッパーを作らない", () => {
    const files = strykerFiles("/conf", "/tmp/out", "/repo", null, [], ["a.ts"], "/p/vitest-runner/index.js");
    expect(files.map((file) => file.path)).toEqual(["/conf/stryker.conf.json"]);
    expect(JSON.parse(files[0]!.content)).toEqual(strykerConfig(["a.ts"], "/tmp/out", null, "/p/vitest-runner/index.js"));
  });
});

describe("findRepoVitestConfig", () => {
  function withDir(body: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-conf-"));
    try {
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("vitest.config を vite.config より先に見る", () => {
    withDir((root) => {
      writeFileSync(join(root, "vite.config.ts"), "");
      writeFileSync(join(root, "vitest.config.ts"), "");
      expect(findRepoVitestConfig(root)).toBe(join(root, "vitest.config.ts"));
    });
  });

  it.each(["vitest.config.mts", "vitest.config.cts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs", "vite.config.mjs"])(
    "%s を見つける",
    (name) => {
      withDir((root) => {
        writeFileSync(join(root, name), "");
        expect(findRepoVitestConfig(root)).toBe(join(root, name));
      });
    },
  );

  it("無ければ null", () => {
    withDir((root) => {
      expect(findRepoVitestConfig(root)).toBe(null);
    });
  });
});
