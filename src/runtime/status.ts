import type { SpikeConfig, SpikeRuntimeState, SpikeStatus } from "./types.js";

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
