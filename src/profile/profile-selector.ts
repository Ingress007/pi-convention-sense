import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import type { ProfileSelector } from "./types.js";

export interface ProfileTargetDescriptor {
  repositoryRoot: string;
  targetPath: string;
  language: string;
  module: string;
  baseRole: string;
  annotations?: readonly string[];
  dependencies?: readonly string[];
}

function normalizedRelative(root: string, targetPath: string): string | undefined {
  const value = relative(resolve(root), resolve(targetPath));
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined;
  return value.split(sep).join("/");
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(value, pattern, { dot: true, nocase: false }));
}

function intersects(values: readonly string[], patterns: readonly string[]): boolean {
  return values.some((value) => matchesAny(value, patterns));
}

export function matchesProfileSelector(
  selector: ProfileSelector | undefined,
  descriptor: ProfileTargetDescriptor,
): boolean {
  if (!selector) return true;
  const path = normalizedRelative(descriptor.repositoryRoot, descriptor.targetPath);
  if (path === undefined) return false;

  if (selector.paths && selector.paths.length > 0 && !matchesAny(path, selector.paths)) return false;
  if (selector.excludePaths && matchesAny(path, selector.excludePaths)) return false;
  if (selector.languages && !matchesAny(descriptor.language, selector.languages)) return false;
  if (selector.modules && !matchesAny(descriptor.module, selector.modules)) return false;
  if (selector.baseRoles && !matchesAny(descriptor.baseRole, selector.baseRoles)) return false;
  if (selector.fileNames && !matchesAny(basename(path), selector.fileNames)) return false;
  if (selector.annotationsAny && !intersects(descriptor.annotations ?? [], selector.annotationsAny)) return false;
  if (selector.dependenciesAny && !intersects(descriptor.dependencies ?? [], selector.dependenciesAny)) return false;
  return true;
}

export function profileSelectorSpecificity(selector: ProfileSelector): number {
  return (
    (selector.paths?.length ?? 0) * 8 +
    (selector.excludePaths?.length ?? 0) * 2 +
    (selector.languages?.length ?? 0) +
    (selector.modules?.length ?? 0) * 4 +
    (selector.baseRoles?.length ?? 0) * 4 +
    (selector.fileNames?.length ?? 0) * 6 +
    (selector.annotationsAny?.length ?? 0) * 5 +
    (selector.dependenciesAny?.length ?? 0) * 3
  );
}
