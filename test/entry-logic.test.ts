// The decisions the extension entry delegates to src/: active targets, covered targets, the Practice fallback, shell
// audit selection, and what gets logged about tool calls and Snapshots.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { selectChangedSources, selectEvidenceGaps } from "../src/guard/post-change-audit.js";
import { shellCommand, summarizeToolInput } from "../src/guard/tool-summary.js";
import {
  MAX_ACTIVE_PATHS,
  MAX_ACTIVE_SNAPSHOTS,
  rememberRequestedTarget,
  selectActiveTargetPaths,
  selectCoveredTargets,
  selectPracticeFallbackTargets,
} from "../src/observe/active-targets.js";
import { snapshotCreatedPayload, snapshotSkippedPayload } from "../src/observe/snapshot-log.js";
import { configuredSourceLanguage, isConfiguredProductionSource } from "../src/observe/source-selection.js";
import type { ConventionSnapshot } from "../src/observe/types.js";
import {
  bypassCompletions,
  buildProjectStatusLines,
  formatLastGuardDecision,
  formatSnapshotSummary,
  rememberGuardDecision,
  snapshotCommandTarget,
  type GuardDecisionRecord,
} from "../src/runtime/command-text.js";
import { createDefaultConfig } from "../src/runtime/config.js";
import { PathSet, isCaseInsensitivePlatform, pathKey } from "../src/runtime/path-key.js";

const ROOT = resolve("/repo");
const p = (name: string): string => join(ROOT, name);

function snapshot(target: string, overrides: Partial<ConventionSnapshot> = {}): ConventionSnapshot {
  return {
    scope: { language: "java", module: "order", role: "service-impl", root: ROOT, confidence: "high" } as ConventionSnapshot["scope"],
    repositoryRoot: ROOT,
    targetPath: target,
    targetKind: "existing",
    targetMtimeMs: 0,
    targetSize: 1,
    targetHash: "h",
    observations: [],
    evidenceFiles: [],
    candidates: [],
    createdAt: 0,
    status: "valid",
    tokenEstimate: 10,
    analyzerVersion: "v",
    configFingerprint: "fp",
    ...overrides,
  };
}

test("languages are enabled per configuration, and production means not test, generated or vendored", () => {
  const config = createDefaultConfig();
  assert.equal(configuredSourceLanguage(p("a/A.java"), config), "java");
  assert.equal(configuredSourceLanguage(p("a/A.JAVA"), config), "java", "the extension is case-insensitive");
  assert.equal(configuredSourceLanguage(p("a/a.ts"), config), undefined, "TypeScript is off by default");
  assert.equal(configuredSourceLanguage(p("a/README.md"), config), undefined);

  config.includeLanguages = ["typescript", "vue"];
  assert.equal(configuredSourceLanguage(p("a/a.ts"), config), "typescript");
  assert.equal(configuredSourceLanguage(p("a/A.vue"), config), "vue");
  assert.equal(configuredSourceLanguage(p("a/A.java"), config), undefined, "Java is off here");

  config.includeLanguages = ["java", "typescript"];
  assert.equal(isConfiguredProductionSource(p("src/main/java/A.java"), config, ROOT), true);
  assert.equal(isConfiguredProductionSource(p("src/test/java/ATest.java"), config, ROOT), false);
  assert.equal(isConfiguredProductionSource(p("target/generated-sources/G.java"), config, ROOT), false);
  assert.equal(isConfiguredProductionSource(p("web/src/app.test.ts"), config, ROOT), false);
  assert.equal(isConfiguredProductionSource(p("web/src/app.ts"), config, ROOT), true);
  assert.equal(isConfiguredProductionSource(p("web/src/App.vue"), config, ROOT), false, "an unconfigured language is never a source");
});

