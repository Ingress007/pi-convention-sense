// The Guard decision table. The product rule is that Guard only blocks a Discovery gap the agent can still close:
// everything else (style differences, unsupported or uncertain situations) must fail open.
import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateConventionGuard,
  formatGuardBlockReason,
  type ConventionGuardDecision,
  type ConventionGuardInput,
  type ConventionGuardReason,
} from "../src/guard/convention-guard.js";
import { createDefaultConfig } from "../src/runtime/config.js";
import type { ConventionSnapshot } from "../src/observe/types.js";

const TARGET = "/repo/order/OrderServiceImpl.java";
const GAP_REASONS: ConventionGuardReason[] = ["TARGET_NOT_READ", "SNAPSHOT_MISSING", "SNAPSHOT_STALE", "SNAPSHOT_NOT_INJECTED"];

type SnapshotKind = "none" | "stale" | "low-confidence" | "unknown-role" | "no-peers" | "one-peer" | "weak" | "valid";
const SNAPSHOT_KINDS: SnapshotKind[] = ["none", "stale", "low-confidence", "unknown-role", "no-peers", "one-peer", "weak", "valid"];

function snapshotOf(kind: SnapshotKind): ConventionSnapshot | undefined {
  if (kind === "none") return undefined;
  const peers = kind === "no-peers" ? 0 : kind === "one-peer" ? 1 : 3;
  return {
    scope: {
      language: "java",
      module: "order",
      role: kind === "unknown-role" ? "unknown" : "service-impl",
      root: "/repo",
      confidence: kind === "low-confidence" ? "low" : "high",
    } as ConventionSnapshot["scope"],
    repositoryRoot: "/repo",
    targetPath: TARGET,
    targetKind: "existing",
    targetMtimeMs: 0,
    targetSize: 1,
    targetHash: "h",
    observations: [],
    evidenceFiles: Array.from({ length: peers }, (_value, index) => ({ path: `/repo/order/Peer${index}.java`, mtimeMs: 0, size: 1, contentHash: "h", score: 1 })),
    candidates: Array.from({ length: peers }, (_value, index) => ({ path: `/repo/order/Peer${index}.java` }) as ConventionSnapshot["candidates"][number]),
    createdAt: 0,
    status: kind === "stale" ? "stale" : kind === "weak" ? "weak" : "valid",
    tokenEstimate: 1,
    analyzerVersion: "v",
    configFingerprint: "fp",
  };
}

function input(overrides: Partial<ConventionGuardInput> & { mode?: "observe" | "guard"; kind?: SnapshotKind } = {}): ConventionGuardInput {
  const { mode, kind, ...rest } = overrides;
  const config = createDefaultConfig();
  config.mode = mode ?? "guard";
  const snapshot = snapshotOf(kind ?? "valid");
  return {
    config,
    targetPath: TARGET,
    targetExists: true,
    targetRead: true,
    ...(snapshot ? { snapshot } : {}),
    snapshotInjected: true,
    bypassGranted: false,
    ...rest,
  };
}

function reason(overrides: Parameters<typeof input>[0] = {}): [string, ConventionGuardReason] {
  const decision = evaluateConventionGuard(input(overrides));
  return [decision.action, decision.reasonCode];
}

test("the happy path and each documented fail-open or gap reason", () => {
  assert.deepEqual(reason(), ["allow", "SNAPSHOT_VALID"]);
  assert.deepEqual(reason({ kind: "valid", snapshotInjected: false }), ["block", "SNAPSHOT_NOT_INJECTED"]);
  assert.deepEqual(reason({ targetRead: false }), ["block", "TARGET_NOT_READ"]);
  assert.deepEqual(reason({ kind: "none" }), ["block", "SNAPSHOT_MISSING"]);
  assert.deepEqual(reason({ kind: "stale" }), ["block", "SNAPSHOT_STALE"]);
  assert.deepEqual(reason({ kind: "low-confidence" }), ["allow", "SCOPE_LOW_CONFIDENCE"]);
  assert.deepEqual(reason({ kind: "unknown-role" }), ["allow", "SCOPE_LOW_CONFIDENCE"]);
  assert.deepEqual(reason({ kind: "no-peers" }), ["allow", "NO_PEERS_AVAILABLE"]);
  assert.deepEqual(reason({ kind: "one-peer" }), ["allow", "INSUFFICIENT_PEERS_AVAILABLE"]);
  assert.deepEqual(reason({ kind: "weak" }), ["allow", "SNAPSHOT_WEAK_DISCOVERY_COMPLETE"]);
  assert.deepEqual(reason({ analysisReason: "scope-unknown" }), ["allow", "SCOPE_UNKNOWN"]);
  assert.deepEqual(reason({ analysisReason: "analysis-error" }), ["allow", "ANALYSIS_FAILED_OPEN"]);
  assert.deepEqual(reason({ unsupportedLanguage: true }), ["allow", "UNSUPPORTED_LANGUAGE"]);
  assert.deepEqual(reason({ targetExcluded: true }), ["allow", "TARGET_EXCLUDED"]);
  assert.deepEqual(reason({ pathException: true }), ["allow", "PATH_EXCEPTION"]);
});

