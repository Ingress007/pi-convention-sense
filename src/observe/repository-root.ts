import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { isPathInside } from "../runtime/paths.js";

const BUILD_MARKERS = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

function startingDirectory(targetPath: string): string {
  let current = resolve(targetPath);
  if (existsSync(current)) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // Fall through to the parent path.
    }
  }
  return dirname(current);
}

function findNearestGitRoot(targetPath: string): string | undefined {
  let current = startingDirectory(targetPath);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findOutermostBuildRoot(targetPath: string): string | undefined {
  let current = startingDirectory(targetPath);
  let outermost: string | undefined;
  while (true) {
    if (BUILD_MARKERS.some((marker) => existsSync(resolve(current, marker)))) outermost = current;
    const parent = dirname(current);
    if (parent === current) return outermost;
    current = parent;
  }
}

const WEB_SOURCE = /.(?:ts|tsx|mts|cts|vue)$/i;

function declaresWorkspaces(directory: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null && "workspaces" in manifest;
  } catch {
    return false;
  }
}

// Without a .git directory a web project has no repository boundary, so the nearest package.json
// is its root, upgraded to the outermost pnpm/npm workspace root so `apps/<name>` stays visible.
function findWebProjectRoot(targetPath: string): string | undefined {
  let current = startingDirectory(targetPath);
  let nearest: string | undefined;
  let workspaceRoot: string | undefined;
  while (true) {
    const hasManifest = existsSync(resolve(current, "package.json"));
    if (hasManifest) nearest ??= current;
    if (existsSync(resolve(current, "pnpm-workspace.yaml")) || (hasManifest && declaresWorkspaces(current))) {
      workspaceRoot = current;
    }
    const parent = dirname(current);
    if (parent === current) return workspaceRoot ?? nearest;
    current = parent;
  }
}

function findSourceModuleRoot(targetPath: string): string | undefined {
  const normalized = resolve(targetPath);
  const parts = normalized.split(sep);
  for (let index = 0; index <= parts.length - 3; index += 1) {
    if (
      parts[index] === "src" &&
      (parts[index + 1] === "main" || parts[index + 1] === "test") &&
      parts[index + 2] === "java"
    ) {
      return parts.slice(0, index).join(sep) || sep;
    }
  }
  return undefined;
}

export function resolveAnalysisRepositoryRoot(targetPath: string, workingDirectory: string): string {
  const target = resolve(targetPath);
  const cwd = resolve(workingDirectory);
  const gitRoot = findNearestGitRoot(target);
  if (gitRoot) return gitRoot;
  if (isPathInside(cwd, target, { allowEqual: true })) return cwd;
  const webRoot = WEB_SOURCE.test(target) ? findWebProjectRoot(target) : undefined;
  return webRoot ?? findOutermostBuildRoot(target) ?? findSourceModuleRoot(target) ?? startingDirectory(target);
}
