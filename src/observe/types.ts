import type { ResolvedProjectContext } from "../profile/types.js";

export const ANALYZER_VERSION = "multi-lexical-v6-semantic-peers";

export type ScopeConfidence = "high" | "medium" | "low";
export type ObservationConfidence = "high" | "medium" | "low";
export type ObservationStatus = "dominant" | "mixed";
export type SnapshotStatus = "valid" | "weak" | "stale";
export type SourceKind = "production" | "test" | "unknown";

export type JavaRole =
  | "controller"
  | "service-interface"
  | "service-impl"
  | "mapper"
  | "repository"
  | "request-dto"
  | "response-dto"
  | "entity"
  | "unknown";

export type WebRole =
  | "page"
  | "component"
  | "hook"
  | "api-service"
  | "request-client"
  | "pinia-store"
  | "router"
  | "layout"
  | "workspace-package"
  | "unknown";

export type ObserveLanguage = "java" | "typescript" | "vue";
export type ObserveRole = JavaRole | WebRole;
export type JavaDeclarationKind = "class" | "interface" | "enum" | "record";

export interface ConventionScope {
  language: ObserveLanguage;
  module: string;
  role: ObserveRole;
  effectiveRole?: string;
  architecture?: string[];
  profileTags?: string[];
  profileFingerprint?: string;
  root: string;
  sourceRoot?: string;
  packageName?: string;
  confidence: ScopeConfidence;
}

export interface SourceFileFacts {
  path: string;
  role: ObserveRole;
  roleConfidence: ScopeConfidence;
  sourceKind: SourceKind;
  annotations: string[];
  imports: string[];
  superTypes: string[];
  signals: Record<string, string[]>;
  size: number;
  mtimeMs: number;
  contentHash: string;
  generated: boolean;
  deprecated: boolean;
}

export interface JavaFileFacts extends SourceFileFacts {
  packageName?: string;
  declarationKind?: JavaDeclarationKind;
  role: JavaRole;
}

export interface TypeScriptFileFacts extends SourceFileFacts {
  language: "typescript" | "vue";
  role: WebRole;
  workspacePackage?: string;
  exportNames: string[];
  frameworkPrimitives: string[];
}

export interface CandidateScoreBreakdown {
  sameRole: number;
  sameModule: number;
  samePackageOrSibling: number;
  annotationSimilarity: number;
  interfaceOrSuperclassSimilarity: number;
  nameSimilarity?: number;
  importJaccard: number;
  recentlyMaintained: number;
  sizeSimilarity: number;
  generatedOrDeprecatedPenalty: number;
  testOnlyPenalty: number;
}

export interface RankedCandidate {
  path: string;
  score: number;
  level: 0 | 1 | 2 | 3;
  breakdown: CandidateScoreBreakdown;
  facts: SourceFileFacts;
  scope: ConventionScope;
}

export interface EvidenceRef {
  path: string;
  mtimeMs: number;
  size: number;
  contentHash: string;
  score: number;
}

export interface ConventionObservation {
  id: string;
  category: string;
  pattern: string;
  support: number;
  samples: number;
  confidence: ObservationConfidence;
  status: ObservationStatus;
  evidence: EvidenceRef[];
  counterEvidence: EvidenceRef[];
}

export interface ConventionSnapshot {
  scope: ConventionScope;
  repositoryRoot: string;
  targetPath: string;
  targetKind: "existing" | "prospective";
  targetMtimeMs: number;
  targetSize: number;
  targetHash: string;
  observations: ConventionObservation[];
  evidenceFiles: EvidenceRef[];
  candidates: RankedCandidate[];
  projectContext?: ResolvedProjectContext;
  createdAt: number;
  status: SnapshotStatus;
  staleReason?: string;
  tokenEstimate: number;
  analyzerVersion: string;
  configFingerprint: string;
}

export interface AnalyzeTargetResult {
  snapshot?: ConventionSnapshot;
  reason?:
    | "unsupported-language"
    | "target-missing"
    | "target-excluded"
    | "scope-unknown"
    | "analysis-error";
  /** The error message. For callers and tests only: it is never logged because messages can embed paths or text. */
  error?: string;
  /** What may be logged about a failed analysis: the error class, its code and where it was thrown. */
  errorName?: string;
  errorCode?: string;
  errorLocation?: string;
  durationMs: number;
  indexedFileCount: number;
  consideredCandidateCount: number;
}

export type ToolMappingOperation = "read" | "edit" | "write";

export interface ToolMappingConfig {
  toolName: string;
  operation: ToolMappingOperation;
  pathField: string;
}

export interface ObserveConfig {
  enabled: boolean;
  mode: "observe" | "guard";
  minEvidenceFiles: number;
  maxEvidenceFiles: number;
  maxContextTokens: number;
  scopeStrategy: "module-role";
  includeLanguages: string[];
  exclude: string[];
  injectContext: boolean;
  persistSessionState: boolean;
  logPath: string;
  guard: {
    pathExceptions: string[];
    allowBypass: boolean;
    requireRecentContext: boolean;
    contextWindowTurns: number;
    contextMaxAgeMs: number;
  };
  postChangeAudit: {
    enabled: boolean;
    notify: boolean;
    maxChangedFiles: number;
  };
  practiceReview: {
    mode: "off" | "suggest" | "auto-once";
    maxContextTokens: number;
  };
  toolMappings: ToolMappingConfig[];
  logging: {
    level: "silent" | "info" | "debug";
    explainRanking: boolean;
  };
}
