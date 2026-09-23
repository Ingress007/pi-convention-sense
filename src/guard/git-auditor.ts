import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_HASH_BYTES = 5 * 1024 * 1024;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

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

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; error?: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT,
  });
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

function parsePorcelain(cwd: string, output: string): Map<string, GitPathState> {
  const segments = output.split("\0");
  const files = new Map<string, GitPathState>();
  for (let index = 0; index < segments.length; index += 1) {
    const entry = segments[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = safeRelativePath(cwd, entry.slice(3));
    if (path) files.set(path, { status, fingerprint: fileFingerprint(cwd, path) });
    if (status.includes("R") || status.includes("C")) {
      const source = segments[index + 1];
      if (source) {
        const sourcePath = safeRelativePath(cwd, source);
        if (sourcePath) {
          files.set(sourcePath, { status: `${status}:source`, fingerprint: fileFingerprint(cwd, sourcePath) });
        }
        index += 1;
      }
    }
  }
  return files;
}

export function captureGitWorktreeState(cwd: string, maxFiles: number): GitWorktreeState {
  const capturedAt = Date.now();
  const status = runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) {
    return {
      available: false,
      capturedAt,
      files: new Map(),
      truncated: false,
      ...(status.error ? { reason: status.error } : {}),
    };
  }

  const parsed = parsePorcelain(cwd, status.stdout);
  const sorted = [...parsed.entries()].sort(([a], [b]) => a.localeCompare(b));
  const truncated = sorted.length > maxFiles;
  const files = new Map(sorted.slice(0, maxFiles));
  const headResult = runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const head = headResult.ok ? headResult.stdout.trim() : undefined;
  return {
    available: true,
    capturedAt,
    ...(head ? { head } : {}),
    files,
    truncated,
  };
}

function changedBetweenHeads(cwd: string, before: string, after: string): string[] {
  const result = runGit(cwd, ["diff", "--name-only", "-z", before, after, "--"]);
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