test("a new file is not a Discovery gap and never needs a prior read", () => {
  assert.deepEqual(reason({ targetExists: false, targetRead: false, kind: "valid" }), ["allow", "SNAPSHOT_VALID"]);
  assert.deepEqual(reason({ targetExists: false, targetRead: false, kind: "none" }), ["block", "SNAPSHOT_MISSING"]);
});

test("observe mode reports the same gaps as wouldBlock and never blocks", () => {
  assert.deepEqual(reason({ mode: "observe", targetRead: false }), ["wouldBlock", "TARGET_NOT_READ"]);
  assert.deepEqual(reason({ mode: "observe", kind: "stale" }), ["wouldBlock", "SNAPSHOT_STALE"]);
  assert.match(evaluateConventionGuard(input({ mode: "observe", targetRead: false })).message, /^Observe would block/);
  assert.match(evaluateConventionGuard(input({ mode: "guard", targetRead: false })).message, /^Convention Guard blocked/);
});

test("earlier reasons win over later ones", () => {
  const config = createDefaultConfig();
  config.enabled = false;
  assert.equal(evaluateConventionGuard({ ...input({ unsupportedLanguage: true, targetRead: false }), config }).reasonCode, "EXTENSION_DISABLED");
  assert.equal(reason({ unsupportedLanguage: true, targetExcluded: true, pathException: true, targetRead: false })[1], "UNSUPPORTED_LANGUAGE");
  assert.equal(reason({ targetExcluded: true, pathException: true, targetRead: false })[1], "TARGET_EXCLUDED");
  assert.equal(reason({ pathException: true, bypassGranted: true, targetRead: false })[1], "PATH_EXCEPTION");
  // An unread target is a Discovery gap even if the later analysis would have failed open.
  assert.equal(reason({ targetRead: false, analysisReason: "scope-unknown" })[1], "TARGET_NOT_READ");
  assert.equal(reason({ analysisReason: "scope-unknown", kind: "none" })[1], "SCOPE_UNKNOWN");
  assert.equal(reason({ kind: "stale", analysisReason: "analysis-error" })[1], "ANALYSIS_FAILED_OPEN");
});

test("a bypass only works in guard mode with bypass enabled, and only turns a gap into an allow", () => {
  assert.deepEqual(reason({ bypassGranted: true, targetRead: false }), ["allow", "BYPASS_GRANTED"]);
  assert.deepEqual(reason({ bypassGranted: true, mode: "observe", targetRead: false }), ["wouldBlock", "TARGET_NOT_READ"], "observe mode has no bypass");

  const noBypass = input({ bypassGranted: true, targetRead: false });
  noBypass.config.guard.allowBypass = false;
  const decision = evaluateConventionGuard(noBypass);
  assert.equal(decision.reasonCode, "TARGET_NOT_READ");
  assert.equal(decision.bypassAvailable, false, "the bypass hint is not offered when bypass is disabled");
  assert.equal(evaluateConventionGuard(input({ targetRead: false })).bypassAvailable, true);
  assert.equal(evaluateConventionGuard(input()).bypassAvailable, false, "only gaps offer a bypass");
});

test("requireRecentContext off lets a valid Snapshot through without a recent injection", () => {
  const relaxed = input({ snapshotInjected: false });
  relaxed.config.guard.requireRecentContext = false;
  assert.equal(evaluateConventionGuard(relaxed).reasonCode, "SNAPSHOT_VALID");
});

test("the minimum peer count follows the configuration", () => {
  const strict = input({ kind: "valid" });
  strict.config.minEvidenceFiles = 4;
  assert.equal(evaluateConventionGuard(strict).reasonCode, "INSUFFICIENT_PEERS_AVAILABLE", "3 peers < 4 required");
  strict.config.minEvidenceFiles = 3;
  assert.equal(evaluateConventionGuard(strict).reasonCode, "SNAPSHOT_VALID");
});

test("decisions carry the scope and the suggested peers", () => {
  const decision = evaluateConventionGuard(input({ targetRead: false }));
  assert.equal(decision.scope?.module, "order");
  assert.deepEqual(decision.suggestedPeers, ["/repo/order/Peer0.java", "/repo/order/Peer1.java", "/repo/order/Peer2.java"]);
  const bare = evaluateConventionGuard(input({ kind: "none", targetRead: false }));
  assert.equal(bare.scope, undefined);
  assert.deepEqual(bare.suggestedPeers, []);
});

