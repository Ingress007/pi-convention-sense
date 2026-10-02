import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { evaluateConventionGuard } from "../src/guard/convention-guard.js";
import { captureGitWorktreeState, DEFAULT_GIT_TIMEOUT_MS, gitArguments, parsePorcelain } from "../src/guard/git-auditor.js";
import { createPostChangeAuditMessage, PostChangeAuditRuntime } from "../src/guard/post-change-audit.js";
import { GuardRuntime } from "../src/guard/runtime.js";
import { resolveToolMapping } from "../src/guard/tool-mapping.js";
import { ObserveAnalyzer } from "../src/observe/analyzer.js";
import { createDefaultConfig, loadSpikeConfig } from "../src/runtime/config.js";
import { isCaseInsensitivePlatform } from "../src/runtime/path-key.js";

const fixtures = resolve("test", "fixtures");
const mavenRoot = join(fixtures, "java-maven");
const mavenTarget = join(
  mavenRoot,
  "order",
  "src",
  "main",
  "java",
  "com",
  "acme",
  "order",
  "service",
  "impl",
  "OrderServiceImpl.java",
);

function guardConfig() {
  return { ...createDefaultConfig(), mode: "guard" as const };
}

test("formal Guard blocks only missing discovery steps for a valid target", () => {
  const config = guardConfig();
  const analyzed = new ObserveAnalyzer().analyzeTarget(mavenTarget, mavenRoot, config);
  assert.ok(analyzed.snapshot);
  const base = {
    config,
    targetPath: mavenTarget,
    targetExists: true,
    snapshot: analyzed.snapshot,
    bypassGranted: false,
    unsupportedLanguage: false,
    targetExcluded: false,
    pathException: false,
  };

  const unread = evaluateConventionGuard({
    ...base,
    targetRead: false,
    snapshotInjected: false,
  });
  assert.equal(unread.action, "block");
  assert.equal(unread.reasonCode, "TARGET_NOT_READ");
  assert.equal(unread.bypassAvailable, true);

  const notInjected = evaluateConventionGuard({
    ...base,
    targetRead: true,
    snapshotInjected: false,
  });
  assert.equal(notInjected.action, "block");
  assert.equal(notInjected.reasonCode, "SNAPSHOT_NOT_INJECTED");
  assert.equal(notInjected.suggestedPeers.length, 3);

  const ready = evaluateConventionGuard({
    ...base,
    targetRead: true,
    snapshotInjected: true,
  });
  assert.equal(ready.action, "allow");
  assert.equal(ready.reasonCode, "SNAPSHOT_VALID");
});

test("Observe shadows formal Guard without blocking", () => {
  const config = createDefaultConfig();
  const decision = evaluateConventionGuard({
    config,
    targetPath: mavenTarget,
    targetExists: true,
    targetRead: false,
    snapshotInjected: false,
    bypassGranted: false,
  });
  assert.equal(decision.action, "wouldBlock");
  assert.equal(decision.reasonCode, "TARGET_NOT_READ");
});

