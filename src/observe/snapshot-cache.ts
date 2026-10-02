import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { pathKey } from "../runtime/path-key.js";
import { isRacyClean } from "../runtime/racy-clean.js";
import { ANALYZER_VERSION, type ConventionSnapshot } from "./types.js";

export interface FreshnessResult {
  fresh: boolean;
  reason?: string;
}

function contentHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Freshness runs for every active Snapshot on every model request: an unchanged file must not be
// re-read and hashed, so only racy-clean files (see isRacyClean) pay for a content hash.

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined; // Deleted or unreadable between the check and now: treat it as changed.
  }
}

function unchangedSince(
  path: string,
  stat: Stats,
  expected: { mtimeMs: number; size: number; contentHash: string },
  capturedAt: number,
): boolean {
  if (stat.mtimeMs !== expected.mtimeMs || stat.size !== expected.size) return false;
  if (!isRacyClean(expected.mtimeMs, capturedAt)) return true;
  try {
    return contentHash(path) === expected.contentHash;
  } catch {
    return false;
  }
}

export function checkSnapshotFreshness(
  snapshot: ConventionSnapshot,
  expectedConfigFingerprint: string,
): FreshnessResult {
  if (snapshot.analyzerVersion !== ANALYZER_VERSION) {
    return { fresh: false, reason: "analyzer-version-changed" };
  }
  if (snapshot.configFingerprint !== expectedConfigFingerprint) {
    return { fresh: false, reason: "config-changed" };
  }
  if (snapshot.targetKind === "prospective") {
    if (existsSync(snapshot.targetPath)) return { fresh: false, reason: "prospective-target-created" };
  } else {
    const targetStat = statOrUndefined(snapshot.targetPath);
    if (!targetStat) return { fresh: false, reason: "target-missing" };
    const expected = { mtimeMs: snapshot.targetMtimeMs, size: snapshot.targetSize, contentHash: snapshot.targetHash };
    if (!unchangedSince(snapshot.targetPath, targetStat, expected, snapshot.createdAt)) {
      return { fresh: false, reason: "target-changed" };
    }
  }

  for (const evidence of snapshot.evidenceFiles) {
    const stat = statOrUndefined(evidence.path);
    if (!stat) return { fresh: false, reason: `evidence-missing:${evidence.path}` };
    if (!unchangedSince(evidence.path, stat, evidence, snapshot.createdAt)) {
      return { fresh: false, reason: `evidence-changed:${evidence.path}` };
    }
  }
  return { fresh: true };
}

export class SnapshotCache {
  private readonly byTarget = new Map<string, ConventionSnapshot>();

  set(snapshot: ConventionSnapshot): void {
    this.byTarget.set(pathKey(snapshot.targetPath), snapshot);
  }

  get(targetPath: string): ConventionSnapshot | undefined {
    return this.byTarget.get(pathKey(targetPath));
  }

  getFresh(targetPath: string, configFingerprint: string): ConventionSnapshot | undefined {
    const key = pathKey(targetPath);
    const snapshot = this.byTarget.get(key);
    // Stale is sticky until the target is analyzed again: a marked Snapshot must not come back as "fresh" just
    // because the files happen to match again (a no-op rewrite, or a config fingerprint that flipped back).
    if (!snapshot || snapshot.status === "stale") return undefined;
    const freshness = checkSnapshotFreshness(snapshot, configFingerprint);
    if (freshness.fresh) return snapshot;
    this.byTarget.set(key, {
      ...snapshot,
      status: "stale",
      ...(freshness.reason ? { staleReason: freshness.reason } : {}),
    });
    return undefined;
  }

  list(): ConventionSnapshot[] {
    return [...this.byTarget.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  listFresh(configFingerprint: string): ConventionSnapshot[] {
    const fresh: ConventionSnapshot[] = [];
    for (const snapshot of this.list()) {
      const value = this.getFresh(snapshot.targetPath, configFingerprint);
      if (value) fresh.push(value);
    }
    return fresh;
  }

  invalidatePath(path: string, reason = "path-mutated"): number {
    const absolute = pathKey(path);
    let count = 0;
    for (const [target, snapshot] of this.byTarget) {
      if (
        pathKey(snapshot.targetPath) === absolute ||
        snapshot.evidenceFiles.some((evidence) => pathKey(evidence.path) === absolute)
      ) {
        this.byTarget.set(target, { ...snapshot, status: "stale", staleReason: reason });
        count += 1;
      }
    }
    return count;
  }

  delete(targetPath: string): void {
    this.byTarget.delete(pathKey(targetPath));
  }

  clear(): void {
    this.byTarget.clear();
  }
}
