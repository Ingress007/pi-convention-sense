import { existsSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { isPathInside } from "../runtime/paths.js";
import type { ConventionScope, JavaFileFacts, ScopeConfidence } from "./types.js";

const BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts"];
const ROLE_PACKAGE_SEGMENTS = new Set([
  "controller",
  "service",
  "services",
  "mapper",
  "repository",
  "repositories",
  "dto",
  "request",
  "response",
  "entity",
  "domain",
  "application",
]);
const GENERIC_PACKAGE_SEGMENTS = new Set(["com", "org", "net", "io", "java", "src", "main", "impl"]);

function findSourceRoot(path: string): string | undefined {
  const normalized = resolve(path);
  const parts = normalized.split(sep);
  for (let index = 0; index <= parts.length - 3; index += 1) {
    if (parts[index] === "src" && (parts[index + 1] === "main" || parts[index + 1] === "test") && parts[index + 2] === "java") {
      return parts.slice(0, index + 3).join(sep) || sep;
    }
  }
  return undefined;
}

function findNearestBuildRoot(filePath: string, repositoryRoot: string): string | undefined {
  let current = dirname(filePath);
  const root = resolve(repositoryRoot);
  while (isPathInside(root, current, { allowEqual: true })) {
    if (BUILD_FILES.some((name) => existsSync(resolve(current, name)))) return current;
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function packageBusinessModule(packageName: string | undefined): string | undefined {
  if (!packageName) return undefined;
  const segments = packageName.split(".").filter(Boolean);
  const roleIndex = segments.findIndex((segment) => ROLE_PACKAGE_SEGMENTS.has(segment.toLowerCase()));
  if (roleIndex > 0) {
    for (let index = roleIndex - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (segment && !GENERIC_PACKAGE_SEGMENTS.has(segment.toLowerCase())) return segment;
    }
  }
  return undefined;
}

function combineConfidence(role: ScopeConfidence, module: ScopeConfidence): ScopeConfidence {
  if (role === "low" || module === "low") return "low";
  if (role === "high" && module === "high") return "high";
  return "medium";
}

export function detectConventionScope(
  targetPath: string,
  repositoryRoot: string,
  facts: JavaFileFacts,
): ConventionScope {
  const repo = resolve(repositoryRoot);
  const buildRoot = findNearestBuildRoot(targetPath, repo);
  const sourceRoot = findSourceRoot(targetPath);
  const buildIsRepository = buildRoot === repo;
  const packageModule = packageBusinessModule(facts.packageName);

  let module: string;
  let moduleConfidence: ScopeConfidence;
  let root: string;

  if (buildRoot && !buildIsRepository) {
    module = relative(repo, buildRoot).split(sep).filter(Boolean).join(":") || basename(buildRoot);
    moduleConfidence = "high";
    root = buildRoot;
  } else if (packageModule) {
    module = packageModule;
    moduleConfidence = "medium";
    root = buildRoot ?? sourceRoot ?? repo;
  } else if (buildRoot) {
    module = basename(buildRoot) || "repository";
    moduleConfidence = "medium";
    root = buildRoot;
  } else if (sourceRoot) {
    module = basename(dirname(dirname(dirname(sourceRoot)))) || basename(repo) || "repository";
    moduleConfidence = "low";
    root = sourceRoot;
  } else {
    module = basename(dirname(targetPath)) || basename(repo) || "repository";
    moduleConfidence = "low";
    root = dirname(targetPath);
  }

  return {
    language: "java",
    module,
    role: facts.role,
    root,
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(facts.packageName ? { packageName: facts.packageName } : {}),
    confidence: combineConfidence(facts.roleConfidence, moduleConfidence),
  };
}

export function scopeKey(scope: ConventionScope): string {
  return `${scope.language}:${scope.module}:${scope.effectiveRole ?? scope.role}`;
}
