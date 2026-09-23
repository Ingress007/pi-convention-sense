import type { LoadedProjectProfile } from "./profile-loader.js";
import {
  matchesProfileSelector,
  profileSelectorSpecificity,
  type ProfileTargetDescriptor,
} from "./profile-selector.js";
import type {
  ConventionPack,
  PackConventionItem,
  PackKnowledgeItem,
  ProfileRuleStrength,
  ProjectConventionItem,
  ProjectKnowledgeItem,
  ProjectModuleProfile,
  ProjectScopeOverride,
  ProjectTechnologyRef,
  ResolvedProfileItem,
  ResolvedProjectContext,
} from "./types.js";

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function priority(value: { priority?: number; selector: object }): number {
  return value.priority ?? 0;
}

function compareMatches(
  left: { id: string; priority?: number; selector: Parameters<typeof profileSelectorSpecificity>[0] },
  right: { id: string; priority?: number; selector: Parameters<typeof profileSelectorSpecificity>[0] },
): number {
  return (
    priority(right) - priority(left) ||
    profileSelectorSpecificity(right.selector) - profileSelectorSpecificity(left.selector) ||
    left.id.localeCompare(right.id)
  );
}

function profileStrength(strength: ProfileRuleStrength, reviewed: boolean): ProfileRuleStrength {
  return reviewed ? strength : "advisory";
}

function resolveTechnologies(
  profileTechnologies: readonly ProjectTechnologyRef[],
  modules: readonly ProjectModuleProfile[],
): ProjectTechnologyRef[] {
  const resolved = new Map<string, ProjectTechnologyRef>();
  for (const technology of profileTechnologies) resolved.set(`${technology.kind}:${technology.id}`, technology);
  for (const module of modules) {
    for (const technology of module.technologies ?? []) {
      resolved.set(`${technology.kind}:${technology.id}`, technology);
    }
  }
  return [...resolved.values()].sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
  );
}

function resolveProjectItems<T extends ProjectKnowledgeItem | ProjectConventionItem>(
  items: readonly T[],
  referencedIds: ReadonlySet<string>,
  descriptor: ProfileTargetDescriptor,
  reviewed: boolean,
): Array<ResolvedProfileItem<T>> {
  return items
    .filter((item) => referencedIds.has(item.id) || matchesProfileSelector(item.selector, descriptor))
    .map((item) => ({
      item,
      sourceKind: "project-profile" as const,
      sourceId: item.id,
      strength: profileStrength(item.strength, reviewed),
    }));
}

function resolvePackItems<T extends PackKnowledgeItem | PackConventionItem>(
  pack: ConventionPack,
  items: readonly T[],
  descriptor: ProfileTargetDescriptor,
): Array<ResolvedProfileItem<T>> {
  return items
    .filter((item) => matchesProfileSelector(item.selector, descriptor))
    .map((item) => ({
      item,
      sourceKind: "global-pack" as const,
      sourceId: pack.id,
      strength: "advisory" as const,
    }));
}

function sortResolvedItems<T extends { id: string }>(items: Array<ResolvedProfileItem<T>>): void {
  items.sort(
    (left, right) =>
      Number(right.strength === "hard") - Number(left.strength === "hard") ||
      left.item.id.localeCompare(right.item.id) ||
      left.sourceId.localeCompare(right.sourceId),
  );
}

