import type { ObserveConfig } from "../observe/types.js";

export const SPIKE_STATE_ENTRY_TYPE = "pi-convention-sense-spike-state";
export const SPIKE_CONTEXT_TYPE = "pi-convention-sense-context";
export const SPIKE_STATE_VERSION = 3;

export type SpikeMode = "observe" | "guard";
export type LogLevel = "silent" | "info" | "debug";
export type GuardAction = "allow" | "wouldBlock" | "block";
export type SpikeConfig = ObserveConfig;

export interface LoadedSpikeConfig {
  config: SpikeConfig;
  configPath: string;
  diagnostics: string[];
  usedProjectConfig: boolean;
}

export interface MutationRecord {
  path: string;
  toolName: "edit" | "write";
  completedAt: number;
}

export interface GuardCounters {
  allow: number;
  wouldBlock: number;
  block: number;
}

export interface ReadRecord {
  path: string;
  completedAt: number;
}

export interface LegacySpikeCheckpoint {
  version: 1;
  successfulReads: string[];
  mutations: MutationRecord[];
  shellRiskCount: number;
  guardCounters: GuardCounters;
}

export interface ObserveCheckpoint {
  version: 2;
  successfulReads: string[];
  recentReads: ReadRecord[];
  mutations: MutationRecord[];
  shellRiskCount: number;
  guardCounters: GuardCounters;
}

export interface SpikeCheckpoint {
  version: 3;
  successfulReads: string[];
  recentReads: ReadRecord[];
  mutations: MutationRecord[];
  shellRiskCount: number;
  guardCounters: GuardCounters;
  bypassCount: number;
  postChangeAuditCount: number;
  postChangeGapCount: number;
}

export interface PendingRead {
  path: string;
  startedAt: number;
}

export interface SpikeRuntimeState {
  successfulReads: Set<string>;
  recentReads: ReadRecord[];
  pendingReads: Map<string, PendingRead>;
  mutations: MutationRecord[];
  shellRiskCount: number;
  guardCounters: GuardCounters;
  turnIndex: number;
  contextInjectionCount: number;
  bypassCount: number;
  postChangeAuditCount: number;
  postChangeGapCount: number;
  restoredFromCheckpoint: boolean;
}

export interface GuardDecision {
  action: GuardAction;
  reasonCode: "TARGET_ALREADY_READ" | "TARGET_NOT_READ" | "NEW_FILE_BYPASS" | "EXTENSION_DISABLED";
  message: string;
  targetPath: string;
  targetExists: boolean;
}

export interface ToolResultLike {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
}

export interface ToolStartLike {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface StateChange {
  checkpointChanged: boolean;
  successfulReadPath?: string;
  mutation?: MutationRecord;
  shellRiskTags?: string[];
}

export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

export interface SpikeStatus {
  enabled: boolean;
  mode: SpikeMode;
  sessionId?: string;
  sessionFile?: string;
  successfulReadCount: number;
  pendingReadCount: number;
  mutationCount: number;
  shellRiskCount: number;
  guardCounters: GuardCounters;
  contextInjectionCount: number;
  bypassCount: number;
  postChangeAuditCount: number;
  postChangeGapCount: number;
  restoredFromCheckpoint: boolean;
  snapshotCount: number;
  validSnapshotCount: number;
  weakSnapshotCount: number;
  staleSnapshotCount: number;
  logPath: string;
  loggerError?: string;
  configDiagnostics: string[];
}
