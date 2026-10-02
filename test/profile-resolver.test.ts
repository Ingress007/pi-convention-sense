// Behavior of the Profile selector and the resolver that merges project Profile, modules, overrides and Packs.
import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedProjectProfile } from "../src/profile/profile-loader.js";
import { resolveProjectContext, selectedScopeOverride } from "../src/profile/profile-resolver.js";
import {
  matchesProfileSelector,
  profileSelectorSpecificity,
  type ProfileTargetDescriptor,
} from "../src/profile/profile-selector.js";
import type {
  ConventionPack,
  ProfileSelector,
  ProjectConventionItem,
  ProjectKnowledgeItem,
  ProjectProfile,
} from "../src/profile/types.js";

const ROOT = "/repo";

function descriptor(overrides: Partial<ProfileTargetDescriptor> = {}): ProfileTargetDescriptor {
  return {
    repositoryRoot: ROOT,
    targetPath: "/repo/order/src/main/java/com/acme/OrderService.java",
    language: "java",
    module: "order",
    baseRole: "service-impl",
    annotations: ["Service", "Transactional"],
    dependencies: ["OrderMapper"],
    ...overrides,
  };
}

const evidence = [{ kind: "manifest" as const, detail: "pom.xml" }];

function knowledge(id: string, strength: "hard" | "advisory", selector?: ProfileSelector): ProjectKnowledgeItem {
  return {
    id,
    category: "architecture",
    title: id,
    summary: `${id} summary`,
    strength,
    source: "human",
    ...(selector ? { selector } : {}),
  };
}

function convention(id: string, strength: "hard" | "advisory", selector?: ProfileSelector): ProjectConventionItem {
  return {
    id,
    category: "style",
    statement: `${id} statement`,
    strength,
    source: "human",
    ...(selector ? { selector } : {}),
  };
}

function profile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    schemaVersion: 1,
    profileVersion: "1",
    project: { name: "demo", repositoryRoot: "." },
    generatedAt: "2026-10-01T00:00:00Z",
    generatedBy: "human",
    review: { status: "reviewed", reviewedAt: "2026-10-01T00:00:00Z", reviewedBy: "me" },
    technologies: [],
    packs: [],
    modules: [],
    scopeOverrides: [],
    knowledge: [],
    conventions: [],
    ...overrides,
  };
}

function loaded(value: ProjectProfile): LoadedProjectProfile {
  return { profilePath: "/repo/.convention-sense/profile.json", status: "loaded", profile: value, fingerprint: "fp-1", diagnostics: [] };
}

function pack(overrides: Partial<ConventionPack> = {}): ConventionPack {
  return {
    schemaVersion: 1,
    id: "pack-a",
    version: "1.0.0",
    kind: "framework",
    title: "Pack A",
    description: "A pack",
    languages: ["java"],
    detection: [],
    ...overrides,
  };
}

test("selectors match on every supported field and reject everything else", () => {
  const target = descriptor();
  const cases: Array<[string, ProfileSelector | undefined, boolean]> = [
    ["no selector matches everything", undefined, true],
    ["empty selector matches everything", {}, true],
    ["empty paths do not restrict", { paths: [] }, true],
    ["path glob", { paths: ["order/**/*.java"] }, true],
    ["path glob miss", { paths: ["user/**"] }, false],
    ["excluded path", { paths: ["order/**"], excludePaths: ["**/*Service.java"] }, false],
    ["exclusion that misses", { paths: ["order/**"], excludePaths: ["**/Other.java"] }, true],
    ["language", { languages: ["java"] }, true],
    ["language miss", { languages: ["typescript", "vue"] }, false],
    ["module", { modules: ["order"] }, true],
    ["module miss", { modules: ["user"] }, false],
    ["base role", { baseRoles: ["service-impl", "controller"] }, true],
    ["base role miss", { baseRoles: ["controller"] }, false],
    ["file name", { fileNames: ["*Service.java"] }, true],
    ["file name miss", { fileNames: ["*Controller.java"] }, false],
    ["annotation", { annotationsAny: ["Transactional"] }, true],
    ["annotation miss", { annotationsAny: ["RestController"] }, false],
    ["dependency", { dependenciesAny: ["*Mapper"] }, true],
    ["dependency miss", { dependenciesAny: ["*Client"] }, false],
    ["every field together", { paths: ["order/**"], languages: ["java"], modules: ["order"], baseRoles: ["service-impl"], fileNames: ["*.java"], annotationsAny: ["Service"], dependenciesAny: ["OrderMapper"] }, true],
    ["one failing field fails the whole selector", { paths: ["order/**"], languages: ["java"], modules: ["user"] }, false],
  ];
  for (const [name, selector, expected] of cases) {
    assert.equal(matchesProfileSelector(selector, target), expected, name);
  }
});

