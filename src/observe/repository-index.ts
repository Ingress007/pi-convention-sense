import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { globMatches } from "../runtime/glob.js";
import { isPathInside } from "../runtime/paths.js";
import { pathKey } from "../runtime/path-key.js";

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
      globMatches(rel, pattern, { dot: true }) ||
      globMatches(`${rel}/`, pattern, { dot: true }) ||
      globMatches(`${rel}/placeholder`, pattern, { dot: true }),
  );
}

const DEFAULT_MAX_INDEXED_FILES = 20_000;

function buildSourceFileIndex(
  repositoryRoot: string,
  exclude: readonly string[],
  extensions: readonly string[],
  maxFiles: number,
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
  maxFiles = DEFAULT_MAX_INDEXED_FILES,
): RepositoryIndexResult {
  return buildSourceFileIndex(repositoryRoot, exclude, [".java"], maxFiles);
}

// Files can change behind our back (git checkout, pull, stash, code generation) without any tool call
// telling us, so an index is also rescanned when it gets old or the checked-out commit changes.
const DEFAULT_MAX_INDEX_AGE_MS = 3 * 60 * 1000;

function gitHeadStamp(root: string): string {
  try {
    return String(statSync(join(root, ".git", "HEAD")).mtimeMs);
  } catch {
    return ""; // not a plain git checkout (a worktree has a .git file): rely on the age limit
  }
}

/** Would the repository walk have listed this path? Symlinks and directories are never indexed. */
function isIndexableFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

interface CachedIndex {
  result: RepositoryIndexResult;
  root: string;
  builtAt: number;
  headStamp: string;
  exclude: readonly string[];
  extensions: readonly string[];
  /** Lazily built: identity keys of the indexed files, for cheap membership checks. */
  keys?: Set<string>;
}

export class RepositoryIndexCache {
  private readonly values = new Map<string, CachedIndex>();
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private builds = 0;

  constructor(options: { maxFiles?: number; maxAgeMs?: number; now?: () => number } = {}) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_INDEXED_FILES;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_INDEX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  /** How many full repository scans have run (diagnostics and tests). */
  get buildCount(): number {
    return this.builds;
  }

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
    if (value && this.now() - value.builtAt > this.maxAgeMs) value = undefined;
    if (value && gitHeadStamp(value.root) !== value.headStamp) value = undefined;
    if (!value) {
      this.builds += 1;
      const root = resolve(repositoryRoot);
      const builtAt = this.now();
      value = {
        result: buildSourceFileIndex(repositoryRoot, exclude, extensions, this.maxFiles),
        root,
        builtAt,
        headStamp: gitHeadStamp(root),
        exclude,
        extensions: extensions.map((extension) => extension.toLowerCase()),
      };
      this.values.set(fingerprint, value);
    }
    return value.result;
  }

  /**
   * The index only lists file paths, so editing an existing file never changes it. Drop an index only
   * when a file it would list was created or deleted. A truncated index is incomplete by construction
   * and cannot answer that question, so it is kept rather than rescanned on every change.
   */
  noteFileChanged(path: string): void {
    const absolute = resolve(path);
    const lower = absolute.toLowerCase();
    for (const [key, cached] of this.values) {
      if (cached.result.truncated) continue;
      if (!isPathInside(cached.root, absolute)) continue;
      if (!cached.extensions.some((extension) => lower.endsWith(extension))) continue;
      if (matchesExcludedPath(cached.root, absolute, cached.exclude)) continue;
      cached.keys ??= new Set(cached.result.files.map((file) => pathKey(file)));
      if (isIndexableFile(absolute) !== cached.keys.has(pathKey(absolute))) this.values.delete(key);
    }
  }

  invalidate(): void {
    this.values.clear();
  }
}
