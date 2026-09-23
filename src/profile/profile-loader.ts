import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PROJECT_PROFILE_SCHEMA_VERSION,
  type ProfileEvidenceRef,
  type ProfileSelector,
  type ProjectConventionItem,
  type ProjectKnowledgeItem,
  type ProjectModuleProfile,
  type ProjectProfile,
  type ProjectScopeOverride,
  type ProjectTechnologyRef,
} from "./types.js";

export const DEFAULT_PROJECT_PROFILE_PATH = ".convention-sense/profile.json";

export interface LoadedProjectProfile {
  profilePath: string;
  status: "missing" | "ignored" | "invalid" | "loaded";
  profile?: ProjectProfile;
  fingerprint?: string;
  diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isSelector(value: unknown): value is ProfileSelector {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "paths",
    "excludePaths",
    "languages",
    "modules",
    "baseRoles",
    "fileNames",
    "annotationsAny",
    "dependenciesAny",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  return (
    isOptionalStringArray(value.paths) &&
    isOptionalStringArray(value.excludePaths) &&
    isOptionalStringArray(value.languages) &&
    isOptionalStringArray(value.modules) &&
    isOptionalStringArray(value.baseRoles) &&
    isOptionalStringArray(value.fileNames) &&
    isOptionalStringArray(value.annotationsAny) &&
    isOptionalStringArray(value.dependenciesAny)
  );
}

function isEvidence(value: unknown): value is ProfileEvidenceRef {
  if (!isRecord(value)) return false;
  return (
    ["manifest", "config", "source", "documentation", "user-review"].includes(String(value.kind)) &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.line === undefined || (Number.isInteger(value.line) && Number(value.line) > 0)) &&
    typeof value.detail === "string"
  );
}

function isEvidenceArray(value: unknown): value is ProfileEvidenceRef[] {
  return Array.isArray(value) && value.every(isEvidence);
}

function isTechnology(value: unknown): value is ProjectTechnologyRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    ["language", "framework", "architecture", "persistence", "transport", "build", "database", "infrastructure"].includes(
      String(value.kind),
    ) &&
    (value.version === undefined || typeof value.version === "string") &&
    ["high", "medium", "low"].includes(String(value.confidence)) &&
    isEvidenceArray(value.evidence)
  );
}

function isModule(value: unknown): value is ProjectModuleProfile {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.priority === undefined || Number.isFinite(value.priority)) &&
    isSelector(value.selector) &&
    (value.technologies === undefined || (Array.isArray(value.technologies) && value.technologies.every(isTechnology))) &&
    isOptionalStringArray(value.architecture) &&
    isOptionalStringArray(value.knowledgeRefs) &&
    isOptionalStringArray(value.conventionRefs)
  );
}

function isScopeOverride(value: unknown): value is ProjectScopeOverride {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.priority === undefined || Number.isFinite(value.priority)) &&
    isSelector(value.selector) &&
    (value.effectiveRole === undefined || typeof value.effectiveRole === "string") &&
    isOptionalStringArray(value.architecture) &&
    isOptionalStringArray(value.tags) &&
    ["high", "medium", "low"].includes(String(value.confidence)) &&
    isEvidenceArray(value.evidence)
  );
}

function hasRuleFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    ["hard", "advisory"].includes(String(value.strength)) &&
    (value.selector === undefined || isSelector(value.selector)) &&
    (value.evidence === undefined || isEvidenceArray(value.evidence)) &&
    ["agent-draft", "human", "imported"].includes(String(value.source))
  );
}

function isKnowledge(value: unknown): value is ProjectKnowledgeItem {
  if (!isRecord(value) || !hasRuleFields(value)) return false;
  return (
    ["architecture", "domain", "dependency", "workflow", "security", "data"].includes(String(value.category)) &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    (value.detailPath === undefined || typeof value.detailPath === "string")
  );
}

function isConvention(value: unknown): value is ProjectConventionItem {
  if (!isRecord(value) || !hasRuleFields(value)) return false;
  return typeof value.category === "string" && typeof value.statement === "string";
}

