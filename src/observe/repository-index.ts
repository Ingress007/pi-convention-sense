import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { minimatch } from "minimatch";

export interface RepositoryIndexResult {
  files: string[];
  scannedAt: number;
  truncated: boolean;
}

function normalizedRelative(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

export function matchesExcludedPath(root: string, path: string, patterns: readonly string[]): boolean {
  const rel = normalizedRelative(root, path);
  return patterns.some(
    (pattern) =>
      minimatch(rel, pattern, { dot: true }) ||
      minimatch(`${rel}/`, pattern, { dot: true }) ||
      minimatch(`${rel}/placeholder`, pattern, { dot: true }),
  );
}

function buildSourceFileIndex(
  repositoryRoot: string,
  exclude: readonly string[],
  extensions: readonly string[],
  maxFiles = 20_000,
): RepositoryIndexResult {
  const root = resolve(repositoryRoot);
  const normalizedExtensions = extensions.map((extension) => extension.toLowerCase());
  const files: string[] = [];
  const stack = [root];
  let truncated = false;

  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      const absolute = resolve(directory, entry.name);
      if (matchesExcludedPath(root, absolute, exclude)) continue;
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) stack.push(absolute);
        continue;
      }
      if (
        !entry.isFile() ||
        !normalizedExtensions.some((extension) => entry.name.toLowerCase().endsWith(extension))
      ) continue;
      files.push(absolute);
      if (files.length >= maxFiles) {
        truncated = true;
        stack.length = 0;
        break;
      }
    }
  }

  files.sort();
  return { files, scannedAt: Date.now(), truncated };
}

export function buildJavaFileIndex(
  repositoryRoot: string,
  exclude: readonly string[],
  maxFiles = 20_000,
): RepositoryIndexResult {
  return buildSourceFileIndex(repositoryRoot, exclude, [".java"], maxFiles);
}

export class RepositoryIndexCache {
  private readonly values = new Map<string, RepositoryIndexResult>();

  get(
    repositoryRoot: string,
    exclude: readonly string[],
    extensions: readonly string[] = [".java"],
  ): RepositoryIndexResult {
    const fingerprint = [
      resolve(repositoryRoot),
      [...exclude].sort().join("\n"),
      [...extensions].map((extension) => extension.toLowerCase()).sort().join("\n"),
    ].join("\n---\n");
    let value = this.values.get(fingerprint);
    if (!value) {
      value = buildSourceFileIndex(repositoryRoot, exclude, extensions);
      this.values.set(fingerprint, value);
    }
    return value;
  }

  invalidate(): void {
    this.values.clear();
  }
}