test("weak, mixed, no-peer, low-scope and analysis errors fail open", () => {
  const config = guardConfig();
  const gradleRoot = join(fixtures, "java-gradle");
  const gradleTarget = join(
    gradleRoot,
    "inventory",
    "src",
    "main",
    "java",
    "com",
    "acme",
    "inventory",
    "controller",
    "InventoryController.java",
  );
  const weak = new ObserveAnalyzer().analyzeTarget(gradleTarget, gradleRoot, config).snapshot;
  assert.ok(weak);
  const insufficient = evaluateConventionGuard({
    config,
    targetPath: gradleTarget,
    targetExists: true,
    targetRead: true,
    snapshot: weak,
    snapshotInjected: false,
    bypassGranted: false,
  });
  assert.equal(insufficient.action, "allow");
  assert.equal(insufficient.reasonCode, "INSUFFICIENT_PEERS_AVAILABLE");

  const noPeerSnapshot = { ...weak, evidenceFiles: [], candidates: [] };
  const noPeers = evaluateConventionGuard({
    config,
    targetPath: gradleTarget,
    targetExists: true,
    targetRead: true,
    snapshot: noPeerSnapshot,
    snapshotInjected: false,
    bypassGranted: false,
  });
  assert.equal(noPeers.reasonCode, "NO_PEERS_AVAILABLE");

  const lowScope = evaluateConventionGuard({
    config,
    targetPath: gradleTarget,
    targetExists: true,
    targetRead: true,
    snapshot: { ...weak, scope: { ...weak.scope, confidence: "low" } },
    snapshotInjected: false,
    bypassGranted: false,
  });
  assert.equal(lowScope.reasonCode, "SCOPE_LOW_CONFIDENCE");
  assert.equal(lowScope.action, "allow");

  const failed = evaluateConventionGuard({
    config,
    targetPath: gradleTarget,
    targetExists: true,
    targetRead: true,
    snapshotInjected: false,
    bypassGranted: false,
    analysisReason: "analysis-error",
  });
  assert.equal(failed.reasonCode, "ANALYSIS_FAILED_OPEN");
  assert.equal(failed.action, "allow");
});

test("bypass and project exception decisions are explicit", () => {
  const config = guardConfig();
  const bypass = evaluateConventionGuard({
    config,
    targetPath: mavenTarget,
    targetExists: true,
    targetRead: false,
    snapshotInjected: false,
    bypassGranted: true,
  });
  assert.equal(bypass.reasonCode, "BYPASS_GRANTED");
  assert.equal(bypass.action, "allow");

  const exception = evaluateConventionGuard({
    config,
    targetPath: mavenTarget,
    targetExists: true,
    targetRead: false,
    snapshotInjected: false,
    bypassGranted: false,
    pathException: true,
  });
  assert.equal(exception.reasonCode, "PATH_EXCEPTION");
  assert.equal(exception.action, "allow");
});

test("Guard runtime enforces exact one-time bypass and Context freshness", () => {
  const config = guardConfig();
  const snapshot = new ObserveAnalyzer().analyzeTarget(mavenTarget, mavenRoot, config).snapshot;
  assert.ok(snapshot);
  const runtime = new GuardRuntime();

  assert.equal(runtime.grantBypass(mavenTarget), true);
  assert.equal(runtime.hasBypass(mavenTarget), true);
  assert.equal(runtime.consumeBypass(mavenTarget), true);
  assert.equal(runtime.consumeBypass(mavenTarget), false);

  runtime.markInjected([snapshot], 5, 1_000);
  assert.equal(runtime.isRecentlyInjected(snapshot, config, 6, 2_000), true);
  assert.equal(runtime.isRecentlyInjected(snapshot, config, 8, 2_000), false);
  assert.equal(runtime.isRecentlyInjected(snapshot, config, 6, 1_000 + config.guard.contextMaxAgeMs + 1), false);
  // Rebuilding the Snapshot (a newer createdAt) around the same evidence does not make the model forget it...
  assert.equal(runtime.isRecentlyInjected({ ...snapshot, createdAt: snapshot.createdAt + 1, targetHash: "edited", targetSize: 1 }, config, 6, 2_000), true);
  // ...but different evidence is something the model has not seen.
  const firstPeer = snapshot.evidenceFiles[0];
  assert.ok(firstPeer);
  const changedPeer = { ...snapshot, evidenceFiles: [{ ...firstPeer, contentHash: "another" }, ...snapshot.evidenceFiles.slice(1)] };
  assert.equal(runtime.isRecentlyInjected(changedPeer, config, 6, 2_000), false);
  assert.equal(runtime.isRecentlyInjected({ ...snapshot, evidenceFiles: snapshot.evidenceFiles.slice(1) }, config, 6, 2_000), false);
  assert.equal(runtime.isRecentlyInjected({ ...snapshot, observations: [] }, config, 6, 2_000), snapshot.observations.length === 0);
  assert.equal(runtime.isRecentlyInjected({ ...snapshot, configFingerprint: "other-config" }, config, 6, 2_000), false);
  assert.equal(runtime.isRecentlyInjected({ ...snapshot, scope: { ...snapshot.scope, effectiveRole: "subtype" } }, config, 6, 2_000), false);
  // The record is per target.
  assert.equal(runtime.isRecentlyInjected({ ...snapshot, targetPath: mavenTarget.replace("OrderServiceImpl", "Other") }, config, 6, 2_000), false);
});

