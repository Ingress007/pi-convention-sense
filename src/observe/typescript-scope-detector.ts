import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isPathInside } from "../runtime/paths.js";
import type { ConventionScope, ScopeConfidence, TypeScriptFileFacts } from "./types.js";

function combineConfidence(role: ScopeConfidence, module: ScopeConfidence): ScopeConfidence {
  if (role === "low" || module === "low") return "low";
  if (role === "high" && module === "high") return "high";
  return "medium";
}

function workspaceBoundary(
  targetPath: string,
  repositoryRoot: string,
): { module: string; root: string } | undefined {
  const rel = relative(repositoryRoot, targetPath);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return undefined;
  const segments = rel.split(sep).filter(Boolean);
  const index = segments.findIndex((segment) => ["apps", "packages"].includes(segment.toLowerCase()));
  const name = index >= 0 ? segments[index + 1] : undefined;
  // The name must be a directory: `packages/loose.ts` is a file next to the packages, not a package called "loose.ts".
  if (index < 0 || !name || index + 2 >= segments.length) return undefined;
  const family = segments[index]?.toLowerCase();
  return {
    module: `${family}:${name}`,
    root: resolve(repositoryRoot, ...segments.slice(0, index + 2)),
  };
}

function nearestPackageRoot(targetPath: string, repositoryRoot: string): string | undefined {
  const repo = resolve(repositoryRoot);
  let current = dirname(targetPath);
  while (isPathInside(repo, current, { allowEqual: true })) {
    if (existsSync(resolve(current, "package.json"))) return current;
    if (current === repo) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function sourceRoot(targetPath: string, moduleRoot: string): string | undefined {
  const rel = relative(moduleRoot, targetPath);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return undefined;
  const segments = rel.split(sep).filter(Boolean);
  const index = segments.findIndex((segment) => segment === "src");
  return index >= 0 ? resolve(moduleRoot, ...segments.slice(0, index + 1)) : undefined;
}

export function detectTypeScriptScope(
  targetPath: string,
  repositoryRoot: string,
  facts: TypeScriptFileFacts,
): ConventionScope {
  const repo = resolve(repositoryRoot);
  const workspace = workspaceBoundary(targetPath, repo);
  const packageRoot = nearestPackageRoot(targetPath, repo);

  let module: string;
  let root: string;
  let moduleConfidence: ScopeConfidence;
  if (workspace) {
    module = workspace.module;
    root = workspace.root;
    moduleConfidence = "high";
  } else if (packageRoot && packageRoot !== repo) {
    module = relative(repo, packageRoot).split(sep).filter(Boolean).join(":") || basename(packageRoot);
    root = packageRoot;
    moduleConfidence = "high";
  } else {
    module = basename(repo) || "application";
    root = packageRoot ?? repo;
    moduleConfidence = packageRoot ? "medium" : "low";
  }
  const detectedSourceRoot = sourceRoot(targetPath, root);

  return {
    language: facts.language,
    module,
    role: facts.role,
    root,
    ...(detectedSourceRoot ? { sourceRoot: detectedSourceRoot } : {}),
    ...(facts.workspacePackage ? { packageName: facts.workspacePackage } : {}),
    confidence: combineConfidence(facts.roleConfidence, moduleConfidence),
  };
}
