// What the post-change audit sees: real Git repositories, before/after captures and the diff between them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { captureGitWorktreeState, diffGitWorktreeStates, type GitWorktreeState } from "../src/guard/git-auditor.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}

function write(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
}

function repository(files: Record<string, string> = { "src/Kept.java": "class Kept {}\n", "src/Edited.java": "class Edited {}\n", "src/Removed.java": "class Removed {}\n" }): string {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-git-auditor-"));
  roots.push(root);
  git(root, "init", "-q");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  return root;
}

function changed(root: string, before: GitWorktreeState, maxFiles = 100) {
  return diffGitWorktreeStates(root, before, captureGitWorktreeState(root, maxFiles), maxFiles);
}

test("a directory that is not a Git repository makes the audit unavailable, not an error", () => {
  const plain = mkdtempSync(join(tmpdir(), "pi-convention-no-git-"));
  roots.push(plain);
  const state = captureGitWorktreeState(plain, 100);
  assert.equal(state.available, false);
  assert.ok(state.reason && state.reason.length > 0);
  assert.equal(state.files.size, 0);

  const diff = diffGitWorktreeStates(plain, state, state, 100);
  assert.equal(diff.available, false);
  assert.deepEqual(diff.changedPaths, []);
  assert.equal(diff.reason, state.reason);
});

test("an untouched worktree produces an empty diff", () => {
  const root = repository();
  const before = captureGitWorktreeState(root, 100);
  assert.equal(before.available, true);
  assert.match(before.head ?? "", /^[0-9a-f]{40}$/);
  const diff = changed(root, before);
  assert.equal(diff.available, true);
  assert.deepEqual(diff.changedPaths, []);
  assert.equal(diff.headChanged, false);
  assert.equal(diff.truncated, false);
});

test("modified, created and deleted files are all reported, untouched ones are not", () => {
  const root = repository();
  const before = captureGitWorktreeState(root, 100);
  write(root, "src/Edited.java", "class Edited { int more; }\n");
  write(root, "src/Created.java", "class Created {}\n");
  git(root, "rm", "-q", "-f", "src/Removed.java");
  assert.deepEqual(changed(root, before).changedPaths, ["src/Created.java", "src/Edited.java", "src/Removed.java"]);
});

test("a second edit to an already modified file is still a change", () => {
  const root = repository();
  write(root, "src/Edited.java", "class Edited { int one; }\n");
  const before = captureGitWorktreeState(root, 100);
  write(root, "src/Edited.java", "class Edited { int two; }\n");
  assert.deepEqual(changed(root, before).changedPaths, ["src/Edited.java"], "same status, different content");
});

test("a rename reports both the new path and the old one", () => {
  const root = repository();
  const before = captureGitWorktreeState(root, 100);
  git(root, "mv", "src/Kept.java", "src/Renamed.java");
  assert.deepEqual(changed(root, before).changedPaths, ["src/Kept.java", "src/Renamed.java"]);
});

test("a commit made by the shell command is followed through the HEAD range", () => {
  const root = repository();
  const before = captureGitWorktreeState(root, 100);
  write(root, "src/Edited.java", "class Edited { int committed; }\n");
  git(root, "commit", "-qam", "agent commit");
  const diff = changed(root, before);
  assert.equal(diff.headChanged, true);
  assert.deepEqual(diff.changedPaths, ["src/Edited.java"], "the worktree is clean again, so only the HEAD diff can find it");
});

test("the changed-file list and the truncated flag respect the cap", () => {
  const root = repository();
  const before = captureGitWorktreeState(root, 100);
  for (let index = 0; index < 8; index += 1) write(root, `gen/File${index}.java`, `class File${index} {}\n`);
  const diff = changed(root, before, 3);
  assert.equal(diff.changedPaths.length, 3);
  assert.equal(diff.truncated, true);
  assert.deepEqual(diff.changedPaths, ["gen/File0.java", "gen/File1.java", "gen/File2.java"], "a stable, sorted prefix");

  const wide = captureGitWorktreeState(root, 3);
  assert.equal(wide.truncated, true, "the capture itself reports that it saw only part of the worktree");
  assert.equal(wide.files.size, 3);
});

test("files that cannot be hashed still diff by metadata instead of failing the audit", () => {
  const root = repository();
  const before = captureGitWorktreeState(root, 100);
  // A directory where a tracked file used to be, and a file over the hashing limit.
  rmSync(join(root, "src", "Kept.java"));
  mkdirSync(join(root, "src", "Kept.java"));
  writeFileSync(join(root, "src", "Kept.java", "inner.txt"), "x");
  writeFileSync(join(root, "src", "Huge.bin"), Buffer.alloc(5 * 1024 * 1024 + 1, 1));
  const diff = changed(root, before);
  assert.ok(diff.changedPaths.includes("src/Huge.bin"));
  assert.ok(diff.changedPaths.some((path) => path.startsWith("src/Kept.java")));
});

test("one unavailable side makes the whole diff unavailable and carries the reason", () => {
  const root = repository();
  const good = captureGitWorktreeState(root, 100);
  const bad: GitWorktreeState = { available: false, capturedAt: 0, files: new Map(), truncated: true, reason: "git exploded" };
  for (const [left, right] of [[good, bad], [bad, good]] as const) {
    const diff = diffGitWorktreeStates(root, left, right, 100);
    assert.equal(diff.available, false);
    assert.equal(diff.reason, "git exploded");
    assert.equal(diff.truncated, true);
    assert.deepEqual(diff.changedPaths, []);
  }
  const unnamed: GitWorktreeState = { available: false, capturedAt: 0, files: new Map(), truncated: false };
  assert.equal(diffGitWorktreeStates(root, unnamed, good, 100).reason, "Git state unavailable");
});
