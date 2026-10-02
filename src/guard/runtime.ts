import { createHash } from "node:crypto";
import { scopeKey } from "../observe/scope-detector.js";
import type { ConventionSnapshot, ObserveConfig } from "../observe/types.js";
import { pathKey } from "../runtime/path-key.js";

/**
 * Identity of the evidence a Snapshot puts in front of the model: its scope, the peers (path and content) and the
 * observations, plus the configuration they were built under. It deliberately ignores the target's own content and
 * when the Snapshot object was built: editing the target rebuilds the Snapshot, but the model has still seen the same
 * evidence, so the next edit in the same turn must not wait for another Context injection.
 */
export function snapshotEvidenceKey(snapshot: ConventionSnapshot): string {
  const peers = snapshot.evidenceFiles.map((peer) => `${pathKey(peer.path)}:${peer.contentHash}`).sort();
  const observations = snapshot.observations
    .map((item) => [item.category, item.pattern, item.support, item.samples, item.confidence, item.status].join("|"))
    .sort();
  const identity = [snapshot.configFingerprint, scopeKey(snapshot.scope), snapshot.scope.confidence, snapshot.status, peers, observations];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

interface InjectedSnapshotRecord {
  evidenceKey: string;
  injectedAt: number;
  turnIndex: number;
}

export class GuardRuntime {
  private readonly injectedByTarget = new Map<string, InjectedSnapshotRecord>();
  private readonly oneTimeBypass = new Set<string>();

  markInjected(snapshots: readonly ConventionSnapshot[], turnIndex: number, now = Date.now()): void {
    for (const snapshot of snapshots) {
      this.injectedByTarget.set(pathKey(snapshot.targetPath), {
        evidenceKey: snapshotEvidenceKey(snapshot),
        injectedAt: now,
        turnIndex,
      });
    }
  }

  isRecentlyInjected(
    snapshot: ConventionSnapshot,
    config: ObserveConfig,
    turnIndex: number,
    now = Date.now(),
  ): boolean {
    if (!config.guard.requireRecentContext) return true;
    const record = this.injectedByTarget.get(pathKey(snapshot.targetPath));
    if (!record || record.evidenceKey !== snapshotEvidenceKey(snapshot)) return false;
    if (turnIndex - record.turnIndex > config.guard.contextWindowTurns) return false;
    return now - record.injectedAt <= config.guard.contextMaxAgeMs;
  }

  grantBypass(targetPath: string): boolean {
    const key = pathKey(targetPath);
    const existed = this.oneTimeBypass.has(key);
    this.oneTimeBypass.add(key);
    return !existed;
  }

  hasBypass(targetPath: string): boolean {
    return this.oneTimeBypass.has(pathKey(targetPath));
  }

  consumeBypass(targetPath: string): boolean {
    return this.oneTimeBypass.delete(pathKey(targetPath));
  }

  clear(): void {
    this.injectedByTarget.clear();
    this.oneTimeBypass.clear();
  }
}
