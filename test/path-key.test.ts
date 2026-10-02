// Path identity: case folding, the PathSet ledger type and the Windows spellings a tool may report.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeJavaSource } from "../src/observe/java-analyzer.js";
import { classificationPath } from "../src/observe/repository-path.js";
import {
  foldPathCase,
  isCaseInsensitivePlatform,
  PathSet,
  pathKey,
  samePath,
  stripExtendedPathPrefix,
} from "../src/runtime/path-key.js";
import { isPathInside, normalizeToolPath } from "../src/runtime/paths.js";

const onWindows = process.platform === "win32";

test("only Windows and macOS fold case", () => {
  assert.equal(isCaseInsensitivePlatform("win32"), true);
  assert.equal(isCaseInsensitivePlatform("darwin"), true);
  assert.equal(isCaseInsensitivePlatform("linux"), false);
  assert.equal(foldPathCase("AbC", "win32"), "abc");
  assert.equal(foldPathCase("AbC", "linux"), "AbC");
  assert.equal(pathKey("/Repo/A.java", "darwin"), pathKey("/repo/a.java", "darwin"));
  assert.notEqual(pathKey("/Repo/A.java", "linux"), pathKey("/repo/a.java", "linux"));
});

test("a PathSet keeps the first spelling and behaves like a read-only Set", () => {
  const set = new PathSet(["/repo/A.java"]);
  const caseInsensitive = isCaseInsensitivePlatform();
  set.add("/repo/B.java").add("/repo/a.java");
  assert.equal(set.size, caseInsensitive ? 2 : 3);
  assert.equal(set.has("/repo/./A.java"), true, "equivalent spellings of one path");
  assert.equal(set.has("/repo/sub/../A.java"), true);
  assert.equal(set.has("/repo/missing.java"), false);
  assert.deepEqual([...set].slice(0, 2), ["/repo/A.java", "/repo/B.java"], "the first spelling wins");
  assert.deepEqual([...set.keys()], [...set.values()]);
  assert.deepEqual([...set.entries()].map(([left, right]) => left === right), [...set].map(() => true));

  const visited: string[] = [];
  set.forEach((value, again, owner) => {
    assert.equal(value, again);
    assert.equal(owner, set);
    visited.push(value);
  });
  assert.deepEqual(visited, [...set]);

  assert.equal(set.delete("/repo/B.java"), true);
  assert.equal(set.delete("/repo/B.java"), false);
  assert.equal(set.has("/repo/B.java"), false);
  set.clear();
  assert.equal(set.size, 0);
});

test("the extended-length prefix is removed only from drive and UNC paths", () => {
  assert.equal(stripExtendedPathPrefix(String.raw`\\?\D:\repo\A.java`), String.raw`D:\repo\A.java`);
  assert.equal(stripExtendedPathPrefix(String.raw`\\?\unc\Server\Share\a.java`), String.raw`\\Server\Share\a.java`);
  assert.equal(stripExtendedPathPrefix(String.raw`\\?\UNC\Server\Share\a.java`), String.raw`\\Server\Share\a.java`);
  assert.equal(stripExtendedPathPrefix(String.raw`D:\repo\A.java`), String.raw`D:\repo\A.java`);
  assert.equal(stripExtendedPathPrefix(String.raw`\\Server\Share\a.java`), String.raw`\\Server\Share\a.java`);
  assert.equal(stripExtendedPathPrefix(String.raw`\\?\Volume{1234}\a.java`), String.raw`\\?\Volume{1234}\a.java`, "other namespaces are left alone");
  assert.equal(stripExtendedPathPrefix("/repo/A.java"), "/repo/A.java");
  assert.equal(stripExtendedPathPrefix(""), "");
});

test("Windows spellings of one file are one file", { skip: !onWindows }, () => {
  const spellings = [
    String.raw`D:\Repo\src\A.java`,
    "d:/repo/src/a.java",
    String.raw`D:\repo\src\..\src\A.java`,
    String.raw`\\?\D:\Repo\src\A.java`,
    String.raw`\\?\d:\repo\src\a.java`,
    String.raw`D:\repo\.\src\A.java`,
  ];
  for (const left of spellings) {
    for (const right of spellings) assert.equal(samePath(left, right), true, `${left} vs ${right}`);
  }
  assert.equal(samePath(String.raw`D:\repo\src\A.java`, String.raw`D:\repo\src\B.java`), false);
  assert.equal(samePath(String.raw`D:\repo\src\A.java`, String.raw`E:\repo\src\A.java`), false, "different drives");
  assert.equal(samePath("D:\\repo\\src\\", "D:\\repo\\src"), true, "a trailing separator is not part of the identity");
  assert.equal(samePath(String.raw`\\Server\Share\a.java`, String.raw`\\?\UNC\server\share\a.java`), true, "UNC and its extended spelling");
  assert.equal(samePath(String.raw`\\Server\Share\a.java`, String.raw`\\Server\Other\a.java`), false);

  const set = new PathSet([String.raw`D:\Repo\src\A.java`]);
  assert.equal(set.has(String.raw`\\?\d:\repo\src\a.java`), true);
});

test("tool paths with an extended prefix stay inside the repository", { skip: !onWindows }, () => {
  const root = String.raw`D:\repo`;
  const extended = String.raw`\\?\D:\repo\src\main\A.java`;
  assert.equal(normalizeToolPath(root, extended), String.raw`D:\repo\src\main\A.java`);
  assert.equal(normalizeToolPath(root, `@${extended}`), String.raw`D:\repo\src\main\A.java`, "the @ file-mention prefix still works");
  assert.equal(isPathInside(root, normalizeToolPath(root, extended)), true);
  assert.equal(classificationPath(normalizeToolPath(root, extended), root), "/src/main/A.java");
  // Another drive is outside, however it is spelled.
  assert.equal(isPathInside(root, normalizeToolPath(root, String.raw`\\?\E:\repo\src\A.java`)), false);
});

test("a UNC target is outside a drive-letter repository", { skip: !onWindows }, () => {
  assert.equal(isPathInside(String.raw`D:\repo`, String.raw`\\Server\Share\repo\A.java`), false);
  assert.equal(
    classificationPath(String.raw`\\Server\Share\repo\src\A.java`, String.raw`D:\repo`),
    "//Server/Share/repo/src/A.java",
    "a path outside the repository keeps its own full path with normalized separators",
  );
});

test("a Java file deeper than MAX_PATH is analyzed like any other", { skip: !onWindows }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-longpath-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ...Array.from({ length: 12 }, (_value, index) => `a-rather-long-directory-name-${index}`));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Deep.java"), "package deep;\nimport java.util.List;\n@Service\npublic class Deep {}\n");
  } catch {
    t.skip("this Windows installation does not allow paths longer than MAX_PATH");
    return;
  }
  assert.ok(join(dir, "Deep.java").length > 260);
  const facts = analyzeJavaSource(join(dir, "Deep.java"), "package deep;\nimport java.util.List;\n@Service\npublic class Deep {}\n", root);
  assert.equal(facts.packageName, "deep");
  assert.deepEqual(facts.imports, ["java.util.List"]);
  assert.deepEqual(facts.annotations, ["Service"]);
});