test("post-change gaps clear after the affected target receives fresh injected Evidence", () => {
  const audit = new PostChangeAuditRuntime();
  audit.addGap(mavenTarget, 1_000);
  assert.equal(audit.undelivered().length, 1);
  audit.markDelivered(audit.undelivered());
  assert.equal(audit.undelivered().length, 0);
  assert.equal(audit.all().length, 1);
  assert.equal(audit.resolve([mavenTarget]), 1);
  assert.equal(audit.all().length, 0);
});

test("prospective analysis discovers peers without creating the target", () => {
  const newTarget = mavenTarget.replace("OrderServiceImpl.java", "ShippingServiceImpl.java");
  const result = new ObserveAnalyzer().analyzeProspectiveTarget(newTarget, mavenRoot, guardConfig());
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.targetKind, "prospective");
  assert.equal(result.snapshot.status, "valid");
  assert.equal(result.snapshot.scope.role, "service-impl");
  assert.ok(result.snapshot.evidenceFiles.length >= 2);
});

test("Guard config cannot require Context when Context injection is disabled", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-guard-context-config-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({
      mode: "guard",
      injectContext: false,
      guard: { requireRecentContext: true },
    }),
  );
  const loaded = loadSpikeConfig(cwd, true);
  assert.equal(loaded.config.guard.requireRecentContext, false);
  assert.match(loaded.diagnostics.join("\n"), /injectContext is false/);
});

test("trusted config validates nested Guard settings and safe third-party mappings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-guard-config-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({
      mode: "guard",
      guard: {
        pathExceptions: ["**/legacy/**"],
        allowBypass: false,
        contextWindowTurns: 3,
        contextMaxAgeMs: 20_000,
      },
      postChangeAudit: { enabled: true, notify: false, maxChangedFiles: 25 },
      toolMappings: [
        { toolName: "custom_read", operation: "read", pathField: "file.path" },
        { toolName: "edit", operation: "write", pathField: "path" },
        { toolName: "unsafe", operation: "edit", pathField: "__proto__.path" },
      ],
    }),
  );
  const loaded = loadSpikeConfig(cwd, true);
  assert.deepEqual(loaded.config.guard.pathExceptions, ["**/legacy/**"]);
  assert.equal(loaded.config.guard.allowBypass, false);
  assert.equal(loaded.config.guard.contextWindowTurns, 3);
  assert.equal(loaded.config.postChangeAudit.notify, false);
  assert.equal(loaded.config.postChangeAudit.maxChangedFiles, 25);
  assert.equal(loaded.config.toolMappings.length, 1);
  assert.match(loaded.diagnostics.join("\n"), /toolMappings\[1\]/);
  assert.match(loaded.diagnostics.join("\n"), /toolMappings\[2\]/);

  const mapping = resolveToolMapping(
    "custom_read",
    { file: { path: "src/A.java" } },
    loaded.config.toolMappings,
  );
  assert.equal(mapping?.operation, "read");
  assert.equal(mapping?.rawPath, "src/A.java");
});

test("Guard runtime and post-change audit match paths by platform path key and keep the display spelling", () => {
  const original = resolve("/repo", "Order.java");
  const variant = resolve("/repo", "order.java");

  const guard = new GuardRuntime();
  guard.grantBypass(original);
  assert.equal(guard.hasBypass(variant), isCaseInsensitivePlatform());
  assert.equal(guard.consumeBypass(variant), isCaseInsensitivePlatform());

  const audit = new PostChangeAuditRuntime();
  audit.addGap(original);
  assert.equal(audit.all()[0]?.path, original, "findings are shown to the user and must keep their spelling");
  assert.equal(audit.resolve([variant]), isCaseInsensitivePlatform() ? 1 : 0);
});