export function resolveProjectContext(
  loaded: LoadedProjectProfile,
  descriptor: ProfileTargetDescriptor,
  availablePacks: readonly ConventionPack[] = [],
): ResolvedProjectContext | undefined {
  if (loaded.status !== "loaded" || !loaded.profile || !loaded.fingerprint) return undefined;
  const profile = loaded.profile;
  const diagnostics = [...loaded.diagnostics];
  const reviewed = profile.review.status === "reviewed";

  const matchedModules = profile.modules
    .filter((module) => matchesProfileSelector(module.selector, descriptor))
    .sort(compareMatches);
  const matchedOverrides = profile.scopeOverrides
    .filter((override) => matchesProfileSelector(override.selector, descriptor))
    .sort(compareMatches);

  const enabledPackRefs = profile.packs.filter((pack) => pack.enabled);
  const packById = new Map(availablePacks.map((pack) => [pack.id, pack]));
  const activePacks: ConventionPack[] = [];
  for (const reference of enabledPackRefs) {
    const pack = packById.get(reference.id);
    if (!pack) {
      diagnostics.push(`Enabled pack is unavailable: ${reference.id}`);
      continue;
    }
    if (reference.version && reference.version !== pack.version) {
      diagnostics.push(`Pack version mismatch for ${reference.id}: requested ${reference.version}, loaded ${pack.version}`);
    }
    activePacks.push(pack);
  }

  const activePackIds = new Set(activePacks.map((pack) => pack.id));
  for (const pack of activePacks) {
    for (const required of pack.requires ?? []) {
      if (!activePackIds.has(required)) diagnostics.push(`Pack ${pack.id} requires missing pack ${required}`);
    }
    for (const conflict of pack.conflictsWith ?? []) {
      if (activePackIds.has(conflict)) diagnostics.push(`Pack conflict: ${pack.id} conflicts with ${conflict}`);
    }
  }

  let effectiveRole = matchedOverrides.find((override) => override.effectiveRole)?.effectiveRole;
  if (!effectiveRole) {
    const packRoles = activePacks
      .flatMap((pack) =>
        (pack.roles ?? [])
          .filter(
            (role) =>
              (!role.baseRole || role.baseRole === descriptor.baseRole) &&
              matchesProfileSelector(role.selector, descriptor),
          )
          .map((role) => ({ ...role, packId: pack.id })),
      )
      .sort(compareMatches);
    effectiveRole = packRoles[0]?.id;
  }

  const architecture = uniqueSorted([
    ...matchedModules.flatMap((module) => module.architecture ?? []),
    ...matchedOverrides.flatMap((override) => override.architecture ?? []),
  ]);
  const tags = uniqueSorted(matchedOverrides.flatMap((override) => override.tags ?? []));
  const knowledgeRefs = new Set(matchedModules.flatMap((module) => module.knowledgeRefs ?? []));
  const conventionRefs = new Set(matchedModules.flatMap((module) => module.conventionRefs ?? []));

  const knowledge: Array<ResolvedProfileItem<ProjectKnowledgeItem | PackKnowledgeItem>> = [
    ...resolveProjectItems(profile.knowledge, knowledgeRefs, descriptor, reviewed),
    ...activePacks.flatMap((pack) => resolvePackItems(pack, pack.knowledge ?? [], descriptor)),
  ];
  const conventions: Array<ResolvedProfileItem<ProjectConventionItem | PackConventionItem>> = [
    ...resolveProjectItems(profile.conventions, conventionRefs, descriptor, reviewed),
    ...activePacks.flatMap((pack) => resolvePackItems(pack, pack.conventions ?? [], descriptor)),
  ];
  sortResolvedItems(knowledge);
  sortResolvedItems(conventions);

  return {
    profilePath: loaded.profilePath,
    profileFingerprint: loaded.fingerprint,
    reviewStatus: profile.review.status,
    matchedModuleIds: matchedModules.map((module) => module.id),
    activePackIds: activePacks.map((pack) => pack.id).sort((left, right) => left.localeCompare(right)),
    ...(effectiveRole ? { effectiveRole } : {}),
    architecture,
    tags,
    technologies: resolveTechnologies(profile.technologies, matchedModules),
    knowledge,
    conventions,
    diagnostics: uniqueSorted(diagnostics),
  };
}

export function selectedScopeOverride(
  overrides: readonly ProjectScopeOverride[],
  descriptor: ProfileTargetDescriptor,
): ProjectScopeOverride | undefined {
  return overrides
    .filter((override) => matchesProfileSelector(override.selector, descriptor))
    .sort(compareMatches)[0];
}
