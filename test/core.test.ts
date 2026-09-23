import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyStableGuidanceSection,
  buildDynamicContext,
  STABLE_GUIDANCE_MARKER,
  STABLE_GUIDANCE_SECTION,
} from "../src/runtime/context.js";
import { loadSpikeConfig } from "../src/runtime/config.js";
import { evaluateGuard, recordGuardDecision } from "../src/runtime/guard.js";
import { normalizeToolPath } from "../src/runtime/paths.js";
import {
  checkpointState,
  createSpikeState,
  recordToolExecutionStart,
  recordToolResult,
  restoreStateFromBranch,
} from "../src/runtime/state.js";
import { SPIKE_STATE_ENTRY_TYPE } from "../src/runtime/types.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-convention-sense-"));
}

test("project config is ignored until the project is trusted", () => {
  const cwd = tempProject();
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({ mode: "guard", injectContext: false }),
  );

  const untrusted = loadSpikeConfig(cwd, false);
  assert.equal(untrusted.config.mode, "observe");
  assert.equal(untrusted.config.injectContext, true);
  assert.match(untrusted.diagnostics.join("\n"), /not trusted/);

  const trusted = loadSpikeConfig(cwd, true);
  assert.equal(trusted.config.mode, "guard");
  assert.equal(trusted.config.injectContext, false);
  assert.equal(trusted.usedProjectConfig, true);
});

test("invalid config values fall back without throwing", () => {
  const cwd = tempProject();
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({ enabled: "yes", mode: "strict", logPath: "", logging: { level: "verbose" } }),
  );

  const loaded = loadSpikeConfig(cwd, true);
  assert.equal(loaded.config.enabled, true);
  assert.equal(loaded.config.mode, "observe");
  assert.equal(loaded.config.logging.level, "info");
  assert.ok(loaded.diagnostics.length >= 4);
});

test("Observe config validates evidence limits and project analysis fields", () => {
  const cwd = tempProject();
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({
      minEvidenceFiles: 4,
      maxEvidenceFiles: 2,
      maxContextTokens: 600,
      includeLanguages: ["JAVA"],
      exclude: ["**/out/**"],
      logging: { explainRanking: false },
    }),
  );
  const loaded = loadSpikeConfig(cwd, true);
  assert.equal(loaded.config.minEvidenceFiles, 4);
  assert.equal(loaded.config.maxEvidenceFiles, 4);
  assert.equal(loaded.config.maxContextTokens, 600);
  assert.deepEqual(loaded.config.includeLanguages, ["java"]);
  assert.deepEqual(loaded.config.exclude, ["**/out/**"]);
  assert.equal(loaded.config.logging.explainRanking, false);
  assert.match(loaded.diagnostics.join("\n"), /Raised maxEvidenceFiles/);
});

test("a pending sibling read never satisfies guard; only a successful result does", () => {
  const cwd = tempProject();
  const target = join(cwd, "src", "target.ts");
  const state = createSpikeState();
  const config = loadSpikeConfig(cwd, true).config;

  recordToolExecutionStart(
    state,
    { toolCallId: "read-1", toolName: "read", args: { path: "src/target.ts" } },
    cwd,
    1,
  );

  assert.equal(state.pendingReads.size, 1);
  const whilePending = evaluateGuard(config, state, target, true);
  assert.equal(whilePending.action, "wouldBlock");
  assert.equal(whilePending.reasonCode, "TARGET_NOT_READ");

  const success = recordToolResult(
    state,
    {
      toolCallId: "read-1",
      toolName: "read",
      input: { path: "src/target.ts" },
      isError: false,
    },
    cwd,
    2,
  );

  assert.equal(success.successfulReadPath, normalizeToolPath(cwd, "src/target.ts"));
  assert.equal(state.pendingReads.size, 0);
  assert.equal(evaluateGuard(config, state, target, true).action, "allow");
});

test("failed reads do not enter the read ledger", () => {
  const cwd = tempProject();
  const state = createSpikeState();

  recordToolExecutionStart(
    state,
    { toolCallId: "read-failed", toolName: "read", args: { path: "missing.ts" } },
    cwd,
  );
  recordToolResult(
    state,
    {
      toolCallId: "read-failed",
      toolName: "read",
      input: { path: "missing.ts" },
      isError: true,
    },
    cwd,
  );

  assert.equal(state.successfulReads.size, 0);
  assert.equal(state.pendingReads.size, 0);
});