test("selectors never match a target outside the repository root", () => {
  assert.equal(matchesProfileSelector({ paths: ["**"] }, descriptor({ targetPath: "/elsewhere/X.java" })), false);
  assert.equal(matchesProfileSelector({ paths: ["**"] }, descriptor({ targetPath: "/repo/../other/X.java" })), false);
  // A missing selector still matches: the root check only applies once a selector is present.
  assert.equal(matchesProfileSelector(undefined, descriptor({ targetPath: "/elsewhere/X.java" })), true);
});

test("a target without annotations or dependencies cannot satisfy those selectors", () => {
  const bare = descriptor({ annotations: [], dependencies: [] });
  assert.equal(matchesProfileSelector({ annotationsAny: ["Service"] }, bare), false);
  assert.equal(matchesProfileSelector({ dependenciesAny: ["*Mapper"] }, bare), false);
  const { annotations: _a, dependencies: _d, ...withoutLists } = descriptor();
  assert.equal(matchesProfileSelector({ annotationsAny: ["Service"] }, withoutLists), false);
});

test("selector specificity weighs paths and file names above languages", () => {
  assert.equal(profileSelectorSpecificity({}), 0);
  assert.equal(profileSelectorSpecificity({ languages: ["java"] }), 1);
  assert.equal(profileSelectorSpecificity({ paths: ["a", "b"] }), 16);
  assert.ok(profileSelectorSpecificity({ fileNames: ["*.java"] }) > profileSelectorSpecificity({ modules: ["order"] }));
  assert.equal(
    profileSelectorSpecificity({ paths: ["a"], excludePaths: ["b"], languages: ["java"], modules: ["m"], baseRoles: ["r"], fileNames: ["f"], annotationsAny: ["x"], dependenciesAny: ["y"] }),
    8 + 2 + 1 + 4 + 4 + 6 + 5 + 3,
  );
});

test("the resolver returns nothing unless the Profile is loaded", () => {
  for (const status of ["missing", "ignored", "invalid"] as const) {
    assert.equal(resolveProjectContext({ profilePath: "x", status, diagnostics: [] }, descriptor()), undefined, status);
  }
  const noFingerprint: LoadedProjectProfile = { ...loaded(profile()), fingerprint: undefined as unknown as string };
  delete (noFingerprint as { fingerprint?: string }).fingerprint;
  assert.equal(resolveProjectContext(noFingerprint, descriptor()), undefined);
});

