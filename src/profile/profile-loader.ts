import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isRacyClean } from "../runtime/racy-clean.js";
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNonEmptyStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isNonEmptyString));
}

// Paths in a Profile are repository-relative: never absolute, never leaving the repository. This must
// stay identical to safeRepositoryPath in skills/project-profiler/scripts/profile-tools.mjs; the
// differential test in test/profile-differential.test.ts keeps the two validators in agreement.
function isSafeRepositoryPath(value: unknown): value is string {
  if (!isNonEmptyString(value) || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.replaceAll("\\", "/").split("/").includes("..");
}

function isOptionalSafePathArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isSafeRepositoryPath));
}

function hasUniqueNonEmptyIds(items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || seen.has(item.id)) return false;
    seen.add(item.id);
  }
  return true;
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
    isOptionalSafePathArray(value.paths) &&
    isOptionalSafePathArray(value.excludePaths) &&
    isOptionalNonEmptyStringArray(value.languages) &&
    isOptionalNonEmptyStringArray(value.modules) &&
    isOptionalNonEmptyStringArray(value.baseRoles) &&
    isOptionalNonEmptyStringArray(value.fileNames) &&
    isOptionalNonEmptyStringArray(value.annotationsAny) &&
    isOptionalNonEmptyStringArray(value.dependenciesAny)
  );
}

function isEvidence(value: unknown): value is ProfileEvidenceRef {
  if (!isRecord(value)) return false;
  return (
    ["manifest", "config", "source", "documentation", "user-review"].includes(String(value.kind)) &&
    (value.path === undefined || isSafeRepositoryPath(value.path)) &&
    (value.line === undefined || (Number.isInteger(value.line) && Number(value.line) > 0)) &&
    isNonEmptyString(value.detail)
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
    isNonEmptyString(value.title) &&
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
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.summary) &&
    (value.detailPath === undefined || isSafeRepositoryPath(value.detailPath))
  );
}

function isConvention(value: unknown): value is ProjectConventionItem {
  if (!isRecord(value) || !hasRuleFields(value)) return false;
  return isNonEmptyString(value.category) && isNonEmptyString(value.statement);
}

function validateProfile(value: unknown, repositoryRoot: string, diagnostics: string[]): value is ProjectProfile {
  if (!isRecord(value)) {
    diagnostics.push("Profile root must be an object");
    return false;
  }
  if (value.schemaVersion !== PROJECT_PROFILE_SCHEMA_VERSION) {
    diagnostics.push(`Unsupported profile schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (!isNonEmptyString(value.profileVersion)) {
    diagnostics.push("profileVersion must be a non-empty string");
  }
  if (!isRecord(value.project) || !isNonEmptyString(value.project.name) || value.project.repositoryRoot !== ".") {
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
        isNonEmptyString(item.id) &&
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
  for (const key of ["technologies", "modules", "scopeOverrides", "knowledge", "conventions"] as const) {
    if (Array.isArray(value[key]) && !hasUniqueNonEmptyIds(value[key])) {
      diagnostics.push(`${key} must have unique non-empty ids`);
    }
  }

  if (isRecord(value.project) && Array.isArray(value.project.relatedProjects)) {
    const valid = value.project.relatedProjects.every(
      (item) =>
        isRecord(item) &&
        isNonEmptyString(item.name) &&
        isNonEmptyString(item.path) &&
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

// loadProjectProfile runs for every active path on every model request. An unchanged file must not be
// re-read, re-parsed and re-hashed, but a Profile edit has to take effect immediately, so a file that is
// still racy-clean (see isRacyClean) is always re-read.
const MAX_CACHED_PROFILES = 20;
const profileCache = new Map<string, { mtimeMs: number; size: number; loaded: LoadedProjectProfile }>();

function readProjectProfile(
  profilePath: string,
  repositoryRoot: string,
  diagnostics: string[],
): LoadedProjectProfile {
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

/** The returned object may be shared between calls: treat it as read-only. */
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

  let stat;
  try {
    stat = statSync(profilePath);
  } catch {
    return { profilePath, status: "missing", diagnostics };
  }
  const cacheable = !isRacyClean(stat.mtimeMs, Date.now());
  const cached = cacheable ? profileCache.get(profilePath) : undefined;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.loaded;

  const loaded = readProjectProfile(profilePath, repositoryRoot, diagnostics);
  if (cacheable) {
    if (profileCache.size >= MAX_CACHED_PROFILES) profileCache.clear();
    profileCache.set(profilePath, { mtimeMs: stat.mtimeMs, size: stat.size, loaded });
  } else {
    profileCache.delete(profilePath);
  }
  return loaded;
}

export function resolveDefaultProfilePath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), DEFAULT_PROJECT_PROFILE_PATH);
}
