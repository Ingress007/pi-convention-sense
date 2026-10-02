// Freshness rules and bookkeeping of the Snapshot cache, exercised against real files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { checkSnapshotFreshness, SnapshotCache } from "../src/observe/snapshot-cache.js";
import { ANALYZER_VERSION, type ConventionSnapshot } from "../src/observe/types.js";
import { isCaseInsensitivePlatform } from "../src/runtime/path-key.js";

const root = mkdtempSync(join(tmpdir(), "pi-convention-snapshot-cache-"));
after(() => rmSync(root, { recursive: true, force: true }));

const OLD = new Date("2026-01-01T00:00:00Z");

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Writes a file whose mtime is far in the past, so it is not racy-clean unless the test wants it to be. */
function oldFile(name: string, text: string, mtime = OLD): string {
  const path = join(root, name);
  writeFileSync(path, text);
  utimesSync(path, mtime, mtime);
  return path;
}

function snapshotFor(target: string, evidence: string[], createdAt = Date.now()): ConventionSnapshot {
  const stat = statSync(target);
  const targetText = readFileSync(target, "utf8");
  return {
    scope: { language: "java", module: "m", role: "service-impl", root, confidence: "high" } as ConventionSnapshot["scope"],
    repositoryRoot: root,
    targetPath: target,
    targetKind: "existing",
    targetMtimeMs: stat.mtimeMs,
    targetSize: stat.size,
    targetHash: sha(targetText),
    observations: [],
    evidenceFiles: evidence.map((path) => ({
      path,
      mtimeMs: statSync(path).mtimeMs,
      size: statSync(path).size,
      contentHash: sha(readFileSync(path, "utf8")),
      score: 1,
    })),
    candidates: [],
    createdAt,
    status: "valid",
    tokenEstimate: 10,
    analyzerVersion: ANALYZER_VERSION,
    configFingerprint: "fp",
  };
}

test("an untouched Snapshot is fresh", () => {
  const target = oldFile("A.java", "class A {}");
  const peer = oldFile("B.java", "class B {}");
  assert.deepEqual(checkSnapshotFreshness(snapshotFor(target, [peer]), "fp"), { fresh: true });
});

test("each way a Snapshot goes stale has its own reason", () => {
  const target = oldFile("T1.java", "class T {}");
  const peer = oldFile("P1.java", "class P {}");
  const base = snapshotFor(target, [peer]);

  assert.deepEqual(checkSnapshotFreshness({ ...base, analyzerVersion: "older" }, "fp"), { fresh: false, reason: "analyzer-version-changed" });
  assert.deepEqual(checkSnapshotFreshness(base, "other-config"), { fresh: false, reason: "config-changed" });

  // The analyzer version is checked before the configuration fingerprint.
  assert.equal(checkSnapshotFreshness({ ...base, analyzerVersion: "older" }, "other-config").reason, "analyzer-version-changed");

  writeFileSync(target, "class T { int changed; }");
  assert.deepEqual(checkSnapshotFreshness(base, "fp"), { fresh: false, reason: "target-changed" });
  rmSync(target);
  assert.deepEqual(checkSnapshotFreshness(base, "fp"), { fresh: false, reason: "target-missing" });
});

test("a changed or removed evidence file names itself in the reason", () => {
  const target = oldFile("T2.java", "class T {}");
  const peer = oldFile("P2.java", "class P {}");
  const base = snapshotFor(target, [peer]);

  writeFileSync(peer, "class P { int more; }");
  assert.deepEqual(checkSnapshotFreshness(base, "fp"), { fresh: false, reason: `evidence-changed:${peer}` });
  rmSync(peer);
  assert.deepEqual(checkSnapshotFreshness(base, "fp"), { fresh: false, reason: `evidence-missing:${peer}` });
});

test("a prospective target goes stale once the file exists", () => {
  const path = join(root, "NotYet.java");
  const prospective: ConventionSnapshot = {
    ...snapshotFor(oldFile("Anchor.java", "class Anchor {}"), []),
    targetPath: path,
    targetKind: "prospective",
    targetMtimeMs: 0,
    targetSize: 0,
    targetHash: "prospective",
  };
  assert.deepEqual(checkSnapshotFreshness(prospective, "fp"), { fresh: true });
  writeFileSync(path, "class NotYet {}");
  assert.deepEqual(checkSnapshotFreshness(prospective, "fp"), { fresh: false, reason: "prospective-target-created" });
});