test("a Guard target is remembered once, newest last, and only the newest few are kept", () => {
  let requested: string[] = [];
  for (const name of ["a", "b", "c"]) requested = rememberRequestedTarget(requested, p(name));
  assert.deepEqual(requested, [p("a"), p("b"), p("c")]);

  requested = rememberRequestedTarget(requested, p("a"));
  assert.deepEqual(requested, [p("b"), p("c"), p("a")], "asking again moves the target to the end");

  requested = rememberRequestedTarget(requested, p("d"));
  requested = rememberRequestedTarget(requested, p("e"));
  assert.equal(requested.length, MAX_ACTIVE_SNAPSHOTS);
  assert.deepEqual(requested, [p("c"), p("a"), p("d"), p("e")]);

  assert.deepEqual(rememberRequestedTarget([p("a"), p("b")], p("c"), 2), [p("b"), p("c")], "an explicit limit wins");
  const input = [p("a")];
  rememberRequestedTarget(input, p("b"));
  assert.deepEqual(input, [p("a")], "the argument is not mutated");

  if (isCaseInsensitivePlatform()) {
    assert.deepEqual(rememberRequestedTarget([p("Order.java")], p("ORDER.java")), [p("ORDER.java")], "case variants are one target");
  }
});

test("active targets are the Guard's targets first, then the newest reads, without duplicates or unsupported files", () => {
  const supported = (path: string) => path.endsWith(".java");
  const active = selectActiveTargetPaths({
    requested: [p("old.java"), p("asked.java")],
    recentReads: [{ path: p("first.java") }, { path: p("asked.java") }, { path: p("notes.md") }, { path: p("last.java") }],
    isSupported: supported,
  });
  assert.deepEqual(active, [p("asked.java"), p("old.java"), p("last.java"), p("first.java")]);

  assert.deepEqual(selectActiveTargetPaths({ requested: [], recentReads: [], isSupported: supported }), []);
  assert.deepEqual(selectActiveTargetPaths({ requested: [p("x.md")], recentReads: [{ path: p("y.txt") }], isSupported: supported }), []);

  const many = Array.from({ length: MAX_ACTIVE_PATHS + 10 }, (_value, index) => ({ path: p(`f${index}.java`) }));
  const limited = selectActiveTargetPaths({ requested: [], recentReads: many, isSupported: supported });
  assert.equal(limited.length, MAX_ACTIVE_PATHS);
  assert.equal(limited[0], p(`f${many.length - 1}.java`), "the newest read comes first");
  assert.equal(selectActiveTargetPaths({ requested: [], recentReads: many, isSupported: supported, limit: 3 }).length, 3);
  const asked = ["a", "b", "c", "d", "e"].map((name) => p(`${name}.java`));
  assert.deepEqual(
    selectActiveTargetPaths({ requested: asked, recentReads: many, isSupported: supported, limit: 3 }),
    [p("e.java"), p("d.java"), p("c.java")],
    "the limit also bounds the Guard's own targets",
  );

  if (isCaseInsensitivePlatform()) {
    const folded = selectActiveTargetPaths({ requested: [p("A.java")], recentReads: [{ path: p("a.java") }], isSupported: supported });
    assert.equal(folded.length, 1, "case variants of one file are listed once");
  }
});

test("covered targets need a read and either weak evidence or a recent injection", () => {
  const read = new PathSet([p("read-injected.java"), p("read-weak.java"), p("read-uninjected.java"), p("read-stale-injection.java")]);
  const injected = new Set([pathKey(p("read-injected.java")), pathKey(p("unread-injected.java"))]);
  const covered = selectCoveredTargets(
    [
      snapshot(p("read-injected.java")),
      snapshot(p("read-weak.java"), { status: "weak" }),
      snapshot(p("read-uninjected.java")),
      snapshot(p("unread-injected.java")),
      snapshot(p("unread-weak.java"), { status: "weak" }),
      snapshot(p("Brand.java"), { targetKind: "prospective" }),
      snapshot(p("Brand2.java"), { targetKind: "prospective", status: "weak" }),
    ],
    { isRead: (path) => read.has(path), isInjected: (item) => injected.has(pathKey(item.targetPath)) },
  );
  assert.deepEqual([...covered].sort(), [p("Brand2.java"), p("read-injected.java"), p("read-weak.java")].sort());
  assert.equal(covered.has(p("Brand.java")), false, "a prospective target still needs its Snapshot injected");
  assert.equal(selectCoveredTargets([], { isRead: () => true, isInjected: () => true }).size, 0);
});

