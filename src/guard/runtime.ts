import { resolve } from "node:path";
import type { ConventionSnapshot, ObserveConfig } from "../observe/types.js";

interface InjectedSnapshotRecord {
  createdAt: number;
  injectedAt: number;
  turnIndex: number;
}

export class GuardRuntime {
  private readonly injectedByTarget = new Map<string, InjectedSnapshotRecord>();
  private readonly oneTimeBypass = new Set<string>();

  markInjected(snapshots: readonly ConventionSnapshot[], turnIndex: number, now = Date.now()): void {
    for (const snapshot of snapshots) {
      this.injectedByTarget.set(resolve(snapshot.targetPath), {
        createdAt: snapshot.createdAt,
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
    const record = this.injectedByTarget.get(resolve(snapshot.targetPath));
    if (!record || record.createdAt !== snapshot.createdAt) return false;
    if (turnIndex - record.turnIndex > config.guard.contextWindowTurns) return false;
    return now - record.injectedAt <= config.guard.contextMaxAgeMs;
  }

  grantBypass(targetPath: string): boolean {
    const key = resolve(targetPath);
    const existed = this.oneTimeBypass.has(key);
    this.oneTimeBypass.add(key);
    return !existed;
  }

  hasBypass(targetPath: string): boolean {
    return this.oneTimeBypass.has(resolve(targetPath));
  }

  consumeBypass(targetPath: string): boolean {
    return this.oneTimeBypass.delete(resolve(targetPath));
  }

  clear(): void {
    this.injectedByTarget.clear();
    this.oneTimeBypass.clear();
  }
}
