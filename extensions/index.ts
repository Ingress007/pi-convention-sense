import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  evaluateConventionGuard,
  formatGuardBlockReason,
  type ConventionGuardDecision,
} from "../src/guard/convention-guard.js";
import {
  captureGitWorktreeState,
  diffGitWorktreeStates,
  type GitWorktreeState,
} from "../src/guard/git-auditor.js";
import {
  createPostChangeAuditMessage,
  PostChangeAuditRuntime,
} from "../src/guard/post-change-audit.js";
import { GuardRuntime } from "../src/guard/runtime.js";
import { isShellTool, resolveToolMapping } from "../src/guard/tool-mapping.js";
import { ObserveAnalyzer } from "../src/observe/analyzer.js";
import { createConfigFingerprint } from "../src/observe/evidence-builder.js";
import { matchesExcludedPath } from "../src/observe/repository-index.js";
import { resolveAnalysisRepositoryRoot } from "../src/observe/repository-root.js";
import { scopeKey } from "../src/observe/scope-detector.js";
import { SnapshotCache } from "../src/observe/snapshot-cache.js";
import type {
  AnalyzeTargetResult,
  ConventionSnapshot,
  ObserveConfig,
} from "../src/observe/types.js";
import { detectSourceKind } from "../src/observe/java-analyzer.js";
import {
  detectTypeScriptLanguage,
  detectTypeScriptSourceKind,
} from "../src/observe/typescript-analyzer.js";
import { BUILTIN_CONVENTION_PACKS } from "../src/profile/builtin-packs.js";
import { loadProjectProfile } from "../src/profile/profile-loader.js";
import { applyStableGuidanceSection, createDynamicContextMessage } from "../src/runtime/context.js";
import { loadSpikeConfig, resolveLogPath } from "../src/runtime/config.js";
import { NdjsonSpikeLogger, type LogMetadata } from "../src/runtime/logger.js";
import { classifyShellMutationRisk, displayPath, normalizeToolPath } from "../src/runtime/paths.js";
import {
  checkpointState,
  createSpikeState,
  recordToolExecutionEnd,
  recordToolExecutionStart,
  recordToolResult,
  restoreStateFromBranch,
} from "../src/runtime/state.js";
import { buildStatus, formatStatus } from "../src/runtime/status.js";
import {
  SPIKE_STATE_ENTRY_TYPE,
  type LoadedSpikeConfig,
  type SessionEntryLike,
  type SpikeConfig,
  type SpikeRuntimeState,
} from "../src/runtime/types.js";

const STATUS_KEY = "pi-convention-sense";
const MAX_ACTIVE_SNAPSHOTS = 4;
const MAX_ACTIVE_PATHS = 20;

interface ShellBaseline {
  git: GitWorktreeState;
  coveredTargets: Set<string>;
  riskTags: string[];
}

