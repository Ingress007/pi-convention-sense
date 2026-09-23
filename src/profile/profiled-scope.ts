import type { ConventionScope, SourceFileFacts } from "../observe/types.js";
import type { LoadedProjectProfile } from "./profile-loader.js";
import { resolveProjectContext } from "./profile-resolver.js";
import type { ConventionPack, ResolvedProjectContext } from "./types.js";

export interface ProfiledScopeResult {
  scope: ConventionScope;
  profileContext?: ResolvedProjectContext;
}

export function applyProjectProfileToScope(
  baseScope: ConventionScope,
  targetPath: string,
  repositoryRoot: string,
  facts: SourceFileFacts,
  loadedProfile?: LoadedProjectProfile,
  availablePacks: readonly ConventionPack[] = [],
): ProfiledScopeResult {
  if (!loadedProfile) return { scope: baseScope };
  const profileContext = resolveProjectContext(
    loadedProfile,
    {
      repositoryRoot,
      targetPath,
      language: baseScope.language,
      module: baseScope.module,
      baseRole: baseScope.role,
      annotations: facts.annotations,
      dependencies: facts.imports,
    },
    availablePacks,
  );
  if (!profileContext) return { scope: baseScope };

  return {
    scope: {
      ...baseScope,
      ...(profileContext.effectiveRole ? { effectiveRole: profileContext.effectiveRole } : {}),
      ...(profileContext.architecture.length > 0 ? { architecture: profileContext.architecture } : {}),
      ...(profileContext.tags.length > 0 ? { profileTags: profileContext.tags } : {}),
      profileFingerprint: profileContext.profileFingerprint,
    },
    profileContext,
  };
}

export function effectiveScopeRole(scope: ConventionScope): string {
  return scope.effectiveRole ?? scope.role;
}