test("every input combination obeys the Guard contract", () => {
  const booleans = [false, true];
  const seen = new Set<ConventionGuardReason>();
  let combinations = 0;
  for (const mode of ["observe", "guard"] as const)
    for (const enabled of booleans)
      for (const kind of SNAPSHOT_KINDS)
        for (const analysisReason of [undefined, "scope-unknown", "analysis-error", "target-excluded"] as const)
          for (const flags of Array.from({ length: 128 }, (_value, bits) => bits)) {
            const bit = (position: number): boolean => ((flags >> position) & 1) === 1;
            const targetExists = bit(0);
            const targetRead = bit(1);
            const snapshotInjected = bit(2);
            const bypassGranted = bit(3);
            const unsupportedLanguage = bit(4);
            const targetExcluded = bit(5);
            const pathException = bit(6);
            const value = input({
              mode, kind, targetExists, targetRead, snapshotInjected, bypassGranted, unsupportedLanguage, targetExcluded, pathException,
              ...(analysisReason ? { analysisReason } : {}),
            });
            value.config.enabled = enabled;
            const decision: ConventionGuardDecision = evaluateConventionGuard(value);
            combinations += 1;
            seen.add(decision.reasonCode);
            const label = JSON.stringify({ mode, enabled, kind, analysisReason, flags });

            if (decision.action === "block") {
              assert.equal(mode, "guard", `observe mode blocked: ${label}`);
              assert.ok(GAP_REASONS.includes(decision.reasonCode), `blocked for a non-Discovery reason ${decision.reasonCode}: ${label}`);
            }
            if (decision.action === "wouldBlock") {
              assert.equal(mode, "observe", `guard mode only reports: ${label}`);
              assert.ok(GAP_REASONS.includes(decision.reasonCode), `wouldBlock for a non-Discovery reason: ${label}`);
            }
            if (GAP_REASONS.includes(decision.reasonCode)) {
              assert.ok(decision.action === "block" || decision.action === "wouldBlock", `a gap was allowed: ${label}`);
              assert.equal(decision.bypassAvailable, true, `a gap must offer the bypass in this configuration: ${label}`);
            } else {
              assert.equal(decision.action, "allow", `a non-gap reason must allow: ${label}`);
            }
            // Fail-open situations never block, whatever else is true.
            if (!enabled || unsupportedLanguage || targetExcluded || pathException) {
              assert.equal(decision.action, "allow", `fail-open situation blocked: ${label}`);
            }
            assert.equal(decision.targetPath, TARGET);
            assert.ok(decision.message.length > 0);
          }
  assert.equal(combinations, 2 * 2 * 8 * 4 * 128);
  assert.deepEqual([...seen].sort(), [
    "ANALYSIS_FAILED_OPEN", "BYPASS_GRANTED", "EXTENSION_DISABLED", "INSUFFICIENT_PEERS_AVAILABLE", "NO_PEERS_AVAILABLE",
    "PATH_EXCEPTION", "SCOPE_LOW_CONFIDENCE", "SCOPE_UNKNOWN", "SNAPSHOT_MISSING", "SNAPSHOT_NOT_INJECTED",
    "SNAPSHOT_STALE", "SNAPSHOT_VALID", "SNAPSHOT_WEAK_DISCOVERY_COMPLETE", "TARGET_EXCLUDED", "TARGET_NOT_READ",
    "UNSUPPORTED_LANGUAGE",
  ], "every reason code is reachable");
});

test("the block message names the peers, the bypass command and the reason code", () => {
  const decision = evaluateConventionGuard(input({ targetRead: false }));
  const text = formatGuardBlockReason(decision, "order/OrderServiceImpl.java", (path) => path.replace("/repo/", ""));
  assert.match(text, /Convention Guard blocked this modification\./);
  assert.match(text, /Suggested peers: order\/Peer0\.java, order\/Peer1\.java, order\/Peer2\.java\./);
  assert.match(text, / To bypass once, run \/convention-bypass order\/OrderServiceImpl\.java/);
  assert.ok(text.endsWith("[TARGET_NOT_READ]"));

  const many = input({ targetRead: false });
  const snapshot = many.snapshot;
  assert.ok(snapshot);
  snapshot.candidates = Array.from({ length: 9 }, (_value, index) => ({ path: `/repo/p${index}.java` }) as ConventionSnapshot["candidates"][number]);
  const limited = formatGuardBlockReason(evaluateConventionGuard(many), "t");
  assert.equal(limited.match(/p\d\.java/g)?.length, 4, "at most four peers are suggested");

  // Only gaps offer a bypass; the text of any other decision never mentions one.
  assert.ok(!formatGuardBlockReason(evaluateConventionGuard(input()), "t").includes("bypass"));
});
