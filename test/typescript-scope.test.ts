// How a TypeScript/Vue file is assigned to a module, source root and confidence.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { detectTypeScriptScope } from "../src/observe/typescript-scope-detector.js";
import type { ScopeConfidence, TypeScriptFileFacts, WebRole } from "../src/observe/types.js";

const root = mkdtempSync(join(tmpdir(), "pi-convention-ts-scope-"));
after(() => rmSync(root, { recursive: true, force: true }));

function touch(...segments: string[]): string {
  const path = join(root, ...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, segments.at(-1) === "package.json" ? "{}" : "");
  return path;
}

function facts(role: WebRole, roleConfidence: ScopeConfidence, extra: Partial<TypeScriptFileFacts> = {}): TypeScriptFileFacts {
  return {
    path: "x", language: "typescript", role, roleConfidence, sourceKind: "production", annotations: [], imports: [], superTypes: [],
    signals: {}, size: 0, mtimeMs: 0, contentHash: "h", generated: false, deprecated: false, exportNames: [], frameworkPrimitives: [],
    ...extra,
  };
}

test("a workspace package is its own module, whatever lies below it", () => {
  const target = touch("repo-a", "packages", "ui", "src", "button", "Button.ts");
  const scope = detectTypeScriptScope(target, join(root, "repo-a"), facts("component", "high", { workspacePackage: "ui" }));
  assert.equal(scope.module, "packages:ui");
  assert.equal(scope.root, resolve(root, "repo-a", "packages", "ui"));
  assert.equal(scope.sourceRoot, resolve(root, "repo-a", "packages", "ui", "src"));
  assert.equal(scope.packageName, "ui");
  assert.equal(scope.confidence, "high");

  const app = touch("repo-a", "Apps", "web", "main.ts");
  const appScope = detectTypeScriptScope(app, join(root, "repo-a"), facts("unknown", "low"));
  assert.equal(appScope.module, "apps:web", "the directory family is matched without regard to case");
  assert.equal(appScope.sourceRoot, undefined, "no src directory under the workspace");
  assert.equal(appScope.confidence, "low", "a low role confidence caps the scope");
});

test("a directory directly under packages (no package name) is not a workspace", () => {
  const target = touch("repo-b", "packages", "loose.ts");
  const scope = detectTypeScriptScope(target, join(root, "repo-b"), facts("unknown", "high"));
  assert.notEqual(scope.module, "packages:loose.ts");
  assert.equal(scope.confidence, "low", "no package.json and no workspace: the module is a guess");
});

test("a nested package.json defines the module and keeps high module confidence", () => {
  touch("repo-c", "package.json");
  touch("repo-c", "frontend", "admin", "package.json");
  const target = touch("repo-c", "frontend", "admin", "src", "views", "Home.vue");
  const scope = detectTypeScriptScope(target, join(root, "repo-c"), facts("page", "high", { language: "vue" }));
  assert.equal(scope.language, "vue");
  assert.equal(scope.module, "frontend:admin");
  assert.equal(scope.root, resolve(root, "repo-c", "frontend", "admin"));
  assert.equal(scope.sourceRoot, resolve(root, "repo-c", "frontend", "admin", "src"));
  assert.equal(scope.confidence, "high");
  assert.equal(scope.role, "page");
});

test("a medium role confidence yields a medium scope even with a certain module", () => {
  touch("repo-d", "sub", "package.json");
  const target = touch("repo-d", "sub", "src", "a.ts");
  assert.equal(detectTypeScriptScope(target, join(root, "repo-d"), facts("component", "medium")).confidence, "medium");
});

test("the repository root package is a medium-confidence module named after the repository", () => {
  touch("repo-e", "package.json");
  const target = touch("repo-e", "src", "main.ts");
  const scope = detectTypeScriptScope(target, join(root, "repo-e"), facts("component", "high"));
  assert.equal(scope.module, "repo-e");
  assert.equal(scope.root, resolve(root, "repo-e"));
  assert.equal(scope.confidence, "medium");
  assert.equal(scope.sourceRoot, resolve(root, "repo-e", "src"));
});

test("without any package.json the whole repository is one low-confidence module", () => {
  const target = touch("repo-f", "lib", "util.ts");
  const scope = detectTypeScriptScope(target, join(root, "repo-f"), facts("component", "high"));
  assert.equal(scope.module, "repo-f");
  assert.equal(scope.root, resolve(root, "repo-f"));
  assert.equal(scope.confidence, "low");
  assert.equal(scope.sourceRoot, undefined);
});

test("a target outside the repository never picks up a package.json from elsewhere", () => {
  touch("repo-g", "package.json");
  const outside = touch("not-repo-g", "package.json");
  const target = touch("not-repo-g", "src", "x.ts");
  assert.ok(outside);
  const scope = detectTypeScriptScope(target, join(root, "repo-g"), facts("component", "high"));
  assert.equal(scope.root, resolve(root, "repo-g"), "the scope stays inside the repository it was asked about");
  assert.equal(scope.sourceRoot, undefined);
  assert.equal(scope.confidence, "low");
});
