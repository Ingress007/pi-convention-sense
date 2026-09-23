import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { evaluateConventionGuard } from "../src/guard/convention-guard.js";
import { PostChangeAuditRuntime } from "../src/guard/post-change-audit.js";
import { GuardRuntime } from "../src/guard/runtime.js";
import { resolveToolMapping } from "../src/guard/tool-mapping.js";
import { ObserveAnalyzer } from "../src/observe/analyzer.js";
import { createDefaultConfig, loadSpikeConfig } from "../src/runtime/config.js";

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
  assert.equal(runtime.isRecentlyInjected({ ...snapshot, createdAt: snapshot.createdAt + 1 }, config, 6, 2_000), false);
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
