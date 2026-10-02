import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeJavaSource } from "../src/observe/java-analyzer.js";
import { analyzeTypeScriptFile } from "../src/observe/typescript-analyzer.js";
import { globMatches, isSupportedGlob } from "../src/runtime/glob.js";
import { loadSpikeConfig } from "../src/runtime/config.js";
import { classifyShellMutationRisk } from "../src/runtime/paths.js";
import { analyzePracticeSource } from "../src/practice/signal-analyzer.js";

// Analysis runs synchronously inside Pi's event loop, so a quadratic regex on one odd file freezes the agent.
// The old implementations needed 5-40 s on these inputs; linear ones need well under 100 ms.
const BUDGET_MS = 1_000;
const SIZE = 250_000;

function repeat(unit: string, bytes = SIZE): string {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

const ADVERSARIAL: ReadonlyArray<readonly [string, string]> = [
  ["import keywords without specifiers", repeat("import ")],
  ["export keywords without specifiers", repeat("export ")],
  ["import clauses without a module", repeat("import { a, b, c } ")],
  ["types-only module without string literals", repeat("export interface Item { id: number; name: string }\n", 900_000)],
  ["unterminated html comments", repeat("<!--")],
  ["unterminated script tags", repeat("<script")],
  ["unclosed script blocks", repeat("<script>")],
  ["unterminated style tags", repeat("<style ")],
  ["defineStore calls without a comma", repeat("defineStore(")],
  ["case labels without a colon", repeat("case ")],
  ["constructor calls without a closing paren", repeat("Order(")],
  ["transactional annotations without a closing paren", repeat("@Transactional(")],
  ["throw expressions without a terminator", repeat("throw new AException(")],
  ["generic method declarations", repeat("public Foo<a, b> ")],
  ["field injection with an enormous type", `@Autowired private ${"a".repeat(60_000)}`],
  ["one identifier repeating a client keyword", repeat("client")],
  ["one identifier repeating a persistence keyword", repeat("mapper")],
  ["blank lines", "\n".repeat(SIZE)],
  ["one whitespace run", " ".repeat(SIZE)],
  ["log placeholders without a closing quote", `log.info("${"{}".repeat(SIZE / 2)}`],
];

function timed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

test("analyzers stay linear on adversarial source", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-robustness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const javaPath = join(root, "Order.java");
  const tsPath = join(root, "x.ts");
  const vuePath = join(root, "x.vue");

  for (const [label, source] of ADVERSARIAL) {
    await t.test(label, () => {
      writeFileSync(javaPath, source);
      writeFileSync(tsPath, source);
      writeFileSync(vuePath, source);
      const slow = Object.entries({
        "java facts": timed(() => analyzeJavaSource(javaPath, source, root)),
        "typescript facts": timed(() => analyzeTypeScriptFile(tsPath, root)),
        "vue facts": timed(() => analyzeTypeScriptFile(vuePath, root)),
        "java practice": timed(() => analyzePracticeSource(javaPath, root, "java", source)),
        "typescript practice": timed(() => analyzePracticeSource(tsPath, root, "typescript", source)),
        "vue practice": timed(() => analyzePracticeSource(vuePath, root, "vue", source)),
      }).filter(([, ms]) => ms > BUDGET_MS);
      assert.deepEqual(
        slow.map(([name, ms]) => `${name}: ${ms.toFixed(0)} ms`),
        [],
        `${label} exceeded ${BUDGET_MS} ms`,
      );
    });
  }
});