test("a same-size rewrite inside the racy window is caught by content, an old file is trusted by metadata", () => {
  // Racy: mtime is within 5 s of the snapshot, so only the content hash can prove the file is unchanged.
  const racyTarget = join(root, "Racy.java");
  writeFileSync(racyTarget, "class R { int a; }");
  const racy = snapshotFor(racyTarget, []);
  const { mtimeMs } = statSync(racyTarget);
  writeFileSync(racyTarget, "class R { int b; }"); // same length
  utimesSync(racyTarget, new Date(mtimeMs), new Date(mtimeMs)); // same mtime
  assert.equal(statSync(racyTarget).size, racy.targetSize);
  assert.deepEqual(checkSnapshotFreshness(racy, "fp"), { fresh: false, reason: "target-changed" });

  // Not racy: the snapshot was taken long after the last write, so identical size and mtime mean unchanged,
  // and the (deliberately wrong) stored hash proves the content was never read.
  const calmTarget = oldFile("Calm.java", "class C { int a; }");
  const calm = { ...snapshotFor(calmTarget, [], Date.now()), targetHash: "never-compared" };
  assert.deepEqual(checkSnapshotFreshness(calm, "fp"), { fresh: true });
});

test("a future mtime is never trusted", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const target = oldFile("Future.java", "class F { int a; }", future);
  const snapshot = { ...snapshotFor(target, []), targetHash: "mismatch" };
  assert.deepEqual(checkSnapshotFreshness(snapshot, "fp"), { fresh: false, reason: "target-changed" });
});

test("getFresh marks a stale Snapshot with its reason and keeps it listed", () => {
  const cache = new SnapshotCache();
  const target = oldFile("Cached.java", "class Cached {}");
  const snapshot = snapshotFor(target, []);
  assert.equal(cache.getFresh(target, "fp"), undefined, "nothing cached yet");
  cache.set(snapshot);
  assert.equal(cache.getFresh(target, "fp"), snapshot);
  assert.equal(cache.getFresh(target, "other-config"), undefined);
  assert.equal(cache.get(target)?.status, "stale");
  assert.equal(cache.get(target)?.staleReason, "config-changed");
  assert.equal(cache.getFresh(target, "fp"), undefined, "a stale Snapshot stays stale even when asked with the old config");
});

test("list orders newest first and listFresh drops stale entries", () => {
  const cache = new SnapshotCache();
  const first = oldFile("L1.java", "class L1 {}");
  const second = oldFile("L2.java", "class L2 {}");
  const third = oldFile("L3.java", "class L3 {}");
  cache.set(snapshotFor(first, [], 100));
  cache.set(snapshotFor(second, [], 300));
  cache.set(snapshotFor(third, [], 200));
  assert.deepEqual(cache.list().map((item) => item.targetPath), [second, third, first]);

  writeFileSync(third, "class L3 { int changed; }");
  assert.deepEqual(cache.listFresh("fp").map((item) => item.targetPath), [second, first]);
  assert.equal(cache.list().find((item) => item.targetPath === third)?.status, "stale");
});

test("invalidatePath stales snapshots by target and by evidence and reports how many", () => {
  const cache = new SnapshotCache();
  const shared = oldFile("Shared.java", "class Shared {}");
  const a = oldFile("InvA.java", "class A {}");
  const b = oldFile("InvB.java", "class B {}");
  const c = oldFile("InvC.java", "class C {}");
  cache.set(snapshotFor(a, [shared]));
  cache.set(snapshotFor(b, [shared]));
  cache.set(snapshotFor(c, []));

  assert.equal(cache.invalidatePath(join(root, "Unrelated.java")), 0);
  assert.equal(cache.invalidatePath(shared), 2, "both snapshots cite the shared evidence file");
  assert.equal(cache.get(a)?.staleReason, "path-mutated");
  assert.equal(cache.get(c)?.status, "valid");
  assert.equal(cache.invalidatePath(c, "custom-reason"), 1);
  assert.equal(cache.get(c)?.staleReason, "custom-reason");
  assert.equal(cache.getFresh(c, "fp"), undefined, "an invalidated Snapshot is never served as fresh again");

  if (isCaseInsensitivePlatform()) {
    assert.equal(cache.invalidatePath(shared.toUpperCase()), 2, "path comparison ignores case on this platform");
  }
});
