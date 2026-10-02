// Documentation drift guards: the facts the docs state about the repository must match the repository.
// These checks are mechanical on purpose. They do not judge prose; they catch a renamed file, a changed default,
// a new command, a bumped version or a test count that was updated in one document and forgotten in another.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { registerConventionSenseSpike } from "../extensions/index.js";
import { createDefaultConfig, loadSpikeConfig } from "../src/runtime/config.js";
import { createHarness } from "./support/fake-pi.js";

const root = resolve(".");
// Normalized to LF so the checks also pass in a Windows checkout with CRLF line endings.
const read = (path: string): string => readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");

function markdownFiles(directory = root, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", ".tmp", ".claude", "fixtures"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) markdownFiles(path, found);
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

const rel = (path: string): string => relative(root, path).replaceAll("\\", "/");

// Documents that record what was true at a point in time. Their prose is not kept in sync with the code.
const HISTORICAL = (path: string): boolean =>
  path.startsWith("docs/evaluations/") || path.startsWith("docs/research/") || /^docs\/stage-\d/.test(path) || path === "CHANGELOG.md";

test("every relative Markdown link points at an existing file", () => {
  const broken: string[] = [];
  for (const file of markdownFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = match[1] ?? "";
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(dirname(file), target))) broken.push(`${rel(file)} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

// Paths that exist only at run time in a target project, or that are generic examples rather than references.
const RUNTIME_PATHS = [
  /^\.pi\/convention-sense(\.json|\/)/,
  /^\.pi\/(extensions|skills)$/,
  /^\.convention-sense\/profile\.candidate\.json$/,
  /^\.tmp\//,
  /^src\/main\/java$/,
];

test("repository paths named in current documents exist", () => {
  const missing: string[] = [];
  for (const file of markdownFiles()) {
    const name = rel(file);
    if (HISTORICAL(name)) continue;
    const pattern = /`((?:src|test|scripts|docs|examples|extensions|skills|\.github|\.convention-sense|\.pi)\/[A-Za-z0-9_./-]+)`/g;
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      const target = (match[1] ?? "").replace(/[.,]$/, "");
      if (RUNTIME_PATHS.some((allowed) => allowed.test(target))) continue;
      if (!existsSync(join(root, target))) missing.push(`${name}: ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the version, Pi baseline and test baseline are stated consistently", () => {
  const manifest = JSON.parse(read("package.json")) as { version: string; devDependencies: Record<string, string> };
  const piVersion = manifest.devDependencies["@earendil-works/pi-coding-agent"];
  assert.ok(piVersion);

  for (const name of ["README.md", "AGENTS.md", "docs/knowledge-base.md"]) {
    assert.ok(read(name).includes(manifest.version), `${name} should state the development version ${manifest.version}`);
    assert.ok(read(name).includes(piVersion), `${name} should state the Pi baseline ${piVersion}`);
  }
  assert.ok(read("docs/compatibility.md").includes(piVersion), "compatibility.md should state the Pi baseline");
  assert.match(read("CHANGELOG.md"), /^## \[Unreleased\]/m, "an unreleased version needs an [Unreleased] section");

  // The number of tests appears in several documents; they must all agree (the value itself is checked by `npm run verify`).
  const counts = new Map<string, string[]>();
  for (const name of ["README.md", "AGENTS.md", "docs/knowledge-base.md", "docs/compatibility.md", "docs/project-intelligence.md"]) {
    for (const line of read(name).split("\n")) {
      if (!/npm run verify|自动测试|个测试/.test(line)) continue;
      for (const match of line.matchAll(/\b(\d{2,4})\/\1\b|\b(\d{2,4}) 个(?:自动)?测试/g)) {
        const value = match[1] ?? match[2] ?? "";
        counts.set(value, [...(counts.get(value) ?? []), name]);
      }
    }
  }
  assert.ok(counts.size > 0, "the test baseline is no longer documented anywhere");
  assert.equal(counts.size, 1, `documents disagree about the number of tests: ${JSON.stringify([...counts])}`);
});

// ---- configuration reference ------------------------------------------------------------------------------------

function valueAt(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], source);
}

