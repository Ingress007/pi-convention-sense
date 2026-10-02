import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { describeHandlerError } from "../runtime/handler-errors.js";
import type { LoadedProjectProfile } from "../profile/profile-loader.js";
import { applyProjectProfileToScope } from "../profile/profiled-scope.js";
import type { ConventionPack } from "../profile/types.js";
import { rankJavaCandidates, type RankCandidatesResult } from "./candidate-ranker.js";
import { buildConventionEvidence, createConfigFingerprint } from "./evidence-builder.js";
import { analyzeJavaFile, detectJavaRole, detectSourceKind } from "./java-analyzer.js";
import { RepositoryIndexCache, matchesExcludedPath } from "./repository-index.js";
import { classificationPath } from "./repository-path.js";
import { detectConventionScope } from "./scope-detector.js";
import { formatConventionSnapshot } from "./snapshot-formatter.js";
import {
  analyzeTypeScriptFile,
  detectTypeScriptLanguage,
  prospectiveTypeScriptFacts,
} from "./typescript-analyzer.js";
import { rankTypeScriptCandidates } from "./typescript-candidate-ranker.js";
import { detectTypeScriptScope } from "./typescript-scope-detector.js";
import {
  ANALYZER_VERSION,
  type AnalyzeTargetResult,
  type ConventionScope,
  type JavaFileFacts,
  type ObserveConfig,
  type SourceFileFacts,
  type TypeScriptFileFacts,
} from "./types.js";

function prospectivePackageName(targetPath: string): string | undefined {
  const normalized = targetPath.replaceAll("\\", "/");
  const marker = "/src/main/java/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const packagePath = normalized.slice(index + marker.length, normalized.lastIndexOf("/"));
  return packagePath ? packagePath.split("/").filter(Boolean).join(".") : undefined;
}

function prospectiveJavaFacts(targetPath: string, repositoryRoot: string): JavaFileFacts {
  const role = detectJavaRole(targetPath, "", repositoryRoot);
  const packageName = prospectivePackageName(targetPath);
  return {
    path: targetPath,
    ...(packageName ? { packageName } : {}),
    role: role.role,
    roleConfidence: role.confidence,
    sourceKind: detectSourceKind(targetPath, repositoryRoot),
    annotations: [],
    imports: [],
    superTypes: [],
    signals: {},
    size: 0,
    mtimeMs: 0,
    contentHash: "prospective",
    generated: /[/\\](?:generated|target|build)[/\\]/i.test(classificationPath(targetPath, repositoryRoot)),
    deprecated: false,
  };
}

type AdapterLanguage = "java" | "typescript" | "vue";

function configuredLanguage(targetPath: string, config: ObserveConfig): AdapterLanguage | undefined {
  const extension = extname(targetPath).toLowerCase();
  if (extension === ".java" && config.includeLanguages.includes("java")) return "java";
  const webLanguage = detectTypeScriptLanguage(targetPath);
  if (webLanguage && config.includeLanguages.includes(webLanguage)) return webLanguage;
  return undefined;
}

function unsupportedResult(startedAt: number): AnalyzeTargetResult {
  return {
    reason: "unsupported-language",
    durationMs: Date.now() - startedAt,
    indexedFileCount: 0,
    consideredCandidateCount: 0,
  };
}

export interface AnalyzeProfileOptions {
  loadedProfile?: LoadedProjectProfile;
  availablePacks?: readonly ConventionPack[];
}

export class ObserveAnalyzer {
  private readonly index = new RepositoryIndexCache();

