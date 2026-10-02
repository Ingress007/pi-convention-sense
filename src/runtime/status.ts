import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpikeConfig, SpikeRuntimeState, SpikeStatus } from "./types.js";

/**
 * A package.json alone proves nothing: Java projects often keep one for husky or commitlint. A web
 * project also has a tsconfig.json or depends on TypeScript or Vue.
 */
export function looksLikeWebProject(directory: string): boolean {
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) return false;
  if (existsSync(join(directory, "tsconfig.json"))) return true;
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest !== "object" || manifest === null) return false;
    return ["dependencies", "devDependencies", "peerDependencies"].some((key) => {
      const group = (manifest as Record<string, unknown>)[key];
      if (typeof group !== "object" || group === null) return false;
      return Object.keys(group).some((name) => name === "vue" || name === "typescript" || name.startsWith("@vue/"));
    });
  } catch {
    return false;
  }
}


export interface StatusInput {
  config: SpikeConfig;
  state: SpikeRuntimeState;
  logPath: string;
  configDiagnostics: string[];
  snapshotCount?: number;
  validSnapshotCount?: number;
  weakSnapshotCount?: number;
  staleSnapshotCount?: number;
  sessionId?: string;
  sessionFile?: string;
  loggerError?: string;
}

export function buildStatus(input: StatusInput): SpikeStatus {
  const status: SpikeStatus = {
    enabled: input.config.enabled,
    mode: input.config.mode,
    successfulReadCount: input.state.successfulReads.size,
    pendingReadCount: input.state.pendingReads.size,
    mutationCount: input.state.mutations.length,
    shellRiskCount: input.state.shellRiskCount,
    guardCounters: { ...input.state.guardCounters },
    contextInjectionCount: input.state.contextInjectionCount,
    bypassCount: input.state.bypassCount,
    postChangeAuditCount: input.state.postChangeAuditCount,
    postChangeGapCount: input.state.postChangeGapCount,
    restoredFromCheckpoint: input.state.restoredFromCheckpoint,
    snapshotCount: input.snapshotCount ?? 0,
    validSnapshotCount: input.validSnapshotCount ?? 0,
    weakSnapshotCount: input.weakSnapshotCount ?? 0,
    staleSnapshotCount: input.staleSnapshotCount ?? 0,
    logPath: input.logPath,
    configDiagnostics: [...input.configDiagnostics],
  };
  if (input.sessionId !== undefined) status.sessionId = input.sessionId;
  if (input.sessionFile !== undefined) status.sessionFile = input.sessionFile;
  if (input.loggerError !== undefined) status.loggerError = input.loggerError;
  return status;
}

export function formatStatus(status: SpikeStatus): string {
  return [
    `pi-convention-sense V1 Guard (${status.mode}${status.enabled ? "" : ", disabled"})`,
    `reads=${status.successfulReadCount}, pending=${status.pendingReadCount}, mutations=${status.mutationCount}`,
    `guard allow/wouldBlock/block=${status.guardCounters.allow}/${status.guardCounters.wouldBlock}/${status.guardCounters.block}`,
    `shell-risk=${status.shellRiskCount}, context-injections=${status.contextInjectionCount}, bypass=${status.bypassCount}`,
    `post-change audits/gaps=${status.postChangeAuditCount}/${status.postChangeGapCount}`,
    `snapshots total/valid/weak/stale=${status.snapshotCount}/${status.validSnapshotCount}/${status.weakSnapshotCount}/${status.staleSnapshotCount}`,
    `state=${status.restoredFromCheckpoint ? "restored" : "fresh"}`,
    `log=${status.logPath}`,
    ...(status.loggerError ? [`logger-error=${status.loggerError}`] : []),
    ...(status.configDiagnostics.length > 0 ? [`config=${status.configDiagnostics.join("; ")}`] : []),
  ].join("\n");
}
