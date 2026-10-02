import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
  selectChangedSources,
  selectEvidenceGaps,
} from "../src/guard/post-change-audit.js";
import { GuardRuntime } from "../src/guard/runtime.js";
import { isShellTool, resolveToolMapping } from "../src/guard/tool-mapping.js";
import { shellCommand, summarizeToolInput } from "../src/guard/tool-summary.js";
import {
  MAX_ACTIVE_SNAPSHOTS,
  rememberRequestedTarget,
  selectActiveTargetPaths,
  selectCoveredTargets,
  selectPracticeFallbackTargets,
} from "../src/observe/active-targets.js";
import { ObserveAnalyzer } from "../src/observe/analyzer.js";
import { createConfigFingerprint } from "../src/observe/evidence-builder.js";
import { matchesExcludedPath } from "../src/observe/repository-index.js";
import { resolveAnalysisRepositoryRoot } from "../src/observe/repository-root.js";
import { scopeKey } from "../src/observe/scope-detector.js";
import { SnapshotCache } from "../src/observe/snapshot-cache.js";
import { snapshotCreatedPayload, snapshotSkippedPayload } from "../src/observe/snapshot-log.js";
import { configuredSourceLanguage, isConfiguredProductionSource } from "../src/observe/source-selection.js";
import type { AnalyzeTargetResult, ConventionSnapshot } from "../src/observe/types.js";
import { BUILTIN_CONVENTION_PACKS } from "../src/profile/builtin-packs.js";
import { loadProjectProfile } from "../src/profile/profile-loader.js";
import { formatOneShotPracticeReview } from "../src/practice/capsule-formatter.js";
import {
  classifyPracticeMutationInput,
  planPracticeReviewBoundary,
  PracticeReviewRuntime,
} from "../src/practice/review-runtime.js";
import {
  analyzePracticeSnapshot,
  analyzePracticeTarget,
} from "../src/practice/signal-analyzer.js";
import type { PracticeAnalysisResult } from "../src/practice/types.js";
import { applyStableGuidanceSection, createDynamicContextMessage } from "../src/runtime/context.js";
import { loadSpikeConfig, resolveLogPath } from "../src/runtime/config.js";
import { describeHandlerError, HandlerErrorLimiter } from "../src/runtime/handler-errors.js";
import { NdjsonSpikeLogger, type LogMetadata } from "../src/runtime/logger.js";
import { classifyShellMutationRisk, displayPath, normalizeToolPath } from "../src/runtime/paths.js";
import { PathSet, pathKey } from "../src/runtime/path-key.js";
import {
  checkpointState,
  createSpikeState,
  recordToolExecutionEnd,
  recordToolExecutionStart,
  recordToolResult,
  restoreStateFromBranch,
} from "../src/runtime/state.js";
import { buildStatus, formatStatus, looksLikeWebProject } from "../src/runtime/status.js";
import {
  bypassCompletions,
  buildProjectStatusLines,
  formatLastGuardDecision,
  formatSnapshotSummary,
  rememberGuardDecision,
  snapshotCommandTarget,
  type GuardDecisionRecord,
} from "../src/runtime/command-text.js";
import {
  SPIKE_STATE_ENTRY_TYPE,
  type LoadedSpikeConfig,
  type SessionEntryLike,
  type SpikeConfig,
  type SpikeRuntimeState,
} from "../src/runtime/types.js";

const STATUS_KEY = "pi-convention-sense";
const PRACTICE_REVIEW_MESSAGE_TYPE = "pi-convention-sense-practice-review";

interface ShellBaseline {
  git: GitWorktreeState;
  coveredTargets: PathSet;
  riskTags: string[];
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
  const practiceReviewRuntime = new PracticeReviewRuntime();
  const shellBaselines = new Map<string, ShellBaseline>();
  const analysisReasons = new Map<string, AnalyzeTargetResult["reason"]>();
  let guardRequestedTargets: string[] = [];
  let guardDecisions: GuardDecisionRecord[] = [];
  // `getArgumentCompletions` runs outside any event, so it needs the working directory of the last session start.
  let commandCwd = process.cwd();
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

