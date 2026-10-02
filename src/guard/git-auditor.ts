import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_HASH_BYTES = 5 * 1024 * 1024;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
// These calls run synchronously on Pi's event loop before and after a shell command, so a huge or
// stuck repository must degrade to "audit unavailable" instead of freezing the TUI. The budget is one
// shared deadline per capture (the audit is fail-open anyway), not a timeout per git call.
export const DEFAULT_GIT_TIMEOUT_MS = 3_000;

interface GitPathState {
  status: string;
  fingerprint: string;
}

export interface GitWorktreeState {
  available: boolean;
  capturedAt: number;
  head?: string;
  files: Map<string, GitPathState>;
  truncated: boolean;
  reason?: string;
}

export interface GitStateDiff {
  available: boolean;
  changedPaths: string[];
  headChanged: boolean;
  truncated: boolean;
  reason?: string;
}

export interface GitCaptureOptions {
  timeoutMs?: number;
  now?: () => number;
}

/**
 * `--no-optional-locks` keeps a background `git status` from taking `index.lock` to refresh the
 * index, which would make a concurrent git command by the user, an IDE or the Agent fail.
 */
export function gitArguments(args: readonly string[]): string[] {
  return ["--no-optional-locks", ...args];
}

function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
): { ok: boolean; stdout: string; error?: string } {
  const result = spawnSync("git", gitArguments(args), {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: timeoutMs,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    return { ok: false, stdout: "", error: `git timed out after ${timeoutMs}ms` };
  }
  if (result.status !== 0) {
    const error = typeof result.stderr === "string" ? result.stderr.trim() : "";
    return { ok: false, stdout: "", error: error || `git exited with status ${result.status ?? "unknown"}` };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

function safeRelativePath(cwd: string, value: string): string | undefined {
  const absolute = resolve(cwd, value);
  const rel = relative(cwd, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.replaceAll("\\", "/");
}

function fileFingerprint(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) return "missing";
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile()) return `${stat.mode}:${stat.size}:${stat.mtimeMs}`;
    if (stat.size > MAX_HASH_BYTES) return `large:${stat.size}:${stat.mtimeMs}`;
    return createHash("sha256").update(readFileSync(absolute)).digest("hex");
  } catch (error) {
    return `unreadable:${error instanceof Error ? error.name : "unknown"}`;
  }
}

/**
 * Parse `git status --porcelain=v1 -z`. Entries are sorted and cut to `maxFiles` BEFORE any file is
 * fingerprinted: hashing every dirty file of a worktree with thousands of untracked files (a build
 * directory that is not ignored, for example) before truncating would cost far more than the audit.
 */
export function parsePorcelain(
  cwd: string,
  output: string,
  options: { maxFiles: number; fingerprint?: (cwd: string, path: string) => string },
): { files: Map<string, GitPathState>; truncated: boolean } {
  const fingerprint = options.fingerprint ?? fileFingerprint;
  const segments = output.split("\0");
  const entries: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < segments.length; index += 1) {
    const entry = segments[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = safeRelativePath(cwd, entry.slice(3));
    if (path) entries.push({ path, status });
    if (status.includes("R") || status.includes("C")) {
      const source = segments[index + 1];
      if (source) {
        const sourcePath = safeRelativePath(cwd, source);
        if (sourcePath) entries.push({ path: sourcePath, status: `${status}:source` });
        index += 1;
      }
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const files = new Map<string, GitPathState>();
  for (const entry of entries.slice(0, options.maxFiles)) {
    files.set(entry.path, { status: entry.status, fingerprint: fingerprint(cwd, entry.path) });
  }
  return { files, truncated: entries.length > options.maxFiles };
}

export function captureGitWorktreeState(
  cwd: string,
  maxFiles: number,
  options: GitCaptureOptions = {},
): GitWorktreeState {
  const capturedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const status = runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], timeoutMs);
  if (!status.ok) {
    return {
      available: false,
      capturedAt,
      files: new Map(),
      truncated: false,
      ...(status.error ? { reason: status.error } : {}),
    };
  }

  const { files, truncated } = parsePorcelain(cwd, status.stdout, { maxFiles });
  const remainingMs = deadline - now();
  const headResult = remainingMs > 0 ? runGit(cwd, ["rev-parse", "--verify", "HEAD"], remainingMs) : undefined;
  const head = headResult?.ok ? headResult.stdout.trim() : undefined;
  return {
    available: true,
    capturedAt,
    ...(head ? { head } : {}),
    files,
    truncated,
  };
}

function changedBetweenHeads(cwd: string, before: string, after: string): string[] {
  const result = runGit(cwd, ["diff", "--name-only", "-z", before, after, "--"], DEFAULT_GIT_TIMEOUT_MS);
  if (!result.ok) return [];
  return result.stdout
    .split("\0")
    .map((path) => safeRelativePath(cwd, path))
    .filter((path): path is string => Boolean(path));
}

export function diffGitWorktreeStates(
  cwd: string,
  before: GitWorktreeState,
  after: GitWorktreeState,
  maxFiles: number,
): GitStateDiff {
  if (!before.available || !after.available) {
    return {
      available: false,
      changedPaths: [],
      headChanged: false,
      truncated: before.truncated || after.truncated,
      reason: before.reason ?? after.reason ?? "Git state unavailable",
    };
  }

  const changed = new Set<string>();
  for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
    const left = before.files.get(path);
    const right = after.files.get(path);
    if (!left || !right || left.status !== right.status || left.fingerprint !== right.fingerprint) {
      changed.add(path);
    }
  }

  const headChanged = Boolean(before.head && after.head && before.head !== after.head);
  if (headChanged && before.head && after.head) {
    for (const path of changedBetweenHeads(cwd, before.head, after.head)) changed.add(path);
  }

  const sorted = [...changed].sort();
  const truncated = before.truncated || after.truncated || sorted.length > maxFiles;
  return {
    available: true,
    changedPaths: sorted.slice(0, maxFiles),
    headChanged,
    truncated,
  };
}
