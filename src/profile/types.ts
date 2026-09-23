export const CONVENTION_PACK_SCHEMA_VERSION = 1 as const;
export const PROJECT_PROFILE_SCHEMA_VERSION = 1 as const;

export type ProfileReviewStatus = "draft" | "reviewed";
export type ProfileRuleStrength = "hard" | "advisory";
export type ProfileConfidence = "high" | "medium" | "low";
export type ProfileSourceKind = "global-pack" | "project-profile" | "local-evidence" | "executable";

export type PackKind =
  | "language"
  | "framework"
  | "architecture"
  | "persistence"
  | "transport"
  | "build"
  | "testing"
  | "library";

export type TechnologyKind = Exclude<PackKind, "testing" | "library"> | "database" | "infrastructure";

export interface ProfileEvidenceRef {
  kind: "manifest" | "config" | "source" | "documentation" | "user-review";
  path?: string;
  line?: number;
  detail: string;
}

export interface ProfileSelector {
  paths?: string[];
  excludePaths?: string[];
  languages?: string[];
  modules?: string[];
  baseRoles?: string[];
  fileNames?: string[];
  annotationsAny?: string[];
  dependenciesAny?: string[];
}

export interface PackDetectionSignal {
  kind: "file" | "dependency" | "manifest";
  pattern: string;
  weight: number;
  description: string;
}

export interface PackRoleDefinition {
  id: string;
  label: string;
  priority?: number;
  baseRole?: string;
  selector: ProfileSelector;
  description: string;
}

export interface PackKnowledgeItem {
  id: string;
  category: "architecture" | "domain" | "dependency" | "workflow" | "security" | "data";
  title: string;
  summary: string;
  strength: ProfileRuleStrength;
  selector?: ProfileSelector;
  detailPath?: string;
  evidence?: ProfileEvidenceRef[];
}

export interface PackConventionItem {
  id: string;
  category: string;
  statement: string;
  strength: ProfileRuleStrength;
  selector?: ProfileSelector;
  evidence?: ProfileEvidenceRef[];
}

export interface ConventionPack {
  schemaVersion: typeof CONVENTION_PACK_SCHEMA_VERSION;
  id: string;
  version: string;
  kind: PackKind;
  title: string;
  description: string;
  languages: string[];
  detection: PackDetectionSignal[];
  requires?: string[];
  conflictsWith?: string[];
  roles?: PackRoleDefinition[];
  knowledge?: PackKnowledgeItem[];
  conventions?: PackConventionItem[];
}

export interface ProjectTechnologyRef {
  id: string;
  kind: TechnologyKind;
  version?: string;
  confidence: ProfileConfidence;
  evidence: ProfileEvidenceRef[];
}

export interface ProjectPackRef {
  id: string;
  version?: string;
  enabled: boolean;
  source: "builtin" | "project";
}

export interface ProjectModuleProfile {
  id: string;
  title: string;
  priority?: number;
  selector: ProfileSelector;
  technologies?: ProjectTechnologyRef[];
  architecture?: string[];
  knowledgeRefs?: string[];
  conventionRefs?: string[];
}

export interface ProjectScopeOverride {
  id: string;
  priority?: number;
  selector: ProfileSelector;
  effectiveRole?: string;
  architecture?: string[];
  tags?: string[];
  confidence: ProfileConfidence;
  evidence: ProfileEvidenceRef[];
}

export interface ProjectKnowledgeItem extends PackKnowledgeItem {
  source: "agent-draft" | "human" | "imported";
}

export interface ProjectConventionItem extends PackConventionItem {
  source: "agent-draft" | "human" | "imported";
}

export interface ProjectProfileReview {
  status: ProfileReviewStatus;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface ProjectProfile {
  schemaVersion: typeof PROJECT_PROFILE_SCHEMA_VERSION;
  profileVersion: string;
  project: {
    name: string;
    repositoryRoot: string;
    relatedProjects?: Array<{
      name: string;
      path: string;
      relationship: "frontend" | "backend" | "service" | "library" | "documentation";
    }>;
  };
  generatedAt: string;
  generatedBy: "agent" | "human" | "imported";
  review: ProjectProfileReview;
  technologies: ProjectTechnologyRef[];
  packs: ProjectPackRef[];
  modules: ProjectModuleProfile[];
  scopeOverrides: ProjectScopeOverride[];
  knowledge: ProjectKnowledgeItem[];
  conventions: ProjectConventionItem[];
}

export interface ResolvedProfileItem<T> {
  item: T;
  sourceKind: ProfileSourceKind;
  sourceId: string;
  strength: ProfileRuleStrength;
}

export interface ResolvedProjectContext {
  profilePath: string;
  profileFingerprint: string;
  reviewStatus: ProfileReviewStatus;
  matchedModuleIds: string[];
  activePackIds: string[];
  effectiveRole?: string;
  architecture: string[];
  tags: string[];
  technologies: ProjectTechnologyRef[];
  knowledge: Array<ResolvedProfileItem<ProjectKnowledgeItem | PackKnowledgeItem>>;
  conventions: Array<ResolvedProfileItem<ProjectConventionItem | PackConventionItem>>;
  diagnostics: string[];
}
