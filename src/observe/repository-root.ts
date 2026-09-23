import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const BUILD_MARKERS = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

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
  if (isInside(cwd, target)) return cwd;
  return findOutermostBuildRoot(target) ?? findSourceModuleRoot(target) ?? startingDirectory(target);
}