test("guard mode blocks existing unread files but fails open for new files", () => {
  const cwd = tempProject();
  const state = createSpikeState();
  const config = { ...loadSpikeConfig(cwd, true).config, mode: "guard" as const };
  const existing = normalizeToolPath(cwd, "existing.ts");
  const next = normalizeToolPath(cwd, "new.ts");

  const blocked = evaluateGuard(config, state, existing, true);
  recordGuardDecision(state, blocked);
  assert.equal(blocked.action, "block");
  assert.equal(state.guardCounters.block, 1);

  const newFile = evaluateGuard(config, state, next, false);
  recordGuardDecision(state, newFile);
  assert.equal(newFile.action, "allow");
  assert.equal(newFile.reasonCode, "NEW_FILE_BYPASS");
});

test("state restores from the latest checkpoint on the active branch", () => {
  const state = createSpikeState();
  state.successfulReads.add("/repo/a.ts");
  state.recentReads.push({ path: "/repo/a.ts", completedAt: 1 });
  state.guardCounters.wouldBlock = 2;
  const first = checkpointState(state);

  state.successfulReads.add("/repo/b.ts");
  state.recentReads.push({ path: "/repo/b.ts", completedAt: 2 });
  state.guardCounters.block = 1;
  const second = checkpointState(state);

  const restored = restoreStateFromBranch([
    { type: "custom", customType: SPIKE_STATE_ENTRY_TYPE, data: first },
    { type: "message" },
    { type: "custom", customType: SPIKE_STATE_ENTRY_TYPE, data: second },
  ]);

  assert.deepEqual([...restored.successfulReads].sort(), ["/repo/a.ts", "/repo/b.ts"]);
  assert.equal(restored.guardCounters.wouldBlock, 2);
  assert.equal(restored.guardCounters.block, 1);
  assert.equal(restored.pendingReads.size, 0);
  assert.deepEqual(restored.recentReads.map((record) => record.path), ["/repo/a.ts", "/repo/b.ts"]);
  assert.equal(restored.restoredFromCheckpoint, true);
});

test("Stage 0 v1 checkpoints migrate into recent read history", () => {
  const restored = restoreStateFromBranch([
    {
      type: "custom",
      customType: SPIKE_STATE_ENTRY_TYPE,
      data: {
        version: 1,
        successfulReads: ["/repo/legacy.java"],
        mutations: [],
        shellRiskCount: 0,
        guardCounters: { allow: 0, wouldBlock: 1, block: 0 },
      },
    },
  ]);
  assert.equal(restored.restoredFromCheckpoint, true);
  assert.deepEqual(restored.recentReads.map((record) => record.path), ["/repo/legacy.java"]);
});

test("Stage 1 v2 checkpoints migrate with zeroed Stage 2 counters", () => {
  const restored = restoreStateFromBranch([
    {
      type: "custom",
      customType: SPIKE_STATE_ENTRY_TYPE,
      data: {
        version: 2,
        successfulReads: ["/repo/observe.java"],
        recentReads: [{ path: "/repo/observe.java", completedAt: 42 }],
        mutations: [],
        shellRiskCount: 1,
        guardCounters: { allow: 1, wouldBlock: 2, block: 0 },
      },
    },
  ]);
  assert.equal(restored.restoredFromCheckpoint, true);
  assert.equal(restored.recentReads[0]?.completedAt, 42);
  assert.equal(restored.bypassCount, 0);
  assert.equal(restored.postChangeAuditCount, 0);
  assert.equal(restored.postChangeGapCount, 0);
});

test("stable guidance is idempotent and dynamic context disclaims real evidence", () => {
  const sections: Record<string, string> = {};
  applyStableGuidanceSection(sections);
  applyStableGuidanceSection(sections);
  assert.equal(Object.keys(sections).length, 1);
  const stableSection = sections[STABLE_GUIDANCE_SECTION];
  assert.ok(stableSection);
  assert.equal(stableSection.split(STABLE_GUIDANCE_MARKER).length - 1, 1);

  const context = buildDynamicContext(loadSpikeConfig(tempProject(), true).config, createSpikeState());
  assert.match(context, /No valid convention snapshot/);
  assert.match(context, /Do not infer a convention/);
});