  private analyzeSourceFacts(
    target: string,
    repositoryRoot: string,
    config: ObserveConfig,
    targetFacts: SourceFileFacts,
    baseScope: ConventionScope,
    indexExtensions: readonly string[],
    ranker: (scope: ConventionScope, indexedFiles: readonly string[]) => RankCandidatesResult,
    targetKind: "existing" | "prospective",
    startedAt: number,
    profileOptions: AnalyzeProfileOptions,
  ): AnalyzeTargetResult {
    let indexedFileCount = 0;
    let consideredCandidateCount = 0;
    try {
      if (targetFacts.generated) {
        return {
          reason: "target-excluded",
          durationMs: Date.now() - startedAt,
          indexedFileCount,
          consideredCandidateCount,
        };
      }
      if (targetFacts.role === "unknown") {
        return {
          reason: "scope-unknown",
          durationMs: Date.now() - startedAt,
          indexedFileCount,
          consideredCandidateCount,
        };
      }

      const profiled = applyProjectProfileToScope(
        baseScope,
        target,
        repositoryRoot,
        targetFacts,
        profileOptions.loadedProfile,
        profileOptions.availablePacks,
      );
      const scope = profiled.scope;
      const index = this.index.get(repositoryRoot, config.exclude, indexExtensions);
      indexedFileCount = index.files.length;
      const ranked = ranker(scope, index.files);
      consideredCandidateCount = ranked.consideredCount;
      const evidence = buildConventionEvidence(scope, ranked.candidates, config.minEvidenceFiles);
      const configFingerprint = createConfigFingerprint(
        config,
        profiled.profileContext?.profileFingerprint,
      );
      const snapshot = {
        scope,
        repositoryRoot: resolve(repositoryRoot),
        targetPath: target,
        targetKind,
        targetMtimeMs: targetFacts.mtimeMs,
        targetSize: targetFacts.size,
        targetHash: targetFacts.contentHash,
        observations: evidence.observations,
        evidenceFiles: evidence.evidenceFiles,
        candidates: ranked.candidates,
        ...(profiled.profileContext ? { projectContext: profiled.profileContext } : {}),
        createdAt: Date.now(),
        status: evidence.status,
        tokenEstimate: 0,
        analyzerVersion: ANALYZER_VERSION,
        configFingerprint,
      } as const;
      const formatted = formatConventionSnapshot(snapshot, repositoryRoot, config.maxContextTokens);

      return {
        snapshot: { ...snapshot, tokenEstimate: formatted.tokenEstimate },
        durationMs: Date.now() - startedAt,
        indexedFileCount,
        consideredCandidateCount,
      };
    } catch (error) {
      return {
        reason: "analysis-error",
        error: error instanceof Error ? error.message : String(error),
        ...describeHandlerError(error),
        durationMs: Date.now() - startedAt,
        indexedFileCount,
        consideredCandidateCount,
      };
    }
  }

  private analyzeJavaFacts(
    target: string,
    repositoryRoot: string,
    config: ObserveConfig,
    facts: JavaFileFacts,
    targetKind: "existing" | "prospective",
    startedAt: number,
    profileOptions: AnalyzeProfileOptions,
  ): AnalyzeTargetResult {
    const baseScope = detectConventionScope(target, repositoryRoot, facts);
    return this.analyzeSourceFacts(
      target,
      repositoryRoot,
      config,
      facts,
      baseScope,
      [".java"],
      (scope, indexedFiles) =>
        rankJavaCandidates({
          repositoryRoot,
          targetPath: target,
          targetFacts: facts,
          targetScope: scope,
          indexedFiles,
          maxCandidates: config.maxEvidenceFiles,
          ...(profileOptions.loadedProfile ? { loadedProfile: profileOptions.loadedProfile } : {}),
          ...(profileOptions.availablePacks ? { availablePacks: profileOptions.availablePacks } : {}),
        }),
      targetKind,
      startedAt,
      profileOptions,
    );
  }