test("the Practice fallback takes only read, existing, eligible targets that Observe could not scope", () => {
  const reasons = new Map<string, "scope-unknown" | "analysis-error" | "target-excluded">([
    [pathKey(p("unscoped.java")), "scope-unknown"],
    [pathKey(p("unread.java")), "scope-unknown"],
    [pathKey(p("gone.java")), "scope-unknown"],
    [pathKey(p("test.java")), "scope-unknown"],
    [pathKey(p("broken.java")), "analysis-error"],
    [pathKey(p("covered.java")), "scope-unknown"],
    [pathKey(p("second.java")), "scope-unknown"],
    [pathKey(p("third.java")), "scope-unknown"],
  ]);
  const read = new PathSet([p("unscoped.java"), p("gone.java"), p("test.java"), p("broken.java"), p("covered.java"), p("second.java"), p("third.java")]);
  const input = {
    activePaths: [p("unscoped.java"), p("unread.java"), p("gone.java"), p("test.java"), p("broken.java"), p("covered.java"), p("second.java"), p("third.java"), p("nothing.java")],
    snapshotTargets: new PathSet([p("covered.java")]),
    analysisReasons: reasons,
    isRead: (path: string) => read.has(path),
    exists: (path: string) => !path.endsWith("gone.java"),
    eligibility: (path: string) => (path.endsWith("test.java") ? undefined : { repositoryRoot: ROOT, language: "java" as const }),
    slots: 4,
  };
  assert.deepEqual(selectPracticeFallbackTargets(input).map((target) => target.path), [p("unscoped.java"), p("second.java"), p("third.java")]);
  assert.deepEqual(selectPracticeFallbackTargets({ ...input, slots: 2 }).map((target) => target.path), [p("unscoped.java"), p("second.java")], "the free slots bound the result");
  assert.deepEqual(selectPracticeFallbackTargets({ ...input, slots: 0 }), []);
  assert.deepEqual(selectPracticeFallbackTargets({ ...input, slots: -1 }), []);
  assert.equal(selectPracticeFallbackTargets(input)[0]?.repositoryRoot, ROOT);
});

test("a shell command's changed files are the configured production sources that are not excluded or excepted", () => {
  const changed = selectChangedSources({
    cwd: ROOT,
    changedPaths: ["src/main/A.java", "src/test/ATest.java", "docs/readme.md", "src/main/Gen.java", "src/main/Keep.java", "../outside/B.java"],
    isProductionSource: (path) => path.endsWith(".java") && !path.includes("src" + (process.platform === "win32" ? "\\" : "/") + "test"),
    isExcluded: (path) => path.endsWith("Gen.java"),
    isException: (path) => path.endsWith("Keep.java"),
  });
  assert.deepEqual(changed, [p("src/main/A.java"), resolve(ROOT, "../outside/B.java")], "paths come back absolute, resolved against the working directory");

  const covered = new PathSet([p("src/main/A.java")]);
  assert.deepEqual(selectEvidenceGaps(changed, covered), [resolve(ROOT, "../outside/B.java")]);
  assert.deepEqual(selectEvidenceGaps([], covered), []);
  assert.deepEqual(selectEvidenceGaps(changed, new PathSet(changed)), []);
});