test("module specifiers are extracted without scanning past the statement", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-imports-"));
  try {
    const path = join(root, "x.ts");
    writeFileSync(path, [
      'import a from "a-default";',
      "import { b, c } from 'b-named';",
      "import type { T } from \"t-types\";",
      'import * as ns from "ns-all";',
      'import "side-effect";',
      'export * from "re-export-all";',
      'export { d } from "re-export-named";',
      "import {",
      "  multi,",
      "  line,",
      '} from "multi-line";',
      'import e from "export-utils";',
      'const lazy = () => import("lazy-chunk");',
      "export interface Local { value: string }",
      "export const answer = 42;",
      'const text = "not a module";',
    ].join("\n"));
    assert.deepEqual(analyzeTypeScriptFile(path, root).imports, [
      "a-default",
      "b-named",
      "export-utils",
      "lazy-chunk",
      "multi-line",
      "ns-all",
      "re-export-all",
      "re-export-named",
      "side-effect",
      "t-types",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commented-out import is ignored even after astral characters", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-astral-"));
  try {
    const emoji = "\u{1F600}".repeat(3);
    const path = join(root, "x.ts");
    writeFileSync(path, `// ${emoji}\n// import b from "commented-out";\nimport c from "real";\n/* ${emoji} */\n`);
    assert.deepEqual(analyzeTypeScriptFile(path, root).imports, ["real"]);

    const javaPath = join(root, "X.java");
    const java = `// ${emoji}\n// import commented.Out;\nimport real.In;\nclass X {}\n`;
    writeFileSync(javaPath, java);
    assert.deepEqual(analyzeJavaSource(javaPath, java, root).imports, ["real.In"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("practice masking stays aligned after astral characters", () => {
  const emoji = "\u{1F600}".repeat(4);
  const hasTransactionSignal = (source: string) =>
    analyzePracticeSource("X.java", "/repo", "java", source).some(
      (signal) => signal.category === "transaction-side-effect",
    );
  const body = "class X { void f() { client.call(); } }\n";

  // The marker is real code on the line after the emoji comment: a shifted mask would blank its first characters.
  assert.equal(hasTransactionSignal(`// ${emoji}\n@Transactional\n${body}`), true);
  assert.equal(hasTransactionSignal(`/* ${emoji} */ @Transactional\n${body}`), true);
  // The marker is commented out: it must not count.
  assert.equal(hasTransactionSignal(`// ${emoji}\n// @Transactional\n${body}`), false);
});

test("glob matching refuses patterns that would blow up instead of hanging", () => {
  const started = performance.now();
  // Minimatch compiles each segment to a regular expression whose cost explodes with the number of `*` runs.
  assert.equal(globMatches("a".repeat(80), "*a*a*a*a*a*a*b"), false);
  // ...and throws on huge patterns, which would abort a whole repository scan.
  assert.equal(globMatches("abc", "x".repeat(100_000)), false);
  assert.ok(performance.now() - started < BUDGET_MS, "unsupported globs must be rejected without matching");

  // Matching would succeed here, so `false` proves the pattern was refused rather than evaluated.
  assert.equal(globMatches("a".repeat(80), "*a*a*a*a*a*a*"), false);

  for (const [value, pattern] of [
    ["src/main/java/a/FooServiceImpl.java", "**/*Service*Impl*.java"],
    ["packages/web/src/index.ts", "packages/*/src/**"],
    ["src/views/job/batch/modules/job-batch-search.vue", "src/views/**/modules/*-search.vue"],
    ["a/b/c.test.ts", "**/*.{test,spec}.{ts,tsx}"],
  ] as const) {
    assert.equal(globMatches(value, pattern, { dot: true }), true, `${pattern} should still match ${value}`);
  }
  assert.equal(isSupportedGlob("**/generated/**"), true);
  assert.equal(isSupportedGlob(""), false);
});

test("config drops unsupported glob patterns with a diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-glob-config-"));
  try {
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(root, ".pi", "convention-sense.json"),
      JSON.stringify({
        exclude: ["**/ok/**", "*a*a*a*a*a*a*b"],
        guard: { pathExceptions: ["docs/**", "x".repeat(2_000)] },
      }),
    );
    const loaded = loadSpikeConfig(root, true);
    assert.deepEqual(loaded.config.exclude, ["**/ok/**"]);
    assert.deepEqual(loaded.config.guard.pathExceptions, ["docs/**"]);
    assert.equal(loaded.diagnostics.filter((message) => /unsupported glob/i.test(message)).length, 2);
    // A pattern text never reaches the diagnostics verbatim beyond a short preview.
    assert.ok(loaded.diagnostics.every((message) => message.length < 200));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Vue script tag whose generic attribute contains > still yields its body", () => {
  const sfc = [
    '<script setup lang="ts" generic="T extends Array<string>">',
    "async function save() {",
    "  transaction(() => {});",
    '  await fetch("/api");',
    "}",
    "</script>",
    "<template><div /></template>",
  ].join("\n");
  const categories = analyzePracticeSource("X.vue", "/repo", "vue", sfc).map((signal) => signal.category);
  assert.deepEqual(categories, ["transaction-side-effect"]);

  // Quotes of either kind protect a `>`, an unterminated quote swallows nothing past the end of the file.
  const single = sfc.replace('generic="T extends Array<string>"', "generic='T extends Array<string>'");
  assert.deepEqual(analyzePracticeSource("X.vue", "/repo", "vue", single).map((signal) => signal.category), ["transaction-side-effect"]);
  assert.deepEqual(analyzePracticeSource("X.vue", "/repo", "vue", '<script setup generic="T extends A<B>\ntransaction(); fetch(1);</script>'), []);
});

test("shell command classification stays linear on very long single-line commands", () => {
  // Commands are model output and run through this classifier before every shell tool call.
  for (const unit of ["sed ", "perl -x ", "python ", "node ", "ruby ", "> a ", "| tee a ", "rm ", "cd x && npm install "]) {
    const command = repeat(unit);
    const elapsed = timed(() => classifyShellMutationRisk(command));
    assert.ok(elapsed < BUDGET_MS, `${JSON.stringify(unit)} x ${command.length} took ${elapsed.toFixed(0)} ms`);
  }
  // The flags are still found when they are far from the command word.
  assert.deepEqual(classifyShellMutationRisk("sed -n 's/a/b/' -i src/A.java"), ["in-place-edit"]);
  const longExpression = `sed -e '${"s/aa/bb/;".repeat(120)}' -i src/A.java`;
  assert.ok(longExpression.length > 900);
  assert.ok(classifyShellMutationRisk(longExpression).includes("in-place-edit"));
  assert.ok(classifyShellMutationRisk(`python ${"x ".repeat(300)} -c 'print(1)'`).includes("script"));
});