  private analyzeTypeScriptFacts(
    target: string,
    repositoryRoot: string,
    config: ObserveConfig,
    facts: TypeScriptFileFacts,
    targetKind: "existing" | "prospective",
    startedAt: number,
    profileOptions: AnalyzeProfileOptions,
  ): AnalyzeTargetResult {
    const baseScope = detectTypeScriptScope(target, repositoryRoot, facts);
    const extensions = facts.language === "vue" ? [".vue"] : [".ts", ".tsx", ".mts", ".cts"];
    return this.analyzeSourceFacts(
      target,
      repositoryRoot,
      config,
      facts,
      baseScope,
      extensions,
      (scope, indexedFiles) =>
        rankTypeScriptCandidates({
          repositoryRoot,
          targetPath: target,
          targetFacts: facts,
          targetScope: scope,
          indexedFiles,
          maxCandidates: config.maxEvidenceFiles,
          ...(profileOptions.loadedProfile ? { loadedProfile: profileOptions.loadedProfile } : {}),
          ...(profileOptions.availablePacks ? { availablePacks: profileOptions.availablePacks } : {}),
        }),
      targetKind,
      startedAt,
      profileOptions,
    );
  }

  analyzeTarget(
    targetPath: string,
    repositoryRoot: string,
    config: ObserveConfig,
    profileOptions: AnalyzeProfileOptions = {},
  ): AnalyzeTargetResult {
    const startedAt = Date.now();
    const target = resolve(targetPath);
    const language = configuredLanguage(target, config);
    if (!language) return unsupportedResult(startedAt);
    if (!existsSync(target)) {
      return {
        reason: "target-missing",
        durationMs: Date.now() - startedAt,
        indexedFileCount: 0,
        consideredCandidateCount: 0,
      };
    }
    if (matchesExcludedPath(repositoryRoot, target, config.exclude)) {
      return {
        reason: "target-excluded",
        durationMs: Date.now() - startedAt,
        indexedFileCount: 0,
        consideredCandidateCount: 0,
      };
    }

    try {
      return language === "java"
        ? this.analyzeJavaFacts(
            target,
            repositoryRoot,
            config,
            analyzeJavaFile(target, repositoryRoot),
            "existing",
            startedAt,
            profileOptions,
          )
        : this.analyzeTypeScriptFacts(
            target,
            repositoryRoot,
            config,
            analyzeTypeScriptFile(target, repositoryRoot),
            "existing",
            startedAt,
            profileOptions,
          );
    } catch (error) {
      return {
        reason: "analysis-error",
        error: error instanceof Error ? error.message : String(error),
        ...describeHandlerError(error),
        durationMs: Date.now() - startedAt,
        indexedFileCount: 0,
        consideredCandidateCount: 0,
      };
    }
  }

  analyzeProspectiveTarget(
    targetPath: string,
    repositoryRoot: string,
    config: ObserveConfig,
    profileOptions: AnalyzeProfileOptions = {},
  ): AnalyzeTargetResult {
    const startedAt = Date.now();
    const target = resolve(targetPath);
    if (existsSync(target)) return this.analyzeTarget(target, repositoryRoot, config, profileOptions);
    const language = configuredLanguage(target, config);
    if (!language) return unsupportedResult(startedAt);
    if (matchesExcludedPath(repositoryRoot, target, config.exclude)) {
      return {
        reason: "target-excluded",
        durationMs: Date.now() - startedAt,
        indexedFileCount: 0,
        consideredCandidateCount: 0,
      };
    }
    return language === "java"
      ? this.analyzeJavaFacts(
          target,
          repositoryRoot,
          config,
          prospectiveJavaFacts(target, repositoryRoot),
          "prospective",
          startedAt,
          profileOptions,
        )
      : this.analyzeTypeScriptFacts(
          target,
          repositoryRoot,
          config,
          prospectiveTypeScriptFacts(target, repositoryRoot),
          "prospective",
          startedAt,
          profileOptions,
        );
  }

  invalidateIndex(): void {
    this.index.invalidate();
  }

  /** Tell the index a file was created, deleted or edited; only creations and deletions cost a rescan. */
  noteFileChanged(path: string): void {
    this.index.noteFileChanged(path);
  }

  get indexBuildCount(): number {
    return this.index.buildCount;
  }
}