test("a draft Profile downgrades hard rules to advisory, a reviewed one keeps them, Packs are always advisory", () => {
  const items = {
    knowledge: [knowledge("k-hard", "hard", { paths: ["order/**"] })],
    conventions: [convention("c-hard", "hard", { paths: ["order/**"] })],
    packs: [{ id: "pack-a", enabled: true, source: "builtin" as const }],
  };
  const packWithHardRules = pack({
    knowledge: [{ id: "pk", category: "workflow", title: "pk", summary: "s", strength: "hard" }],
    conventions: [{ id: "pc", category: "style", statement: "s", strength: "hard" }],
  });

  const reviewed = resolveProjectContext(loaded(profile(items)), descriptor(), [packWithHardRules]);
  assert.ok(reviewed);
  assert.deepEqual(reviewed.knowledge.map((entry) => [entry.item.id, entry.sourceKind, entry.strength]), [
    ["k-hard", "project-profile", "hard"],
    ["pk", "global-pack", "advisory"],
  ]);
  assert.deepEqual(reviewed.conventions.map((entry) => [entry.item.id, entry.strength]), [["c-hard", "hard"], ["pc", "advisory"]]);

  const draft = resolveProjectContext(loaded(profile({ ...items, review: { status: "draft" } })), descriptor(), [packWithHardRules]);
  assert.ok(draft);
  assert.deepEqual(draft.knowledge.map((entry) => [entry.item.id, entry.strength]), [["k-hard", "advisory"], ["pk", "advisory"]]);
  assert.equal(draft.reviewStatus, "draft");
});

test("module references pull in items whose own selector does not match", () => {
  const resolved = resolveProjectContext(
    loaded(profile({
      modules: [{ id: "order", title: "Order", selector: { modules: ["order"] }, knowledgeRefs: ["k-ref"], conventionRefs: ["c-ref"] }],
      knowledge: [knowledge("k-ref", "advisory", { paths: ["nowhere/**"] }), knowledge("k-other", "advisory", { paths: ["nowhere/**"] })],
      conventions: [convention("c-ref", "advisory", { paths: ["nowhere/**"] }), convention("c-open", "advisory")],
    })),
    descriptor(),
  );
  assert.ok(resolved);
  assert.deepEqual(resolved.knowledge.map((entry) => entry.item.id), ["k-ref"]);
  assert.deepEqual(resolved.conventions.map((entry) => entry.item.id), ["c-open", "c-ref"]);
  assert.deepEqual(resolved.matchedModuleIds, ["order"]);
});

test("hard rules sort first, then by id, and modules sort by priority, specificity and id", () => {
  const resolved = resolveProjectContext(
    loaded(profile({
      modules: [
        { id: "m-low", title: "low", selector: { languages: ["java"] }, priority: 1 },
        { id: "m-high", title: "high", selector: { languages: ["java"] }, priority: 9 },
        { id: "m-specific", title: "specific", selector: { paths: ["order/**"] }, priority: 1 },
        { id: "m-a", title: "a", selector: { languages: ["java"] }, priority: 1 },
        { id: "m-miss", title: "miss", selector: { languages: ["vue"] } },
      ],
      knowledge: [knowledge("b-adv", "advisory"), knowledge("z-hard", "hard"), knowledge("a-adv", "advisory")],
    })),
    descriptor(),
  );
  assert.ok(resolved);
  assert.deepEqual(resolved.matchedModuleIds, ["m-high", "m-specific", "m-a", "m-low"]);
  assert.deepEqual(resolved.knowledge.map((entry) => entry.item.id), ["z-hard", "a-adv", "b-adv"]);
});

test("technologies merge by kind and id, module entries win, and the result is sorted", () => {
  const tech = (id: string, kind: "framework" | "language", version: string) => ({
    id, kind, version, confidence: "high" as const, evidence,
  });
  const resolved = resolveProjectContext(
    loaded(profile({
      technologies: [tech("spring", "framework", "5"), tech("java", "language", "17")],
      modules: [
        { id: "order", title: "Order", selector: { modules: ["order"] }, technologies: [tech("spring", "framework", "6")] },
        { id: "user", title: "User", selector: { modules: ["user"] }, technologies: [tech("ignored", "framework", "1")] },
      ],
    })),
    descriptor(),
  );
  assert.ok(resolved);
  assert.deepEqual(resolved.technologies.map((entry) => `${entry.kind}:${entry.id}@${entry.version}`), [
    "framework:spring@6",
    "language:java@17",
  ]);
});

