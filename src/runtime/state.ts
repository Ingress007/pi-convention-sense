import type { ToolMappingConfig } from "../observe/types.js";
import { resolveToolMapping } from "../guard/tool-mapping.js";
import { classifyShellMutationRisk, normalizeToolPath } from "./paths.js";
import {
  SPIKE_STATE_ENTRY_TYPE,
  SPIKE_STATE_VERSION,
  type LegacySpikeCheckpoint,
  type MutationRecord,
  type ObserveCheckpoint,
  type ReadRecord,
  type SessionEntryLike,
  type SpikeCheckpoint,
  type SpikeRuntimeState,
  type StateChange,
  type ToolResultLike,
  type ToolStartLike,
} from "./types.js";

const MAX_MUTATIONS = 100;
const MAX_RECENT_READS = 100;

export function createSpikeState(): SpikeRuntimeState {
  return {
    successfulReads: new Set<string>(),
    recentReads: [],
    pendingReads: new Map(),
    mutations: [],
    shellRiskCount: 0,
    guardCounters: {
      allow: 0,
      wouldBlock: 0,
      block: 0,
    },
    turnIndex: 0,
    contextInjectionCount: 0,
    bypassCount: 0,
    postChangeAuditCount: 0,
    postChangeGapCount: 0,
    restoredFromCheckpoint: false,
  };
}

function isMutationRecord(value: unknown): value is MutationRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<MutationRecord>;
  return (
    typeof record.path === "string" &&
    (record.toolName === "edit" || record.toolName === "write") &&
    typeof record.completedAt === "number"
  );
}

function isReadRecord(value: unknown): value is ReadRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ReadRecord>;
  return typeof record.path === "string" && typeof record.completedAt === "number";
}

function hasCheckpointBase(value: unknown): value is LegacySpikeCheckpoint | ObserveCheckpoint | SpikeCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<LegacySpikeCheckpoint | ObserveCheckpoint | SpikeCheckpoint>;
  if (checkpoint.version !== 1 && checkpoint.version !== 2 && checkpoint.version !== SPIKE_STATE_VERSION) return false;
  if (!Array.isArray(checkpoint.successfulReads) || !checkpoint.successfulReads.every((item) => typeof item === "string")) {
    return false;
  }
  if (!Array.isArray(checkpoint.mutations) || !checkpoint.mutations.every(isMutationRecord)) return false;
  if (typeof checkpoint.shellRiskCount !== "number") return false;
  if (typeof checkpoint.guardCounters !== "object" || checkpoint.guardCounters === null) return false;
  const counters = checkpoint.guardCounters;
  return (
    typeof counters.allow === "number" &&
    typeof counters.wouldBlock === "number" &&
    typeof counters.block === "number"
  );
}

function isCheckpoint(value: unknown): value is LegacySpikeCheckpoint | ObserveCheckpoint | SpikeCheckpoint {
  if (!hasCheckpointBase(value)) return false;
  if (value.version === 1) return true;
  if (!Array.isArray(value.recentReads) || !value.recentReads.every(isReadRecord)) return false;
  if (value.version === 2) return true;
  return (
    typeof value.bypassCount === "number" &&
    typeof value.postChangeAuditCount === "number" &&
    typeof value.postChangeGapCount === "number"
  );
}

export function checkpointState(state: SpikeRuntimeState): SpikeCheckpoint {
  return {
    version: SPIKE_STATE_VERSION,
    successfulReads: [...state.successfulReads].sort(),
    recentReads: state.recentReads.slice(-MAX_RECENT_READS),
    mutations: state.mutations.slice(-MAX_MUTATIONS),
    shellRiskCount: state.shellRiskCount,
    guardCounters: { ...state.guardCounters },
    bypassCount: state.bypassCount,
    postChangeAuditCount: state.postChangeAuditCount,
    postChangeGapCount: state.postChangeGapCount,
  };
}

export function restoreStateFromBranch(entries: readonly SessionEntryLike[]): SpikeRuntimeState {
  let latest: LegacySpikeCheckpoint | ObserveCheckpoint | SpikeCheckpoint | undefined;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SPIKE_STATE_ENTRY_TYPE) continue;
    if (isCheckpoint(entry.data)) latest = entry.data;
  }

  const state = createSpikeState();
  if (!latest) return state;

  state.successfulReads = new Set(latest.successfulReads);
  state.recentReads = latest.version === 1
    ? latest.successfulReads.map((path, index) => ({ path, completedAt: index }))
    : latest.recentReads.slice(-MAX_RECENT_READS);
  state.mutations = latest.mutations.slice(-MAX_MUTATIONS);
  state.shellRiskCount = latest.shellRiskCount;
  state.guardCounters = { ...latest.guardCounters };
  if (latest.version === 3) {
    state.bypassCount = latest.bypassCount;
    state.postChangeAuditCount = latest.postChangeAuditCount;
    state.postChangeGapCount = latest.postChangeGapCount;
  }
  state.restoredFromCheckpoint = true;
  return state;
}

export function recordToolExecutionStart(
  state: SpikeRuntimeState,
  event: ToolStartLike,
  cwd: string,
  now = Date.now(),
  toolMappings: readonly ToolMappingConfig[] = [],
): void {
  const mapping = resolveToolMapping(event.toolName, event.args, toolMappings);
  if (!mapping || mapping.operation !== "read") return;
  const rawPath = mapping.rawPath;
  state.pendingReads.set(event.toolCallId, {
    path: normalizeToolPath(cwd, rawPath),
    startedAt: now,
  });
}

export function recordToolExecutionEnd(state: SpikeRuntimeState, toolCallId: string): void {
  state.pendingReads.delete(toolCallId);
}

export function recordToolResult(
  state: SpikeRuntimeState,
  event: ToolResultLike,
  cwd: string,
  now = Date.now(),
  toolMappings: readonly ToolMappingConfig[] = [],
): StateChange {
  const change: StateChange = { checkpointChanged: false };
  const mapping = resolveToolMapping(event.toolName, event.input, toolMappings);

  if (mapping?.operation === "read") {
    const pending = state.pendingReads.get(event.toolCallId);
    state.pendingReads.delete(event.toolCallId);
    const rawPath = mapping.rawPath;
    const path = pending?.path ?? (rawPath ? normalizeToolPath(cwd, rawPath) : undefined);

    if (!event.isError && path) {
      state.successfulReads.add(path);
      state.recentReads = state.recentReads.filter((record) => record.path !== path);
      state.recentReads.push({ path, completedAt: now });
      if (state.recentReads.length > MAX_RECENT_READS) {
        state.recentReads.splice(0, state.recentReads.length - MAX_RECENT_READS);
      }
      change.checkpointChanged = true;
      change.successfulReadPath = path;
    }
    return change;
  }

  if ((mapping?.operation === "edit" || mapping?.operation === "write") && !event.isError) {
    const mutation: MutationRecord = {
      path: normalizeToolPath(cwd, mapping.rawPath),
      toolName: mapping.operation,
      completedAt: now,
    };
    state.mutations.push(mutation);
    if (state.mutations.length > MAX_MUTATIONS) {
      state.mutations.splice(0, state.mutations.length - MAX_MUTATIONS);
    }
    change.checkpointChanged = true;
    change.mutation = mutation;
    return change;
  }

  if ((event.toolName === "bash" || event.toolName === "powershell") && !event.isError) {
    const command = event.input.command;
    if (typeof command !== "string") return change;
    const tags = classifyShellMutationRisk(command);
    if (tags.length > 0) {
      state.shellRiskCount += 1;
      change.checkpointChanged = true;
      change.shellRiskTags = tags;
    }
  }

  return change;
}
