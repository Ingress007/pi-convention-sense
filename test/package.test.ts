// What `npm publish` would ship, and the metadata a published Pi package needs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;

function packedFiles(): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(result.status, 0, result.stderr);
  const [packed] = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
  assert.ok(packed, "npm pack produced no result");
  return packed.files.map((file) => file.path.replaceAll("\\", "/")).sort();
}

function tsFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? tsFiles(`${directory}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${directory}/${entry.name}`] : [],
  );
}

test("the package carries the metadata and license a published Pi package needs", () => {
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.private, undefined, "a private package cannot be published");
  assert.ok(manifest.author);
  assert.match(manifest.repository?.url ?? "", /^git\+https:\/\/github\.com\/.+\.git$/);
  assert.match(manifest.bugs?.url ?? "", /^https:\/\/github\.com\//);
  assert.match(manifest.homepage ?? "", /^https:\/\/github\.com\//);
  assert.ok(manifest.keywords.includes("pi-package"), "the keyword that lists the package as a Pi package");
  assert.equal(manifest.scripts.prepublishOnly, "npm run verify", "publishing must run the full verification first");
  assert.match(readFileSync(join(root, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) \d{4} \S+/);
});

test("the published files are exactly the runtime, the docs and the Skill", () => {
  const files = packedFiles();
  const has = (path: string) => files.includes(path);

  for (const required of ["package.json", "LICENSE", "README.md", "CHANGELOG.md", "extensions/index.ts", "skills/project-profiler/SKILL.md", "skills/project-profiler/scripts/profile-tools.mjs"]) {
    assert.ok(has(required), `the package lacks ${required}`);
  }
  // The extension is loaded from TypeScript source, so every source file must ship.
  for (const source of [...tsFiles("src"), ...tsFiles("extensions")]) assert.ok(has(source), `the package lacks ${source}`);
  // Everything the Pi manifest points at ships.
  for (const extension of manifest.pi.extensions as string[]) assert.ok(has(extension.replace(/^\.\//, "")), `manifest extension ${extension}`);
  for (const skill of manifest.pi.skills as string[]) assert.ok(files.some((file) => file.startsWith(`${skill.replace(/^\.\//, "")}/`)), `manifest skill ${skill}`);

  const forbidden = [/^test\//, /^dist\//, /^\.tmp\//, /^\.pi\//, /^node_modules\//, /^scripts\//, /^\.github\//, /\.tgz$/, /^\.env/, /^CLAUDE\.md$/, /^AGENTS\.md$/, /^tsconfig/];
  for (const file of files) {
    assert.ok(!forbidden.some((pattern) => pattern.test(file)), `${file} must not be published`);
  }
});

test("scripts that import the unpublished build output are not shipped", () => {
  const importsDist = readdirSync(join(root, "scripts")).filter((name) => /from "\.\.\/dist\//.test(readFileSync(join(root, "scripts", name), "utf8")));
  assert.ok(importsDist.length > 0, "this guard is only meaningful while such scripts exist");
  assert.ok(!(manifest.files as string[]).includes("scripts"), `scripts/ imports dist/ (${importsDist.join(", ")}), which is not published`);
});

test("the only runtime dependency is declared, pinned and used", () => {
  assert.deepEqual(Object.keys(manifest.dependencies), ["minimatch"]);
  assert.match(manifest.dependencies.minimatch, /^\d+\.\d+\.\d+$/, "runtime dependencies are pinned");
  assert.deepEqual(Object.keys(manifest.peerDependencies), ["@earendil-works/pi-coding-agent"]);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");

  // Packages imported by shipped source must be dependencies, peers or Node built-ins; a dev-only import would break installs.
  const allowed = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)]);
  const offenders: string[] = [];
  for (const file of [...tsFiles("src"), ...tsFiles("extensions")]) {
    for (const match of readFileSync(join(root, file), "utf8").matchAll(/^(?:import|export)\b[^;]*?\sfrom "([^".][^"]*)"/gm)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith("node:")) continue;
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? "");
      if (!allowed.has(name)) offenders.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});