test("tool calls are logged by path and risk tags only", () => {
  const config = createDefaultConfig();
  config.toolMappings = [{ toolName: "custom_patch", operation: "edit", pathField: "target.file" }];

  assert.deepEqual(summarizeToolInput("read", { path: "src/A.java" }, ROOT, config), { path: "src/A.java", operation: "read", builtinMapping: true });
  assert.deepEqual(
    summarizeToolInput("custom_patch", { target: { file: join(ROOT, "src", "B.java") }, patch: "SECRET BODY" }, ROOT, config),
    { path: "src/B.java", operation: "edit", builtinMapping: false },
  );
  const shell = summarizeToolInput("bash", { command: "echo SECRET > src/A.java" }, ROOT, config);
  assert.deepEqual(shell, { commandLength: 24, mutationRiskTags: ["redirect"] });
  assert.ok(!JSON.stringify(shell).includes("SECRET"));
  assert.deepEqual(summarizeToolInput("unknown_tool", { path: "x" }, ROOT, config), {});
  assert.deepEqual(summarizeToolInput("bash", { command: 42 }, ROOT, config), { commandLength: 0, mutationRiskTags: [] });

  assert.equal(shellCommand({ command: "ls" }), "ls");
  for (const input of [undefined, null, "ls", 5, { command: 5 }, {}]) assert.equal(shellCommand(input), "");
});

test("Snapshot log payloads carry paths, scores and counts, and never an error message", () => {
  const target = p("src/OrderServiceImpl.java");
  const peer = p("src/PaymentServiceImpl.java");
  const value = snapshot(target, {
    candidates: [{ path: peer, score: 91, level: 1, breakdown: { sameRole: 30 } }] as unknown as ConventionSnapshot["candidates"],
    observations: [{ id: "logging.slf4j", category: "logging", pattern: "slf4j", support: 3, samples: 4, confidence: "high", status: "dominant", evidence: [], counterEvidence: [] }],
  });
  const common = {
    trigger: "read" as const,
    snapshot: value,
    result: { indexedFileCount: 10, consideredCandidateCount: 3, durationMs: 7 },
    loadedProfile: { status: "missing" as const, diagnostics: [] },
    cwd: ROOT,
  };
  const explained = snapshotCreatedPayload({ ...common, explainRanking: true });
  assert.equal(explained.targetPath, "src/OrderServiceImpl.java");
  assert.equal(explained.scope, "java:order:service-impl");
  assert.deepEqual(explained.candidates, [{ path: "src/PaymentServiceImpl.java", score: 91, level: 1, breakdown: { sameRole: 30 } }]);
  assert.deepEqual(snapshotCreatedPayload({ ...common, explainRanking: false }).candidates, ["src/PaymentServiceImpl.java"]);
  assert.deepEqual(explained.observations, [{ category: "logging", pattern: "slf4j", support: 3, samples: 4, confidence: "high", status: "dominant" }]);
  assert.equal(explained.candidateCount, 1);
  assert.equal(explained.durationMs, 7);

  const skipped = snapshotSkippedPayload({
    trigger: "guard-preflight",
    targetPath: target,
    result: { reason: "analysis-error", error: "ENOENT: open 'C:\\Users\\someone\\secret.java'", errorName: "Error", errorCode: "ENOENT", errorLocation: "analyze (x.js:1)", durationMs: 3, indexedFileCount: 0, consideredCandidateCount: 0 },
    cwd: ROOT,
  });
  assert.equal(skipped.reason, "analysis-error");
  assert.equal(skipped.errorName, "Error");
  assert.equal(skipped.errorCode, "ENOENT");
  assert.equal(JSON.stringify(skipped).includes("secret.java"), false, "the raw error message is dropped");
  assert.equal("error" in skipped, false);
});