function porcelain(count: number): string {
  return Array.from({ length: count }, (_value, index) => `?? src/File${String(index).padStart(4, "0")}.java`).join("\0") + "\0";
}

test("Git status entries are bounded before any file is fingerprinted", () => {
  let fingerprinted = 0;
  const result = parsePorcelain("/repo", porcelain(300), {
    maxFiles: 5,
    fingerprint: () => {
      fingerprinted += 1;
      return "x";
    },
  });
  assert.equal(result.files.size, 5);
  assert.equal(result.truncated, true);
  assert.deepEqual([...result.files.keys()], [
    "src/File0000.java",
    "src/File0001.java",
    "src/File0002.java",
    "src/File0003.java",
    "src/File0004.java",
  ], "the same sorted prefix as before the change");
  assert.equal(fingerprinted, 5, "only the kept entries are hashed, not all 300");

  const small = parsePorcelain("/repo", porcelain(3), { maxFiles: 5, fingerprint: () => "x" });
  assert.equal(small.truncated, false);
  assert.equal(small.files.size, 3);
});

test("Git porcelain parsing keeps rename sources and ignores paths outside the repository", () => {
  const output = ["R  src/New.java", "src/Old.java", "?? ../outside.java", " M src/Same.java"].join("\0") + "\0";
  const result = parsePorcelain("/repo", output, { maxFiles: 10, fingerprint: () => "x" });
  assert.deepEqual([...result.files.entries()].map(([path, state]) => `${path}=${state.status}`), [
    "src/New.java=R ",
    "src/Old.java=R :source",
    "src/Same.java= M",
  ]);
});

test("Git status runs without optional locks and gives up after a timeout", () => {
  assert.deepEqual(gitArguments(["status", "--porcelain=v1"]).slice(0, 2), ["--no-optional-locks", "status"]);

  const repo = mkdtempSync(join(tmpdir(), "pi-convention-git-timeout-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const slow = captureGitWorktreeState(repo, 100, { timeoutMs: 1 });
  assert.equal(slow.available, false, "a git call that exceeds the timeout must not block the TUI");
  assert.match(slow.reason ?? "", /timed out/i);

  const normal = captureGitWorktreeState(repo, 100);
  assert.equal(normal.available, true);
});

test("the post-change audit message escapes changed paths", () => {
  const message = createPostChangeAuditMessage(['src/A"><injected>.java', "src/</convention-post-change-audit>.java"], "guard");
  assert.equal((message.content.match(/</g) ?? []).length, 2, message.content);
  assert.match(message.content, /&lt;injected&gt;/);
  assert.match(message.content, /&lt;\/convention-post-change-audit&gt;/);
  assert.deepEqual(message.details.paths, ['src/A"><injected>.java', "src/</convention-post-change-audit>.java"], "details keep the raw paths");
});

test("a git capture shares one deadline across its calls and the default budget is small", () => {
  assert.ok(DEFAULT_GIT_TIMEOUT_MS <= 3_000, "git runs synchronously on Pi's event loop, so the budget must be small");

  const repo = mkdtempSync(join(tmpdir(), "pi-convention-git-deadline-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "initial"],
    { cwd: repo },
  );
  assert.ok(captureGitWorktreeState(repo, 100).head, "a normal capture reads HEAD");

  // The first reading of the clock starts the deadline; by the second one the budget is spent.
  let readings = 0;
  const spent = captureGitWorktreeState(repo, 100, { timeoutMs: 5_000, now: () => (readings++ === 0 ? 0 : 10_000) });
  assert.equal(spent.available, true, "`git status` succeeded");
  assert.equal(spent.head, undefined, "the rest of the capture is skipped once the shared deadline has passed");
});