function validateProfile(value: unknown, repositoryRoot: string, diagnostics: string[]): value is ProjectProfile {
  if (!isRecord(value)) {
    diagnostics.push("Profile root must be an object");
    return false;
  }
  if (value.schemaVersion !== PROJECT_PROFILE_SCHEMA_VERSION) {
    diagnostics.push(`Unsupported profile schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (typeof value.profileVersion !== "string" || value.profileVersion.length === 0) {
    diagnostics.push("profileVersion must be a non-empty string");
  }
  if (!isRecord(value.project) || typeof value.project.name !== "string" || value.project.repositoryRoot !== ".") {
    diagnostics.push('project must contain a name and repositoryRoot must be "."');
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    diagnostics.push("generatedAt must be an ISO-compatible date");
  }
  if (!["agent", "human", "imported"].includes(String(value.generatedBy))) {
    diagnostics.push("generatedBy is invalid");
  }
  if (!isRecord(value.review) || !["draft", "reviewed"].includes(String(value.review.status))) {
    diagnostics.push("review.status must be draft or reviewed");
  }
  if (!Array.isArray(value.technologies) || !value.technologies.every(isTechnology)) {
    diagnostics.push("technologies must contain valid technology entries");
  }
  if (
    !Array.isArray(value.packs) ||
    !value.packs.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.enabled === "boolean" &&
        ["builtin", "project"].includes(String(item.source)) &&
        (item.version === undefined || typeof item.version === "string"),
    )
  ) {
    diagnostics.push("packs must contain valid pack references");
  }
  if (!Array.isArray(value.modules) || !value.modules.every(isModule)) {
    diagnostics.push("modules must contain valid module profiles");
  }
  if (!Array.isArray(value.scopeOverrides) || !value.scopeOverrides.every(isScopeOverride)) {
    diagnostics.push("scopeOverrides must contain valid overrides");
  }
  if (!Array.isArray(value.knowledge) || !value.knowledge.every(isKnowledge)) {
    diagnostics.push("knowledge must contain valid project knowledge");
  }
  if (!Array.isArray(value.conventions) || !value.conventions.every(isConvention)) {
    diagnostics.push("conventions must contain valid project conventions");
  }

  if (isRecord(value.project) && Array.isArray(value.project.relatedProjects)) {
    const valid = value.project.relatedProjects.every(
      (item) =>
        isRecord(item) &&
        typeof item.name === "string" &&
        typeof item.path === "string" &&
        ["frontend", "backend", "service", "library", "documentation"].includes(String(item.relationship)),
    );
    if (!valid) diagnostics.push("project.relatedProjects contains invalid entries");
  }

  if (isRecord(value.project) && value.project.repositoryRoot === ".") {
    const declaredRoot = resolve(repositoryRoot, value.project.repositoryRoot);
    if (declaredRoot !== resolve(repositoryRoot)) diagnostics.push("Profile repository root escapes the active repository");
  }

  return diagnostics.length === 0;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(",")}}`;
}

export function createProfileFingerprint(profile: ProjectProfile): string {
  return createHash("sha256").update(stableSerialize(profile)).digest("hex").slice(0, 16);
}

export function loadProjectProfile(
  repositoryRoot: string,
  trusted: boolean,
  relativeProfilePath = DEFAULT_PROJECT_PROFILE_PATH,
): LoadedProjectProfile {
  const profilePath = resolve(repositoryRoot, relativeProfilePath);
  const diagnostics: string[] = [];
  if (!existsSync(profilePath)) return { profilePath, status: "missing", diagnostics };
  if (!trusted) {
    diagnostics.push("Project Profile exists but was ignored because the project is not trusted");
    return { profilePath, status: "ignored", diagnostics };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(profilePath, "utf8"));
  } catch (error) {
    diagnostics.push(`Failed to parse Project Profile: ${error instanceof Error ? error.message : String(error)}`);
    return { profilePath, status: "invalid", diagnostics };
  }
  if (!validateProfile(parsed, repositoryRoot, diagnostics)) {
    return { profilePath, status: "invalid", diagnostics };
  }

  return {
    profilePath,
    status: "loaded",
    profile: parsed,
    fingerprint: createProfileFingerprint(parsed),
    diagnostics,
  };
}

export function resolveDefaultProfilePath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), DEFAULT_PROJECT_PROFILE_PATH);
}