test("pack problems become diagnostics instead of failures", () => {
  const resolved = resolveProjectContext(
    loaded(profile({
      packs: [
        { id: "pack-a", enabled: true, source: "builtin", version: "2.0.0" },
        { id: "pack-missing", enabled: true, source: "project" },
        { id: "pack-off", enabled: false, source: "builtin" },
        { id: "pack-b", enabled: true, source: "builtin" },
      ],
    })),
    descriptor(),
    [
      pack({ id: "pack-a", version: "1.0.0", requires: ["pack-needed"], conflictsWith: ["pack-b"] }),
      pack({ id: "pack-b", version: "1.0.0" }),
      pack({ id: "pack-off", version: "1.0.0", knowledge: [{ id: "x", category: "workflow", title: "x", summary: "x", strength: "advisory" }] }),
    ],
  );
  assert.ok(resolved);
  assert.deepEqual(resolved.activePackIds, ["pack-a", "pack-b"]);
  assert.deepEqual(resolved.diagnostics, [
    "Enabled pack is unavailable: pack-missing",
    "Pack conflict: pack-a conflicts with pack-b",
    "Pack pack-a requires missing pack pack-needed",
    "Pack version mismatch for pack-a: requested 2.0.0, loaded 1.0.0",
  ]);
  assert.equal(resolved.knowledge.length, 0, "a disabled Pack contributes nothing");
});

test("the effective role comes from the best matching override, then from Pack roles", () => {
  const roles = [
    { id: "pack-service", label: "Service", baseRole: "service-impl", selector: { paths: ["order/**"] }, description: "d", priority: 1 },
    { id: "pack-generic", label: "Generic", selector: {}, description: "d" },
    { id: "pack-other-base", label: "Other", baseRole: "controller", selector: {}, description: "d", priority: 99 },
  ];
  const packs = [{ id: "pack-a", enabled: true, source: "builtin" as const }];
  const available = [pack({ roles })];

  const fromPack = resolveProjectContext(loaded(profile({ packs })), descriptor(), available);
  assert.equal(fromPack?.effectiveRole, "pack-service", "a role for another base role is ignored");

  const withOverride = resolveProjectContext(
    loaded(profile({
      packs,
      scopeOverrides: [
        { id: "o-low", priority: 1, selector: {}, effectiveRole: "low", confidence: "high", evidence },
        { id: "o-high", priority: 5, selector: { paths: ["order/**"] }, effectiveRole: "high", architecture: ["layered"], tags: ["t2", "t1"], confidence: "high", evidence },
        { id: "o-no-role", priority: 9, selector: {}, tags: ["t1"], confidence: "high", evidence },
      ],
    })),
    descriptor(),
    available,
  );
  assert.equal(withOverride?.effectiveRole, "high");
  assert.deepEqual(withOverride?.tags, ["t1", "t2"]);
  assert.deepEqual(withOverride?.architecture, ["layered"]);

  const none = resolveProjectContext(loaded(profile()), descriptor());
  assert.equal(none?.effectiveRole, undefined);
  assert.equal("effectiveRole" in (none ?? {}), false);
});

test("selectedScopeOverride picks the highest priority, then the most specific, then the lowest id", () => {
  const override = (id: string, priority: number | undefined, selector: ProfileSelector) => ({
    id, ...(priority === undefined ? {} : { priority }), selector, effectiveRole: id, confidence: "high" as const, evidence,
  });
  const target = descriptor();
  assert.equal(selectedScopeOverride([], target), undefined);
  assert.equal(selectedScopeOverride([override("miss", 9, { languages: ["vue"] })], target), undefined);
  assert.equal(selectedScopeOverride([override("a", 1, {}), override("b", 2, {})], target)?.id, "b");
  assert.equal(selectedScopeOverride([override("a", 1, {}), override("b", 1, { paths: ["order/**"] })], target)?.id, "b");
  assert.equal(selectedScopeOverride([override("z", undefined, {}), override("m", undefined, {})], target)?.id, "m");
});