  const handlerErrors = new HandlerErrorLimiter();
  const reportHandlerError = (event: string, ctx: unknown, error: unknown): void => {
    try {
      const description = describeHandlerError(error);
      const { log: shouldLog, occurrences } = handlerErrors.record(
        [event, description.errorName, description.errorCode ?? "", description.errorLocation ?? ""].join("|"),
      );
      if (!shouldLog) return;
      logger.write("handler_error", { handlerEvent: event, ...description, occurrences }, ctx ? metadata(ctx as ExtensionContext) : {});
    } catch {
      // Reporting must never turn a recoverable failure into another one.
    }
  };

  // Pi's runner catches handler errors for every event except `tool_call`, where a throw blocks the
  // tool as a fail-safe. Observe and Guard must fail open, so every handler swallows its own errors.
  const rawOn = pi.on.bind(pi) as unknown as (
    event: string,
    handler: (...args: unknown[]) => unknown,
  ) => unknown;
  const on = ((event: string, handler: (...args: unknown[]) => unknown) =>
    rawOn(event, async (...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        reportHandlerError(event, args[1], error);
        return undefined;
      }
    })) as unknown as ExtensionAPI["on"];

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
    guardRequestedTargets = rememberRequestedTarget(guardRequestedTargets, targetPath);
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
      analysisReasons.delete(pathKey(result.snapshot.targetPath));
      log(ctx, "snapshot_created", snapshotCreatedPayload({
        trigger,
        snapshot: result.snapshot,
        result,
        loadedProfile,
        explainRanking: config.logging.explainRanking,
        cwd: ctx.cwd,
      }));
    } else {
      analysisReasons.set(pathKey(normalizeToolPath(ctx.cwd, targetPath)), result.reason);
      log(ctx, "snapshot_skipped", snapshotSkippedPayload({ trigger, targetPath, result, cwd: ctx.cwd }));
    }
    return result;
  };

  const activeTargetPaths = (): string[] =>
    selectActiveTargetPaths({
      requested: guardRequestedTargets,
      recentReads: state.recentReads,
      isSupported: (path) => configuredSourceLanguage(path, config) !== undefined,
    });

  const ensureActiveSnapshots = (
    ctx: ExtensionContext,
    activePaths = activeTargetPaths(),
  ): ConventionSnapshot[] => {
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
    practiceReviewRuntime.reset();
    shellBaselines.clear();
    analysisReasons.clear();
    guardRequestedTargets = [];
    guardDecisions = [];
  };

  const isPathException = (cwd: string, path: string): boolean =>
    config.guard.pathExceptions.length > 0 && matchesExcludedPath(cwd, path, config.guard.pathExceptions);

  const captureCoveredTargets = (ctx: ExtensionContext): PathSet => {
    const fresh: ConventionSnapshot[] = [];
    for (const cached of snapshotCache.list()) {
      const repositoryRoot = resolveAnalysisRepositoryRoot(cached.targetPath, ctx.cwd);
      const snapshot = snapshotCache.getFresh(cached.targetPath, fingerprintForRepository(ctx, repositoryRoot));
      if (snapshot) fresh.push(snapshot);
    }
    return selectCoveredTargets(fresh, {
      isRead: (path) => state.successfulReads.has(path),
      isInjected: (snapshot) => guardRuntime.isRecentlyInjected(snapshot, config, state.turnIndex),
    });
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

    const changedSources = selectChangedSources({
      cwd: ctx.cwd,
      changedPaths: diff.changedPaths,
      isProductionSource: (path) => isConfiguredProductionSource(path, config, resolveAnalysisRepositoryRoot(path, ctx.cwd)),
      isExcluded: (path) => matchesExcludedPath(ctx.cwd, path, config.exclude),
      isException: (path) => isPathException(ctx.cwd, path),
    });
    const gaps = selectEvidenceGaps(changedSources, baseline.coveredTargets);

    for (const path of changedSources) {
      snapshotCache.invalidatePath(path, "shell-post-change");
      if (config.practiceReview.mode === "auto-once") practiceReviewRuntime.recordMutation(path);
    }
    for (const path of diff.changedPaths) analyzer.noteFileChanged(normalizeToolPath(ctx.cwd, path));
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

  on("session_start", async (event, ctx) => {
    commandCwd = ctx.cwd;
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
      practiceReviewMode: config.practiceReview.mode,
      practiceMaxContextTokens: config.practiceReview.maxContextTokens,
    });
    if (config.enabled) ensureActiveSnapshots(ctx);
    refreshStatus(ctx);

    if (loadedConfig.diagnostics.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`Convention Sense config: ${loadedConfig.diagnostics.join("; ")}`, "warning");
    }
  });

  on("session_before_switch", async (event, ctx) => {
    log(ctx, "session_before_switch", { reason: event.reason, targetSessionFile: event.targetSessionFile });
  });

  on("session_before_fork", async (event, ctx) => {
    log(ctx, "session_before_fork", { entryId: event.entryId, position: event.position });
  });

  on("session_tree", async (event, ctx) => {
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

  on("session_shutdown", async (event, ctx) => {
    persistCheckpoint();
    log(ctx, "session_shutdown", {
      reason: event.reason,
      targetSessionFile: event.targetSessionFile,
      ...snapshotCounts(),
    });
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  on("before_agent_start", async (event, ctx) => {
    log(ctx, "before_agent_start", {
      promptLength: event.prompt.length,
      imageCount: event.images?.length ?? 0,
      selectedTools: event.systemPromptOptions.selectedTools ?? [],
    });
    if (!config.enabled) {
      practiceReviewRuntime.reset();
      return;
    }
    if (config.practiceReview.mode === "auto-once") {
      const generation = practiceReviewRuntime.beginTask();
      log(ctx, "practice_review_task_started", { generation });
    } else {
      practiceReviewRuntime.reset();
    }
    applyStableGuidanceSection(event.systemPromptOptions.sections);
  });

  on("agent_start", async (_event, ctx) => log(ctx, "agent_start"));

  on("turn_start", async (event, ctx) => {
    state.turnIndex = event.turnIndex;
    log(ctx, "turn_start", { turnIndex: event.turnIndex, timestamp: event.timestamp });
  });

  on("context", async (event, ctx) => {
    const activePaths = config.enabled ? activeTargetPaths() : [];
    const snapshots = config.enabled ? ensureActiveSnapshots(ctx, activePaths) : [];
    const appendedMessages: typeof event.messages = [];
    let includedSnapshots: ConventionSnapshot[] = [];
    let practiceAnalyses: PracticeAnalysisResult[] = [];

    if (config.enabled && config.injectContext) {
      if (config.practiceReview.mode === "suggest") {
        practiceAnalyses = snapshots.map((snapshot) => analyzePracticeSnapshot(snapshot));
        const fallbackTargets = selectPracticeFallbackTargets({
          activePaths,
          snapshotTargets: new PathSet(snapshots.map((snapshot) => snapshot.targetPath)),
          analysisReasons,
          isRead: (path) => state.successfulReads.has(path),
          exists: existsSync,
          eligibility: (path) => {
            const language = configuredSourceLanguage(path, config);
            const repositoryRoot = resolveAnalysisRepositoryRoot(path, ctx.cwd);
            if (!language || !isConfiguredProductionSource(path, config, repositoryRoot)) return undefined;
            if (matchesExcludedPath(repositoryRoot, path, config.exclude)) return undefined;
            return { repositoryRoot, language };
          },
          slots: MAX_ACTIVE_SNAPSHOTS - practiceAnalyses.length,
        });
        for (const target of fallbackTargets) {
          practiceAnalyses.push(analyzePracticeTarget(target.path, target.repositoryRoot, target.language));
        }
      }
      state.contextInjectionCount += 1;
      const message = createDynamicContextMessage(
        config,
        state,
        snapshots,
        ctx.cwd,
        practiceAnalyses,
      );
      const included = new Map(
        message.details.includedSnapshots.map((item) => [pathKey(item.targetPath), item.createdAt] as const),
      );
      includedSnapshots = snapshots.filter(
        (snapshot) => included.get(pathKey(snapshot.targetPath)) === snapshot.createdAt,
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
      practiceAnalysisCount: practiceAnalyses.length,
      practiceFallbackAnalysisCount: practiceAnalyses.filter(
        (analysis) => analysis.basis === "successful-read",
      ).length,
      practiceSignalCount: practiceAnalyses.reduce(
        (count, analysis) => count + analysis.signals.length,
        0,
      ),
      practiceSignalIds: [...new Set(practiceAnalyses.flatMap((analysis) =>
        analysis.signals.map((signal) => signal.id),
      ))],
      practiceSkippedReasons: practiceAnalyses.flatMap((analysis) =>
        analysis.reason ? [analysis.reason] : [],
      ),
      practiceDurationMs: practiceAnalyses.reduce(
        (duration, analysis) => duration + analysis.durationMs,
        0,
      ),
      postChangeFindingCount: auditFindings.length,
    });
    if (appendedMessages.length === 0) return;
    return { messages: [...event.messages, ...appendedMessages] };
  });

  on("tool_execution_start", async (event, ctx) => {
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

  on("tool_call", async (event, ctx) => {
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
      ...(analysisReasons.get(pathKey(targetPath))
        ? { analysisReason: analysisReasons.get(pathKey(targetPath)) }
        : {}),
    });

    state.guardCounters[decision.action] += 1;
    guardDecisions = rememberGuardDecision(guardDecisions, {
      toolName: event.toolName,
      targetPath,
      action: decision.action,
      reasonCode: decision.reasonCode,
    });
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

  on("tool_result", async (event, ctx) => {
    const change = recordToolResult(state, event, ctx.cwd, Date.now(), config.toolMappings);
    if (change.checkpointChanged) checkpointDirty = true;

    let snapshotStatus: string | undefined;
    if (config.enabled && change.successfulReadPath) {
      snapshotStatus = analyzePath(ctx, change.successfulReadPath, "read").snapshot?.status;
    }
    let invalidatedSnapshots = 0;
    if (config.enabled && change.mutation) {
      invalidatedSnapshots = snapshotCache.invalidatePath(change.mutation.path);
      analyzer.noteFileChanged(change.mutation.path);
      if (config.practiceReview.mode === "auto-once") {
        practiceReviewRuntime.recordMutation(
          change.mutation.path,
          classifyPracticeMutationInput(change.mutation.toolName, event.input),
        );
      }
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

    // The checkpoint is a full ledger snapshot: it is flushed at agent_settled and session_shutdown,
    // never once per tool result.
    refreshStatus(ctx);
  });

  on("tool_execution_end", async (event, ctx) => {
    recordToolExecutionEnd(state, event.toolCallId);
    log(ctx, "tool_execution_end", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      pendingReadCount: state.pendingReads.size,
    });
    refreshStatus(ctx);
  });

  on("turn_end", async (event, ctx) => {
    log(ctx, "turn_end", {
      turnIndex: event.turnIndex,
      messageRole: event.message.role,
      toolResultCount: event.toolResults.length,
    });
  });

  on("agent_end", async (event, ctx) => log(ctx, "agent_end", { messageCount: event.messages.length }));

  on("agent_before_settle", async (event, ctx) => {
    if (!config.enabled || config.practiceReview.mode !== "auto-once") return;

    const startedAt = Date.now();
    const task = practiceReviewRuntime.current();
    const skip = (reason: string, extra: Record<string, unknown> = {}): undefined => {
      log(ctx, "practice_review_decision", {
        generation: task.generation,
        action: "skip",
        reason,
        mutationTargetCount: task.mutations.length,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
      return undefined;
    };

    const plan = planPracticeReviewBoundary({
      task,
      outcome: event.outcome,
      continuationPending: event.continue || event.context.pendingMessages.length > 0,
      successfulReads: state.successfulReads,
      maxTargets: MAX_ACTIVE_SNAPSHOTS,
      isEligible: (path) => {
        const repositoryRoot = resolveAnalysisRepositoryRoot(path, ctx.cwd);
        return existsSync(path) &&
          isConfiguredProductionSource(path, config, repositoryRoot) &&
          !matchesExcludedPath(repositoryRoot, path, config.exclude);
      },
    });
    if (plan.action === "skip") return skip(plan.reason);

    const analyses: PracticeAnalysisResult[] = [];
    try {
      for (const path of plan.targets) {
        const result = analyzePath(ctx, path, "freshness");
        if (result.snapshot) {
          analyses.push(analyzePracticeSnapshot(result.snapshot));
          continue;
        }
        if (result.reason !== "scope-unknown") continue;
        const language = configuredSourceLanguage(path, config);
        if (!language) continue;
        const repositoryRoot = resolveAnalysisRepositoryRoot(path, ctx.cwd);
        analyses.push(analyzePracticeTarget(path, repositoryRoot, language));
      }
    } catch (error) {
      return skip("analysis-error", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }

    const review = formatOneShotPracticeReview(analyses, config.practiceReview.maxContextTokens);
    if (!review) {
      return skip("no-review-capsule", {
        analyzedTargetCount: analyses.length,
        fallbackTargetCount: analyses.filter(
          (analysis) => analysis.basis === "successful-read",
        ).length,
        practiceSignalCount: analyses.reduce((count, analysis) => count + analysis.signals.length, 0),
      });
    }
    if (!practiceReviewRuntime.requestOnce()) return skip("already-requested");

    log(ctx, "practice_review_decision", {
      generation: task.generation,
      action: "continue",
      reason: "practice-signals",
      mutationTargetCount: task.mutations.length,
      analyzedTargetCount: analyses.length,
      fallbackTargetCount: analyses.filter(
        (analysis) => analysis.basis === "successful-read",
      ).length,
      practiceSignalCount: review.includedSignalIds.length,
      practiceSignalIds: review.includedSignalIds,
      tokenEstimate: review.tokenEstimate,
      durationMs: Date.now() - startedAt,
    });
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: PRACTICE_REVIEW_MESSAGE_TYPE,
          content: review.text,
          display: false,
          details: {
            generation: task.generation,
            signalIds: review.includedSignalIds,
            targetCount: analyses.length,
            fallbackTargetCount: analyses.filter(
              (analysis) => analysis.basis === "successful-read",
            ).length,
            tokenEstimate: review.tokenEstimate,
          },
        },
      ],
      continue: true,
    };
  });

  on("agent_settled", async (_event, ctx) => {
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
      // TypeScript/Vue are opt-in. A web project with the default config is otherwise silently ignored.
      const webProjectNotAnalyzed = looksLikeWebProject(ctx.cwd) &&
        !config.includeLanguages.some((language) => language === "typescript" || language === "vue");
      const projectLines = buildProjectStatusLines({
        config,
        usedProjectConfig: loadedConfig.usedProjectConfig,
        projectTrusted: ctx.isProjectTrusted(),
        profile: projectProfile,
        webProjectNotAnalyzed,
        configDirName: CONFIG_DIR_NAME,
        lastGuard: formatLastGuardDecision(guardDecisions, ctx.cwd),
      });
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
    description: "Show the newest convention Snapshot summary, or the one for a given path",
    handler: async (args, ctx) => {
      const requested = snapshotCommandTarget(args);
      if (!requested) {
        const snapshot = ensureActiveSnapshots(ctx)[0];
        if (!snapshot) {
          ctx.ui.notify("No convention Snapshot is available on the active branch.", "warning");
          return;
        }
        ctx.ui.notify(formatSnapshotSummary(snapshot, ctx.cwd), snapshot.status === "valid" ? "info" : "warning");
        return;
      }

      const targetPath = normalizeToolPath(ctx.cwd, requested);
      const shown = displayPath(ctx.cwd, targetPath);
      if (!configuredSourceLanguage(targetPath, config)) {
        ctx.ui.notify(`${shown} is not a configured source file (languages=${config.includeLanguages.join(",") || "none"}).`, "warning");
        return;
      }
      const repositoryRoot = resolveAnalysisRepositoryRoot(targetPath, ctx.cwd);
      const targetExists = existsSync(targetPath);
      let snapshot = snapshotCache.getFresh(targetPath, fingerprintForRepository(ctx, repositoryRoot));
      // Only a target that was read (or does not exist yet) may be analyzed, exactly as for the model's own requests.
      if (!snapshot && config.enabled && (!targetExists || state.successfulReads.has(targetPath))) {
        snapshot = analyzePath(ctx, targetPath, "freshness", !targetExists).snapshot;
      }
      if (!snapshot) {
        ctx.ui.notify(`No convention Snapshot for ${shown}: read it first (or the analysis found nothing comparable).`, "warning");
        return;
      }
      ctx.ui.notify(formatSnapshotSummary(snapshot, ctx.cwd), snapshot.status === "valid" ? "info" : "warning");
    },
  });

  pi.registerCommand("convention-bypass", {
    description: "Grant one exact-path Convention Guard bypass",
    getArgumentCompletions: (prefix) =>
      config.enabled && config.mode === "guard" && config.guard.allowBypass
        ? bypassCompletions({ decisions: guardDecisions, cwd: commandCwd, prefix })
        : null,
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
