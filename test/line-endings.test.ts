// A file's facts must not depend on how its lines end: the same source checked out with LF, CRLF (Windows) or
// old-Mac CR line endings describes the same conventions.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { analyzeJavaSource } from "../src/observe/java-analyzer.js";
import { analyzeTypeScriptFile } from "../src/observe/typescript-analyzer.js";
import type { ObserveLanguage } from "../src/observe/types.js";
import { analyzePracticeSource } from "../src/practice/signal-analyzer.js";

const FIXTURES = resolve("test", "fixtures");
const ENDINGS = { LF: "\n", CRLF: "\r\n", CR: "\r" } as const;

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sourceFiles(path, found);
    } else if ([".java", ".ts", ".vue"].includes(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

/** Facts that describe the code, not the bytes: size, hash, mtime and path legitimately differ. */
function comparable(facts: Record<string, unknown>): Record<string, unknown> {
  const { path: _path, size: _size, mtimeMs: _mtime, contentHash: _hash, ...rest } = facts;
  return rest;
}

function withEnding(text: string, ending: string): string {
  return text.replace(/\r\n|\r|\n/g, ending);
}

test("facts and practice signals do not depend on the line ending style", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-endings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = sourceFiles(FIXTURES);
  assert.ok(files.length > 20, `expected a meaningful corpus, found ${files.length} files`);

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const language: ObserveLanguage = file.endsWith(".java") ? "java" : file.endsWith(".vue") ? "vue" : "typescript";
    const results = Object.entries(ENDINGS).map(([name, ending]) => {
      const path = join(root, name, relative(FIXTURES, file));
      mkdirSync(dirname(path), { recursive: true });
      const content = withEnding(text, ending);
      writeFileSync(path, content);
      const facts = language === "java" ? analyzeJavaSource(path, content, join(root, name)) : analyzeTypeScriptFile(path, join(root, name));
      const practice = analyzePracticeSource(path, join(root, name), language, content).map(({ targetPath: _target, repositoryRoot: _root, ...signal }) => signal);
      return { name, facts: comparable(facts as unknown as Record<string, unknown>), practice };
    });
    const [lf, ...others] = results;
    assert.ok(lf);
    for (const other of others) {
      assert.deepEqual(other.facts, lf.facts, `${relative(FIXTURES, file)}: facts differ between LF and ${other.name}`);
      assert.deepEqual(other.practice, lf.practice, `${relative(FIXTURES, file)}: practice signals differ between LF and ${other.name}`);
    }
  }
});

test("line comments end at either kind of line break", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-comments-"));
  try {
    for (const [name, ending] of Object.entries(ENDINGS)) {
      const source = ["// import commented.Out;", "import real.In;", "class A {}"].join(ending);
      const path = join(root, `${name}.java`);
      writeFileSync(path, source);
      // The class name does not match the file name, which is fine: only the imports are under test.
      assert.deepEqual(analyzeJavaSource(path, source, root).imports, ["real.In"], name);

      const ts = ['// import b from "commented-out";', 'import c from "real";', "export const x = 1;"].join(ending);
      const tsPath = join(root, `${name}.ts`);
      writeFileSync(tsPath, ts);
      assert.deepEqual(analyzeTypeScriptFile(tsPath, root).imports, ["real"], name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a byte-order mark and stray NUL bytes do not break analysis", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-bom-"));
  try {
    const java = "﻿package a.b;\nimport java.util.List;\n@Service\nclass A {}\n";
    const javaPath = join(root, "A.java");
    writeFileSync(javaPath, java);
    const facts = analyzeJavaSource(javaPath, java, root);
    assert.deepEqual(facts.imports, ["java.util.List"]);
    assert.deepEqual(facts.annotations, ["Service"]);

    const noisy = `package a.b;\nimport java.util.List;\u0000\nclass A {\u0000}\n`;
    writeFileSync(javaPath, noisy);
    assert.deepEqual(analyzeJavaSource(javaPath, noisy, root).imports, ["java.util.List"]);

    const ts = '﻿import a from "real";\nexport default a;\n';
    const tsPath = join(root, "x.ts");
    writeFileSync(tsPath, ts);
    assert.deepEqual(analyzeTypeScriptFile(tsPath, root).imports, ["real"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