test("the last Guard verdicts are remembered once per target, newest last, and completed newest first", () => {
  const decision = (name: string, action: "allow" | "block" = "block", reasonCode = "TARGET_NOT_READ"): GuardDecisionRecord => ({
    toolName: "edit", targetPath: p(name), action, reasonCode,
  });
  let decisions: GuardDecisionRecord[] = [];
  assert.equal(formatLastGuardDecision(decisions, ROOT), "last-guard=none");
  assert.equal(bypassCompletions({ decisions, cwd: ROOT, prefix: "" }), null);

  for (const name of ["a.java", "b.java", "c.java"]) decisions = rememberGuardDecision(decisions, decision(name));
  decisions = rememberGuardDecision(decisions, decision("a.java", "allow", "SNAPSHOT_VALID"));
  assert.deepEqual(decisions.map((item) => item.targetPath), [p("b.java"), p("c.java"), p("a.java")], "asking again replaces the earlier verdict");
  assert.equal(formatLastGuardDecision(decisions, ROOT), "last-guard=allow SNAPSHOT_VALID (edit) a.java");

  assert.deepEqual(bypassCompletions({ decisions, cwd: ROOT, prefix: "" })?.map((item) => item.value), ["a.java", "c.java", "b.java"]);
  assert.deepEqual(bypassCompletions({ decisions, cwd: ROOT, prefix: "  C.J " })?.map((item) => item.value), ["c.java"], "trimmed, case-insensitive substring");
  assert.equal(bypassCompletions({ decisions, cwd: ROOT, prefix: "zzz" }), null);
  assert.equal(bypassCompletions({ decisions, cwd: ROOT, prefix: "", limit: 2 })?.length, 2);
  assert.equal(bypassCompletions({ decisions, cwd: ROOT, prefix: "" })?.[1]?.description, "block TARGET_NOT_READ");

  for (let index = 0; index < 12; index += 1) decisions = rememberGuardDecision(decisions, decision(`f${index}.java`));
  assert.equal(decisions.length, 8, "only the newest eight are kept");
  assert.equal(rememberGuardDecision(decisions, decision("x.java"), 2).length, 2);
});

test("/convention-snapshot arguments drop the file-mention prefix and surrounding spaces", () => {
  assert.equal(snapshotCommandTarget(""), "");
  assert.equal(snapshotCommandTarget("   "), "");
  assert.equal(snapshotCommandTarget(" src/A.java "), "src/A.java");
  assert.equal(snapshotCommandTarget("@src/A.java"), "src/A.java");
  assert.equal(snapshotCommandTarget("  @ src/A.java"), "src/A.java");
});

test("the project part of the status names config, languages, hints, the last verdict, Profile and Packs", () => {
  const config = createDefaultConfig();
  const base = {
    config,
    usedProjectConfig: false,
    projectTrusted: true,
    profile: { status: "missing" as const, diagnostics: [] as string[] },
    webProjectNotAnalyzed: false,
    configDirName: ".pi",
    lastGuard: "last-guard=none",
  };
  assert.deepEqual(buildProjectStatusLines(base), [
    "config-source=defaults, project-trusted=true",
    "languages=java",
    "last-guard=none",
    "practice=suggest, practice-tokens=400",
    "profile=missing",
    "packs=none",
  ]);

  const rich = buildProjectStatusLines({
    ...base,
    usedProjectConfig: true,
    projectTrusted: false,
    webProjectNotAnalyzed: true,
    config: { ...config, includeLanguages: [] },
    profile: {
      status: "loaded",
      fingerprint: "abc123",
      diagnostics: ["one", "two"],
      profile: { review: { status: "draft" }, packs: [{ id: "java-spring", version: "1.0.0", enabled: true }, { id: "off", enabled: false }, { id: "bare", enabled: true }] } as never,
    },
  });
  assert.deepEqual(rich, [
    "config-source=project, project-trusted=false",
    "languages=none",
    'hint=package.json found but TypeScript/Vue analysis is off; set includeLanguages to ["java","typescript","vue"] in .pi/convention-sense.json',
    "last-guard=none",
    "practice=suggest, practice-tokens=400",
    "profile=loaded, review=draft, fingerprint=abc123",
    "packs=java-spring@1.0.0, bare",
    "profile-diagnostics=one; two",
  ]);
});

test("a Snapshot summary names scope, status, target and peers", () => {
  const value = snapshot(p("src/A.java"), { evidenceFiles: [{ path: p("src/B.java"), mtimeMs: 0, size: 1, contentHash: "h", score: 1 }], tokenEstimate: 42 });
  assert.equal(
    formatSnapshotSummary(value, ROOT),
    [
      "scope=java:order:service-impl",
      "status=valid, confidence=high, targetKind=existing",
      "repository=.",
      "target=src/A.java",
      "peers=src/B.java",
      "observations=0, tokens≈42",
    ].join("\n"),
  );
  assert.match(formatSnapshotSummary(snapshot(p("A.java")), ROOT), /^peers=none$/m);
});