function parseDocumentedDefault(text: string): unknown[] {
  return [...text.matchAll(/`([^`]*)`/g)].map((match) => {
    const token = match[1] ?? "";
    try {
      return JSON.parse(token) as unknown;
    } catch {
      return token;
    }
  });
}

test("the README configuration reference matches the real defaults", () => {
  const defaults = createDefaultConfig();
  const section = read("README.md").split("### 完整配置参考")[1]?.split("\n### ")[0] ?? "";
  const rows = section.split("\n").filter((line) => line.startsWith("| `"));
  assert.ok(rows.length >= 18, `expected the whole configuration table, found ${rows.length} rows`);

  const documented = new Set<string>();
  for (const row of rows) {
    const [keyCell = "", defaultCell = ""] = row.split("|").slice(1, 3).map((cell) => cell.trim());
    const keys: string[] = [];
    let prefix = "";
    for (const token of [...keyCell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "")) {
      const key = token.startsWith(".") ? `${prefix}${token}` : token;
      if (!token.startsWith(".")) prefix = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : "";
      keys.push(key);
    }
    const parts = defaultCell.includes(" / ") ? defaultCell.split(" / ") : [defaultCell];
    keys.forEach((key, index) => {
      documented.add(key);
      const expected = valueAt(defaults, key);
      assert.notEqual(expected, undefined, `README documents a configuration key that does not exist: ${key}`);
      const tokens = parseDocumentedDefault(keys.length > 1 ? (parts[index] ?? "") : defaultCell);
      // A list default is written either as one JSON array (`["java"]`, `[]`) or as several backticked items.
      const items = tokens.length === 1 && Array.isArray(tokens[0]) ? (tokens[0] as unknown[]) : tokens;
      const actual = Array.isArray(expected) ? [...expected].sort() : expected;
      const claimed = Array.isArray(expected) ? [...items].sort() : tokens[0];
      assert.deepEqual(claimed, actual, `README default for ${key} differs from the code`);
    });
  }

  // Every key the code knows about is documented.
  const flatten = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, item]) => flatten(item, `${prefix}${key}.`))
      : [prefix.slice(0, -1)];
  const undocumented = flatten(defaults).filter((key) => !documented.has(key));
  assert.deepEqual(undocumented, [], "configuration keys missing from the README reference");
});

test("the design document's configuration sample is the default configuration", () => {
  const design = read("docs/design.md");
  const block = design.split("## 12. 配置设计")[1]?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(block, "the configuration sample in design.md was not found");
  assert.deepEqual(JSON.parse(block), createDefaultConfig());
});

test("every shipped example configuration loads without diagnostics", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-convention-examples-"));
  try {
    for (const directory of ["examples/config"]) {
      for (const name of readdirSync(join(root, directory))) {
        const project = join(scratch, directory.replace("/", "-"), name);
        mkdirSync(join(project, ".pi"), { recursive: true });
        writeFileSync(join(project, ".pi", "convention-sense.json"), read(`${directory}/${name}`));
        const loaded = loadSpikeConfig(project, true);
        assert.equal(loaded.usedProjectConfig, true, `${directory}/${name} was not used`);
        assert.deepEqual(loaded.diagnostics, [], `${directory}/${name} produced diagnostics`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the documented commands are exactly the registered commands", () => {
  const harness = createHarness(mkdtempSync(join(tmpdir(), "pi-convention-commands-")));
  registerConventionSenseSpike(harness.api);
  const registered = [...harness.commands.keys()].sort();
  assert.ok(registered.length >= 5);

  const readme = read("README.md");
  const section = readme.split("## 12. Pi 命令")[1]?.split("\n## ")[0] ?? "";
  const documented = [...new Set([...section.matchAll(/^\/(convention-[a-z-]+)/gm)].map((match) => match[1] ?? ""))].sort();
  assert.deepEqual(documented, registered, "README section 12 lists different commands than the extension registers");

  const profiler = read("skills/project-profiler/SKILL.md");
  for (const mode of ["init", "adopt", "refresh", "diff"]) assert.match(profiler, new RegExp(`\`${mode}\``), `SKILL.md lacks mode ${mode}`);
  rmSync(String(harness.ctx.cwd), { recursive: true, force: true });
});