function shellCommand(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

function configuredSourceLanguage(path: string, config: ObserveConfig): "java" | "typescript" | "vue" | undefined {
  if (extname(path).toLowerCase() === ".java" && config.includeLanguages.includes("java")) return "java";
  const language = detectTypeScriptLanguage(path);
  return language && config.includeLanguages.includes(language) ? language : undefined;
}

function isConfiguredProductionSource(path: string, config: ObserveConfig): boolean {
  const language = configuredSourceLanguage(path, config);
  if (!language) return false;
  return language === "java"
    ? detectSourceKind(path) === "production"
    : detectTypeScriptSourceKind(path) === "production";
}

function summarizeToolInput(
  toolName: string,
  input: unknown,
  cwd: string,
  config: SpikeConfig,
): Record<string, unknown> {
  const mapping = resolveToolMapping(toolName, input, config.toolMappings);
  if (mapping) {
    const absolutePath = normalizeToolPath(cwd, mapping.rawPath);
    return {
      path: displayPath(cwd, absolutePath),
      operation: mapping.operation,
      builtinMapping: mapping.builtin,
    };
  }

  if (isShellTool(toolName)) {
    const command = shellCommand(input);
    return {
      commandLength: command.length,
      mutationRiskTags: classifyShellMutationRisk(command),
    };
  }
  return {};
}

export interface SpikeExtensionRuntime {
  getConfig(): SpikeConfig;
  getState(): SpikeRuntimeState;
  getLoadedConfig(): LoadedSpikeConfig;
  getLogger(): NdjsonSpikeLogger;
  getSnapshotCache(): SnapshotCache;
  getAnalyzer(): ObserveAnalyzer;
  getGuardRuntime(): GuardRuntime;
  getPostChangeAuditRuntime(): PostChangeAuditRuntime;
}

export function registerConventionSenseSpike(pi: ExtensionAPI): SpikeExtensionRuntime {
  let loadedConfig = loadSpikeConfig(process.cwd(), false, CONFIG_DIR_NAME);
  let config = loadedConfig.config;
  let state = createSpikeState();
  let logger = new NdjsonSpikeLogger(resolveLogPath(process.cwd(), config.logPath), config.logging.level);
  const analyzer = new ObserveAnalyzer();
  const snapshotCache = new SnapshotCache();
  const guardRuntime = new GuardRuntime();
  const postChangeAudit = new PostChangeAuditRuntime();
  const shellBaselines = new Map<string, ShellBaseline>();
  const analysisReasons = new Map<string, AnalyzeTargetResult["reason"]>();
  let guardRequestedTargets: string[] = [];
  let checkpointDirty = false;

  const metadata = (ctx: ExtensionContext): LogMetadata => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const leafId = ctx.sessionManager.getLeafId();
    const value: LogMetadata = { sessionId, leafId };
    if (sessionFile !== undefined) value.sessionFile = sessionFile;
    return value;
  };

  const log = (ctx: ExtensionContext, event: string, payload: Record<string, unknown> = {}): void => {
    logger.write(event, payload, metadata(ctx));
  };

  const profileForRepository = (ctx: ExtensionContext, repositoryRoot: string) =>
    loadProjectProfile(
      repositoryRoot,
      ctx.isProjectTrusted() && resolve(repositoryRoot) === resolve(ctx.cwd),
    );

  const fingerprintForRepository = (ctx: ExtensionContext, repositoryRoot: string): string => {
    const loadedProfile = profileForRepository(ctx, repositoryRoot);
    return createConfigFingerprint(config, loadedProfile.fingerprint);
  };

  const snapshotCounts = () => {
    const snapshots = snapshotCache.list();
    return {
      snapshotCount: snapshots.length,
      validSnapshotCount: snapshots.filter((snapshot) => snapshot.status === "valid").length,
      weakSnapshotCount: snapshots.filter((snapshot) => snapshot.status === "weak").length,
      staleSnapshotCount: snapshots.filter((snapshot) => snapshot.status === "stale").length,
    };
  };

  const refreshStatus = (ctx: ExtensionContext): void => {
    if (!config.enabled) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const counts = snapshotCounts();
    const gapCount = postChangeAudit.all().length;
    ctx.ui.setStatus(
      STATUS_KEY,
      `convention:${config.mode} r${state.successfulReads.size} s${counts.validSnapshotCount}/${counts.weakSnapshotCount} p${state.pendingReads.size} g${gapCount}`,
    );
  };

  const persistCheckpoint = (): void => {
    if (!config.enabled || !config.persistSessionState || !checkpointDirty) return;
    pi.appendEntry(SPIKE_STATE_ENTRY_TYPE, checkpointState(state));
    checkpointDirty = false;
  };

  const rememberGuardTarget = (targetPath: string): void => {
    guardRequestedTargets = guardRequestedTargets.filter((path) => path !== targetPath);
    guardRequestedTargets.push(targetPath);
    if (guardRequestedTargets.length > MAX_ACTIVE_SNAPSHOTS) {
      guardRequestedTargets.splice(0, guardRequestedTargets.length - MAX_ACTIVE_SNAPSHOTS);
    }
  };

  const analyzePath = (
    ctx: ExtensionContext,
    targetPath: string,
    trigger: "read" | "restore" | "freshness" | "guard-preflight",
    prospective = false,
  ): AnalyzeTargetResult => {
    const repositoryRoot = resolveAnalysisRepositoryRoot(targetPath, ctx.cwd);
    const loadedProfile = profileForRepository(ctx, repositoryRoot);
    const profileOptions = loadedProfile.status === "loaded"
      ? { loadedProfile, availablePacks: BUILTIN_CONVENTION_PACKS }
      : {};
    const result = prospective
      ? analyzer.analyzeProspectiveTarget(targetPath, repositoryRoot, config, profileOptions)
      : analyzer.analyzeTarget(targetPath, repositoryRoot, config, profileOptions);
    if (result.snapshot) {
      snapshotCache.set(result.snapshot);
      analysisReasons.delete(result.snapshot.targetPath);
      log(ctx, "snapshot_created", {
        trigger,
        targetPath: displayPath(ctx.cwd, result.snapshot.targetPath),
        targetKind: result.snapshot.targetKind,
        repositoryRoot: displayPath(ctx.cwd, result.snapshot.repositoryRoot),
        scope: scopeKey(result.snapshot.scope),
        baseRole: result.snapshot.scope.role,
        effectiveRole: result.snapshot.scope.effectiveRole,
        profileStatus: loadedProfile.status,
        profileFingerprint: loadedProfile.fingerprint,
        profileDiagnostics: loadedProfile.diagnostics,
        scopeConfidence: result.snapshot.scope.confidence,
        status: result.snapshot.status,
        indexedFileCount: result.indexedFileCount,
        consideredCandidateCount: result.consideredCandidateCount,
        durationMs: result.durationMs,
        tokenEstimate: result.snapshot.tokenEstimate,
        candidateCount: result.snapshot.candidates.length,
        candidates: config.logging.explainRanking
          ? result.snapshot.candidates.map((candidate) => ({
              path: displayPath(ctx.cwd, candidate.path),
              score: candidate.score,
              level: candidate.level,
              breakdown: candidate.breakdown,
            }))
          : result.snapshot.candidates.map((candidate) => displayPath(ctx.cwd, candidate.path)),
        observations: result.snapshot.observations.map((observation) => ({
          category: observation.category,
          pattern: observation.pattern,
          support: observation.support,
          samples: observation.samples,
          confidence: observation.confidence,
          status: observation.status,
        })),
      });
    } else {
      analysisReasons.set(normalizeToolPath(ctx.cwd, targetPath), result.reason);
      log(ctx, "snapshot_skipped", {
        trigger,
        targetPath: displayPath(ctx.cwd, targetPath),
        reason: result.reason,
        error: result.error,
        durationMs: result.durationMs,
        indexedFileCount: result.indexedFileCount,
        consideredCandidateCount: result.consideredCandidateCount,
      });
    }
    return result;
  };

  const ensureActiveSnapshots = (ctx: ExtensionContext): ConventionSnapshot[] => {
    const activePaths: string[] = [];
    const addPath = (path: string) => {
      if (
        activePaths.length >= MAX_ACTIVE_PATHS ||
        !configuredSourceLanguage(path, config) ||
        activePaths.includes(path)
      ) return;
      activePaths.push(path);
    };

    for (let index = guardRequestedTargets.length - 1; index >= 0; index -= 1) {
      const path = guardRequestedTargets[index];
      if (path) addPath(path);
    }
    for (let index = state.recentReads.length - 1; index >= 0; index -= 1) {
      const record = state.recentReads[index];
      if (record) addPath(record.path);
      if (activePaths.length >= MAX_ACTIVE_PATHS) break;
    }

    const activeSnapshots: ConventionSnapshot[] = [];
    const activeScopeKeys = new Set<string>();
    for (const path of activePaths) {
      const targetExists = existsSync(path);
      if (targetExists && !state.successfulReads.has(path)) continue;
      const repositoryRoot = resolveAnalysisRepositoryRoot(path, ctx.cwd);
      const fingerprint = fingerprintForRepository(ctx, repositoryRoot);
      let snapshot = snapshotCache.getFresh(path, fingerprint);
      if (!snapshot) {
        snapshot = analyzePath(ctx, path, "freshness", !targetExists).snapshot;
      }
      if (!snapshot) continue;
      const key = scopeKey(snapshot.scope);
      if (activeScopeKeys.has(key)) continue;
      activeScopeKeys.add(key);
      activeSnapshots.push(snapshot);
      if (activeSnapshots.length >= MAX_ACTIVE_SNAPSHOTS) break;
    }
    return activeSnapshots;
  };

  const clearBranchRuntime = (): void => {
    snapshotCache.clear();
    guardRuntime.clear();
    postChangeAudit.clear();
    shellBaselines.clear();
    analysisReasons.clear();
    guardRequestedTargets = [];
  };

  const isPathException = (cwd: string, path: string): boolean =>
    config.guard.pathExceptions.length > 0 && matchesExcludedPath(cwd, path, config.guard.pathExceptions);

  const captureCoveredTargets = (ctx: ExtensionContext): Set<string> => {
    const covered = new Set<string>();
    for (const cached of snapshotCache.list()) {
      const repositoryRoot = resolveAnalysisRepositoryRoot(cached.targetPath, ctx.cwd);
      const fingerprint = fingerprintForRepository(ctx, repositoryRoot);
      const snapshot = snapshotCache.getFresh(cached.targetPath, fingerprint);
      if (!snapshot) continue;
      const targetReady = snapshot.targetKind === "prospective" || state.successfulReads.has(snapshot.targetPath);
      if (!targetReady) continue;
      if (snapshot.status === "weak") {
        covered.add(snapshot.targetPath);
        continue;
      }
      if (guardRuntime.isRecentlyInjected(snapshot, config, state.turnIndex)) {
        covered.add(snapshot.targetPath);
      }
    }
    return covered;
  };

  const auditShellResult = (
    ctx: ExtensionContext,
    toolCallId: string,
    isError: boolean,
  ): void => {
    const baseline = shellBaselines.get(toolCallId);
    shellBaselines.delete(toolCallId);
    if (!baseline || isError) return;

    const after = captureGitWorktreeState(ctx.cwd, config.postChangeAudit.maxChangedFiles);
    const diff = diffGitWorktreeStates(
      ctx.cwd,
      baseline.git,
      after,
      config.postChangeAudit.maxChangedFiles,
    );
    state.postChangeAuditCount += 1;
    checkpointDirty = true;

    if (!diff.available) {
      log(ctx, "post_change_audit_unavailable", {
        toolCallId,
        riskTags: baseline.riskTags,
        reason: diff.reason,
      });
      return;
    }

    const changedSources = diff.changedPaths
      .map((path) => normalizeToolPath(ctx.cwd, path))
      .filter((path) => isConfiguredProductionSource(path, config))
      .filter((path) => !matchesExcludedPath(ctx.cwd, path, config.exclude))
      .filter((path) => !isPathException(ctx.cwd, path));
    const gaps = changedSources.filter((path) => !baseline.coveredTargets.has(path));

    for (const path of changedSources) {
      snapshotCache.invalidatePath(path, "shell-post-change");
    }
    if (changedSources.length > 0) analyzer.invalidateIndex();
    for (const path of gaps) postChangeAudit.addGap(path);
    state.postChangeGapCount += gaps.length;

    log(ctx, "post_change_audit", {
      toolCallId,
      riskTags: baseline.riskTags,
      headChanged: diff.headChanged,
      truncated: diff.truncated,
      changedFileCount: changedSources.length,
      changedPaths: changedSources.map((path) => displayPath(ctx.cwd, path)),
      evidenceGapCount: gaps.length,
      evidenceGapPaths: gaps.map((path) => displayPath(ctx.cwd, path)),
    });
  };

  pi.on("session_start", async (event, ctx) => {
    loadedConfig = loadSpikeConfig(ctx.cwd, ctx.isProjectTrusted(), CONFIG_DIR_NAME);
    config = loadedConfig.config;
    logger = new NdjsonSpikeLogger(resolveLogPath(ctx.cwd, config.logPath), config.logging.level);
    state = restoreStateFromBranch(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
    clearBranchRuntime();
    checkpointDirty = false;
    const loadedProfile = profileForRepository(ctx, ctx.cwd);

    log(ctx, "session_start", {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      mode: config.mode,
      enabled: config.enabled,
      projectTrusted: ctx.isProjectTrusted(),
      usedProjectConfig: loadedConfig.usedProjectConfig,
      configDiagnostics: loadedConfig.diagnostics,
      projectProfileStatus: loadedProfile.status,
      projectProfileFingerprint: loadedProfile.fingerprint,
      projectProfileDiagnostics: loadedProfile.diagnostics,
      restoredFromCheckpoint: state.restoredFromCheckpoint,
      recentReadCount: state.recentReads.length,
      customToolMappingCount: config.toolMappings.length,
      postChangeAuditEnabled: config.postChangeAudit.enabled,
    });
    if (config.enabled) ensureActiveSnapshots(ctx);
    refreshStatus(ctx);

    if (loadedConfig.diagnostics.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`Convention Sense config: ${loadedConfig.diagnostics.join("; ")}`, "warning");
    }
  });

  pi.on("session_before_switch", async (event, ctx) => {
    log(ctx, "session_before_switch", { reason: event.reason, targetSessionFile: event.targetSessionFile });
  });

  pi.on("session_before_fork", async (event, ctx) => {
    log(ctx, "session_before_fork", { entryId: event.entryId, position: event.position });
  });

  pi.on("session_tree", async (event, ctx) => {
    state = restoreStateFromBranch(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
    clearBranchRuntime();
    checkpointDirty = false;
    const snapshots = config.enabled ? ensureActiveSnapshots(ctx) : [];
    log(ctx, "session_tree", {
      oldLeafId: event.oldLeafId,
      newLeafId: event.newLeafId,
      hasSummary: event.summaryEntry !== undefined,
      restoredFromCheckpoint: state.restoredFromCheckpoint,
      successfulReadCount: state.successfulReads.size,
      snapshotCount: snapshots.length,
    });
    refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    persistCheckpoint();
    log(ctx, "session_shutdown", {
      reason: event.reason,
      targetSessionFile: event.targetSessionFile,
      ...snapshotCounts(),
    });
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    log(ctx, "before_agent_start", {
      promptLength: event.prompt.length,
      imageCount: event.images?.length ?? 0,
      selectedTools: event.systemPromptOptions.selectedTools ?? [],
    });
    if (!config.enabled) return;
    applyStableGuidanceSection(event.systemPromptOptions.sections);
  });

  pi.on("agent_start", async (_event, ctx) => log(ctx, "agent_start"));

  pi.on("turn_start", async (event, ctx) => {
    state.turnIndex = event.turnIndex;
    log(ctx, "turn_start", { turnIndex: event.turnIndex, timestamp: event.timestamp });
  });

  pi.on("context", async (event, ctx) => {
    const snapshots = config.enabled ? ensureActiveSnapshots(ctx) : [];
    const appendedMessages: typeof event.messages = [];
    let includedSnapshots: ConventionSnapshot[] = [];

    if (config.enabled && config.injectContext) {
      state.contextInjectionCount += 1;
      const message = createDynamicContextMessage(config, state, snapshots, ctx.cwd);
      const included = new Map(
        message.details.includedSnapshots.map((item) => [item.targetPath, item.createdAt] as const),
      );
      includedSnapshots = snapshots.filter(
        (snapshot) => included.get(snapshot.targetPath) === snapshot.createdAt,
      );
      guardRuntime.markInjected(includedSnapshots, state.turnIndex);
      const resolvedGapCount = postChangeAudit.resolve(
        includedSnapshots.map((snapshot) => snapshot.targetPath),
      );
      if (resolvedGapCount > 0) {
        log(ctx, "post_change_gap_resolved", { resolvedGapCount });
      }
      appendedMessages.push(message);
    }

    const auditFindings = config.enabled && config.postChangeAudit.enabled
      ? postChangeAudit.undelivered()
      : [];
    if (auditFindings.length > 0) {
      appendedMessages.push(
        createPostChangeAuditMessage(
          auditFindings.map((finding) => displayPath(ctx.cwd, finding.path)),
          config.mode,
        ),
      );
      postChangeAudit.markDelivered(auditFindings);
    }

    log(ctx, "context", {
      messageCount: event.messages.length,
      successfulReadCount: state.successfulReads.size,
      pendingReadCount: state.pendingReads.size,
      snapshotCount: snapshots.length,
      injectedSnapshotCount: includedSnapshots.length,
      scopes: includedSnapshots.map((snapshot) => scopeKey(snapshot.scope)),
      postChangeFindingCount: auditFindings.length,
    });
    if (appendedMessages.length === 0) return;
    return { messages: [...event.messages, ...appendedMessages] };
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    recordToolExecutionStart(state, event, ctx.cwd, Date.now(), config.toolMappings);
    const command = isShellTool(event.toolName) ? shellCommand(event.args) : "";
    const riskTags = command ? classifyShellMutationRisk(command) : [];
    if (config.enabled && config.postChangeAudit.enabled && riskTags.length > 0) {
      shellBaselines.set(event.toolCallId, {
        git: captureGitWorktreeState(ctx.cwd, config.postChangeAudit.maxChangedFiles),
        coveredTargets: captureCoveredTargets(ctx),
        riskTags,
      });
    }
    log(ctx, "tool_execution_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...summarizeToolInput(event.toolName, event.args, ctx.cwd, config),
      pendingReadCount: state.pendingReads.size,
      gitBaselineCaptured: shellBaselines.has(event.toolCallId),
    });
    refreshStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    log(ctx, "tool_call", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...summarizeToolInput(event.toolName, event.input, ctx.cwd, config),
    });
    if (!config.enabled) return;

    const mapping = resolveToolMapping(event.toolName, event.input, config.toolMappings);
    if (!mapping || (mapping.operation !== "edit" && mapping.operation !== "write")) return;

    const targetPath = normalizeToolPath(ctx.cwd, mapping.rawPath);
    rememberGuardTarget(targetPath);
    const targetExists = existsSync(targetPath);
    const unsupportedLanguage = !configuredSourceLanguage(targetPath, config);
    const repositoryRoot = resolveAnalysisRepositoryRoot(targetPath, ctx.cwd);
    const targetExcluded = !unsupportedLanguage && matchesExcludedPath(repositoryRoot, targetPath, config.exclude);
    const fingerprint = fingerprintForRepository(ctx, repositoryRoot);
    let snapshot = unsupportedLanguage || targetExcluded
      ? undefined
      : snapshotCache.getFresh(targetPath, fingerprint);

    if (!snapshot && !unsupportedLanguage && !targetExcluded) {
      if (!targetExists || state.successfulReads.has(targetPath)) {
        snapshot = analyzePath(
          ctx,
          targetPath,
          "guard-preflight",
          !targetExists,
        ).snapshot;
      }
    }

    const bypassGranted = guardRuntime.hasBypass(targetPath);
    const decision: ConventionGuardDecision = evaluateConventionGuard({
      config,
      targetPath,
      targetExists,
      targetRead: state.successfulReads.has(targetPath),
      ...(snapshot ? { snapshot } : {}),
      snapshotInjected: snapshot
        ? guardRuntime.isRecentlyInjected(snapshot, config, state.turnIndex)
        : false,
      bypassGranted,
      unsupportedLanguage,
      targetExcluded,
      pathException: isPathException(repositoryRoot, targetPath),
      ...(analysisReasons.get(targetPath)
        ? { analysisReason: analysisReasons.get(targetPath) }
        : {}),
    });

    state.guardCounters[decision.action] += 1;
    if (decision.reasonCode === "BYPASS_GRANTED" && guardRuntime.consumeBypass(targetPath)) {
      state.bypassCount += 1;
      log(ctx, "guard_bypass_consumed", {
        toolCallId: event.toolCallId,
        targetPath: displayPath(ctx.cwd, targetPath),
      });
    }
    checkpointDirty = true;
    log(ctx, config.mode === "observe" ? "observe_decision" : "guard_decision", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      operation: mapping.operation,
      targetPath: displayPath(ctx.cwd, targetPath),
      targetExists,
      action: decision.action,
      reasonCode: decision.reasonCode,
      scope: decision.scope ? scopeKey(decision.scope) : undefined,
      suggestedPeers: decision.suggestedPeers.map((path) => displayPath(ctx.cwd, path)),
      bypassAvailable: decision.bypassAvailable,
      snapshotStatus: snapshot?.status,
      snapshotInjected: snapshot
        ? guardRuntime.isRecentlyInjected(snapshot, config, state.turnIndex)
        : false,
      successfulReadCount: state.successfulReads.size,
      pendingReadCount: state.pendingReads.size,
    });
    refreshStatus(ctx);

    if (decision.action === "block") {
      return {
        block: true,
        reason: formatGuardBlockReason(
          decision,
          displayPath(ctx.cwd, targetPath),
          (path) => displayPath(ctx.cwd, path),
        ),
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const change = recordToolResult(state, event, ctx.cwd, Date.now(), config.toolMappings);
    if (change.checkpointChanged) checkpointDirty = true;

    let snapshotStatus: string | undefined;
    if (config.enabled && change.successfulReadPath) {
      snapshotStatus = analyzePath(ctx, change.successfulReadPath, "read").snapshot?.status;
    }
    let invalidatedSnapshots = 0;
    if (config.enabled && change.mutation) {
      invalidatedSnapshots = snapshotCache.invalidatePath(change.mutation.path);
      analyzer.invalidateIndex();
      log(ctx, "snapshot_invalidated", {
        path: displayPath(ctx.cwd, change.mutation.path),
        invalidatedSnapshots,
        reason: "controlled-mutation",
      });
    }

    if (config.enabled && isShellTool(event.toolName)) {
      auditShellResult(ctx, event.toolCallId, event.isError);
    }

    log(ctx, "tool_result", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      ...summarizeToolInput(event.toolName, event.input, ctx.cwd, config),
      successfulReadPath: change.successfulReadPath
        ? displayPath(ctx.cwd, change.successfulReadPath)
        : undefined,
      mutationPath: change.mutation ? displayPath(ctx.cwd, change.mutation.path) : undefined,
      shellRiskTags: change.shellRiskTags ?? [],
      successfulReadCount: state.successfulReads.size,
      pendingReadCount: state.pendingReads.size,
      snapshotStatus,
      invalidatedSnapshots,
    });

    persistCheckpoint();
    refreshStatus(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    recordToolExecutionEnd(state, event.toolCallId);
    log(ctx, "tool_execution_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      pendingReadCount: state.pendingReads.size,
    });
    refreshStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    log(ctx, "turn_end", {
      turnIndex: event.turnIndex,
      messageRole: event.message.role,
      toolResultCount: event.toolResults.length,
    });
  });

  pi.on("agent_end", async (event, ctx) => log(ctx, "agent_end", { messageCount: event.messages.length }));

  pi.on("agent_settled", async (_event, ctx) => {
    persistCheckpoint();
    const findings = postChangeAudit.all();
    log(ctx, "agent_settled", {
      successfulReadCount: state.successfulReads.size,
      mutationCount: state.mutations.length,
      shellRiskCount: state.shellRiskCount,
      guardCounters: { ...state.guardCounters },
      bypassCount: state.bypassCount,
      postChangeAuditCount: state.postChangeAuditCount,
      postChangeGapCount: state.postChangeGapCount,
      pendingPostChangeGaps: findings.map((finding) => displayPath(ctx.cwd, finding.path)),
      isIdle: ctx.isIdle(),
      ...snapshotCounts(),
    });
    if (findings.length > 0 && config.postChangeAudit.notify && ctx.hasUI) {
      ctx.ui.notify(
        `Convention post-change audit found ${findings.length} Java file(s) without verified Evidence:\n${findings
          .map((finding) => `- ${displayPath(ctx.cwd, finding.path)}`)
          .join("\n")}`,
        "warning",
      );
    }
    postChangeAudit.clear();
    shellBaselines.clear();
    refreshStatus(ctx);
  });

  pi.registerCommand("convention-status", {
    description: "Show runtime, configuration, Profile, and Pack status",
    handler: async (_args, ctx) => {
      const statusInput = {
        config,
        state,
        logPath: logger.filePath,
        configDiagnostics: loadedConfig.diagnostics,
        sessionId: ctx.sessionManager.getSessionId(),
        ...snapshotCounts(),
      };
      const sessionFile = ctx.sessionManager.getSessionFile();
      const status = buildStatus({
        ...statusInput,
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(logger.lastError === undefined ? {} : { loggerError: logger.lastError }),
      });
      const projectProfile = profileForRepository(ctx, ctx.cwd);
      const profileParts = [`profile=${projectProfile.status}`];
      if (projectProfile.profile !== undefined) {
        profileParts.push(`review=${projectProfile.profile.review.status}`);
      }
      if (projectProfile.fingerprint !== undefined) {
        profileParts.push(`fingerprint=${projectProfile.fingerprint}`);
      }
      const activePacks = projectProfile.profile?.packs.flatMap((pack) => {
        if (!pack.enabled) return [];
        const versionSuffix = pack.version ? `@${pack.version}` : "";
        return [`${pack.id}${versionSuffix}`];
      }) ?? [];
      const projectLines = [
        `config-source=${loadedConfig.usedProjectConfig ? "project" : "defaults"}`,
        profileParts.join(", "),
        `packs=${activePacks.join(", ") || "none"}`,
        ...(projectProfile.diagnostics.length > 0
          ? [`profile-diagnostics=${projectProfile.diagnostics.join("; ")}`]
          : []),
      ];
      const level = logger.lastError || projectProfile.status === "invalid" ? "warning" : "info";
      ctx.ui.notify([formatStatus(status), ...projectLines].join("\n"), level);
    },
  });

  pi.registerCommand("convention-reset", {
    description: "Reset Convention Sense state for the current branch",
    handler: async (args, ctx) => {
      if (args.trim() !== "confirm") {
        ctx.ui.notify(
          "Usage: /convention-reset confirm\nThis clears current-branch reads, Snapshots, Guard/bypass state, and post-change findings. Logs are retained.",
          "warning",
        );
        return;
      }
      const previous = {
        successfulReadCount: state.successfulReads.size,
        pendingReadCount: state.pendingReads.size,
        mutationCount: state.mutations.length,
        snapshotCount: snapshotCache.list().length,
        bypassCount: state.bypassCount,
        postChangeGapCount: postChangeAudit.all().length,
      };
      state = createSpikeState();
      clearBranchRuntime();
      analyzer.invalidateIndex();
      pi.appendEntry(SPIKE_STATE_ENTRY_TYPE, checkpointState(state));
      checkpointDirty = false;
      log(ctx, "runtime_reset", { scope: "current-branch", ...previous });
      refreshStatus(ctx);
      ctx.ui.notify(
        `Convention Sense current-branch state reset. Cleared reads=${previous.successfulReadCount}, pending=${previous.pendingReadCount}, mutations=${previous.mutationCount}, snapshots=${previous.snapshotCount}, bypass=${previous.bypassCount}, post-change-gaps=${previous.postChangeGapCount}. Logs were retained.`,
        "info",
      );
    },
  });

  pi.registerCommand("convention-snapshot", {
    description: "Show the newest convention Snapshot summary",
    handler: async (_args, ctx) => {
      const snapshot = ensureActiveSnapshots(ctx)[0];
      if (!snapshot) {
        ctx.ui.notify("No Java convention Snapshot is available on the active branch.", "warning");
        return;
      }
      const lines = [
        `scope=${scopeKey(snapshot.scope)}`,
        `status=${snapshot.status}, confidence=${snapshot.scope.confidence}, targetKind=${snapshot.targetKind}`,
        `repository=${displayPath(ctx.cwd, snapshot.repositoryRoot)}`,
        `target=${displayPath(snapshot.repositoryRoot, snapshot.targetPath)}`,
        `peers=${snapshot.evidenceFiles.map((item) => displayPath(snapshot.repositoryRoot, item.path)).join(", ") || "none"}`,
        `observations=${snapshot.observations.length}, tokens≈${snapshot.tokenEstimate}`,
      ];
      ctx.ui.notify(lines.join("\n"), snapshot.status === "valid" ? "info" : "warning");
    },
  });

  pi.registerCommand("convention-bypass", {
    description: "Grant one exact-path Convention Guard bypass",
    handler: async (args, ctx) => {
      const rawPath = args.trim();
      if (!rawPath) {
        ctx.ui.notify("Usage: /convention-bypass <path>", "warning");
        return;
      }
      if (!config.enabled || config.mode !== "guard" || !config.guard.allowBypass) {
        ctx.ui.notify("Convention Guard bypass is not enabled for this project.", "warning");
        return;
      }
      const targetPath = normalizeToolPath(ctx.cwd, rawPath);
      guardRuntime.grantBypass(targetPath);
      log(ctx, "guard_bypass_granted", { targetPath: displayPath(ctx.cwd, targetPath) });
      ctx.ui.notify(
        `One-time Convention Guard bypass granted for ${displayPath(ctx.cwd, targetPath)}.`,
        "warning",
      );
    },
  });

  pi.registerCommand("convention-audit", {
    description: "Show pending shell post-change Convention findings",
    handler: async (_args, ctx) => {
      const findings = postChangeAudit.all();
      if (findings.length === 0) {
        ctx.ui.notify("No pending Convention post-change findings.", "info");
        return;
      }
      ctx.ui.notify(
        findings.map((finding) => `- ${displayPath(ctx.cwd, finding.path)} [${finding.reasonCode}]`).join("\n"),
        "warning",
      );
    },
  });

  return {
    getConfig: () => config,
    getState: () => state,
    getLoadedConfig: () => loadedConfig,
    getLogger: () => logger,
    getSnapshotCache: () => snapshotCache,
    getAnalyzer: () => analyzer,
    getGuardRuntime: () => guardRuntime,
    getPostChangeAuditRuntime: () => postChangeAudit,
  };
}

export const registerConventionSenseObserve = registerConventionSenseSpike;
export const registerConventionSenseGuard = registerConventionSenseSpike;

export default function conventionSenseGuard(pi: ExtensionAPI): void {
  registerConventionSenseGuard(pi);
}
