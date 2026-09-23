import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ANALYZER_VERSION, type ConventionSnapshot } from "./types.js";

export interface FreshnessResult {
  fresh: boolean;
  reason?: string;
}

function contentHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    if (!existsSync(snapshot.targetPath)) return { fresh: false, reason: "target-missing" };
    const targetStat = statSync(snapshot.targetPath);
    if (
      targetStat.mtimeMs !== snapshot.targetMtimeMs ||
      targetStat.size !== snapshot.targetSize ||
      contentHash(snapshot.targetPath) !== snapshot.targetHash
    ) {
      return { fresh: false, reason: "target-changed" };
    }
  }

  for (const evidence of snapshot.evidenceFiles) {
    if (!existsSync(evidence.path)) return { fresh: false, reason: `evidence-missing:${evidence.path}` };
    const stat = statSync(evidence.path);
    if (
      stat.mtimeMs !== evidence.mtimeMs ||
      stat.size !== evidence.size ||
      contentHash(evidence.path) !== evidence.contentHash
    ) {
      return { fresh: false, reason: `evidence-changed:${evidence.path}` };
    }
  }
  return { fresh: true };
}

export class SnapshotCache {
  private readonly byTarget = new Map<string, ConventionSnapshot>();

  set(snapshot: ConventionSnapshot): void {
    this.byTarget.set(resolve(snapshot.targetPath), snapshot);
  }

  get(targetPath: string): ConventionSnapshot | undefined {
    return this.byTarget.get(resolve(targetPath));
  }

  getFresh(targetPath: string, configFingerprint: string): ConventionSnapshot | undefined {
    const key = resolve(targetPath);
    const snapshot = this.byTarget.get(key);
    if (!snapshot) return undefined;
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
    const absolute = resolve(path);
    let count = 0;
    for (const [target, snapshot] of this.byTarget) {
      if (
        resolve(snapshot.targetPath) === absolute ||
        snapshot.evidenceFiles.some((evidence) => resolve(evidence.path) === absolute)
      ) {
        this.byTarget.set(target, { ...snapshot, status: "stale", staleReason: reason });
        count += 1;
      }
    }
    return count;
  }

  delete(targetPath: string): void {
    this.byTarget.delete(resolve(targetPath));
  }

  clear(): void {
    this.byTarget.clear();
  }
}
