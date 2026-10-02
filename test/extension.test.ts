import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { registerConventionSenseSpike } from "../extensions/index.js";
import { MAX_ANALYZED_FILE_BYTES } from "../src/observe/limits.js";
import { loadProjectProfile } from "../src/profile/profile-loader.js";
import { isCaseInsensitivePlatform } from "../src/runtime/path-key.js";
import { SPIKE_STATE_ENTRY_TYPE } from "../src/runtime/types.js";
import { assertNoSwallowedHandlerErrors, createHarness, type Harness } from "./support/fake-pi.js";

afterEach(assertNoSwallowedHandlerErrors);

function javaTarget(root = ""): string {
  return join(
    root,
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
}

function writeGuardConfig(cwd: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({ mode: "guard", injectContext: true, persistSessionState: true, ...extra }),
  );
}

test("extension registers the required Stage 2 lifecycle hooks and commands", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-extension-"));
  const harness = createHarness(cwd);
  registerConventionSenseSpike(harness.api);

  for (const name of [
    "session_start",
    "session_tree",
    "session_shutdown",
    "before_agent_start",
    "context",
    "agent_start",
    "agent_end",
    "agent_before_settle",
    "agent_settled",
    "turn_start",
    "turn_end",
    "tool_execution_start",
    "tool_call",
    "tool_result",
    "tool_execution_end",
  ]) {
    assert.ok(harness.handlers.has(name), `missing handler: ${name}`);
  }
  for (const command of [
    "convention-status",
    "convention-reset",
    "convention-snapshot",
    "convention-bypass",
    "convention-audit",
  ]) {
    assert.ok(harness.commands.has(command), `missing command: ${command}`);
  }
});

test("convention-snapshot empty state is language-neutral", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-snapshot-command-"));
  const harness = createHarness(cwd);
  registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  const snapshotCommand = harness.commands.get("convention-snapshot");
  assert.ok(snapshotCommand);
  await snapshotCommand("", harness.ctx);

  const notification = harness.notifications.at(-1) ?? "";
  assert.equal(notification, "No convention Snapshot is available on the active branch.");
  assert.doesNotMatch(notification, /Java/);
});

test("Guard blocks a pending read, releases confirmed no-peer targets, and keeps logs private", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-extension-"));
  const target = join("src", "main", "java", "com", "acme", "demo", "service", "impl", "DemoServiceImpl.java");
  mkdirSync(join(cwd, "src", "main", "java", "com", "acme", "demo", "service", "impl"), { recursive: true });
  writeFileSync(join(cwd, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  writeFileSync(join(cwd, target), "package com.acme.demo.service.impl; public class DemoServiceImpl {}\n");
  writeGuardConfig(cwd);

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  const promptEvent = {
    type: "before_agent_start",
    prompt: "change target",
    systemPrompt: "base-system",
    systemPromptOptions: {
      selectedTools: ["read", "edit", "write"],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {} as Record<string, string>,
      contextFiles: [],
      skills: [],
    },
  };
  const promptResult = await harness.invoke("before_agent_start", promptEvent);
  assert.equal(promptResult, undefined);
  const stableSection = promptEvent.systemPromptOptions.sections["pi-convention-sense"];
  assert.ok(stableSection);
  assert.match(stableSection, /Local Convention Evidence/);

  const entryCountBeforeContext = harness.branchEntries.length;
  const emptyContext = await harness.invoke("context", { type: "context", messages: [] });
  assert.match(emptyContext.messages.at(-1).content, /No valid convention snapshot/);
  assert.equal(harness.branchEntries.length, entryCountBeforeContext);

  await harness.invoke("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "read-1",
    toolName: "read",
    args: { path: target },
  });
  const blockedWhilePending = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "edit-1",
    toolName: "edit",
    input: { path: target, edits: [{ oldText: "DemoServiceImpl", newText: "DemoServiceImpl" }] },
  });
  assert.equal(blockedWhilePending.block, true);
  assert.match(blockedWhilePending.reason, /TARGET_NOT_READ/);

  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "read-1",
    toolName: "read",
    input: { path: target },
    content: [{ type: "text", text: "SECRET_SOURCE_CONTENT" }],
    details: undefined,
    isError: false,
  });
  assert.equal(
    harness.branchEntries.some((entry) => entry.customType === SPIKE_STATE_ENTRY_TYPE),
    false,
    "the checkpoint is flushed when the run settles, not after every tool result",
  );
  assert.equal(runtime.getSnapshotCache().list()[0]?.status, "weak");

  const allowedNoPeers = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "edit-2",
    toolName: "edit",
    input: { path: target, edits: [{ oldText: "DemoServiceImpl", newText: "DemoServiceImpl" }] },
  });
  assert.equal(allowedNoPeers, undefined);

  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "write-1",
    toolName: "write",
    input: { path: target, content: "SECRET_WRITE_CONTENT" },
    content: [{ type: "text", text: "ok" }],
    details: undefined,
    isError: false,
  });
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "bash-1",
    toolName: "bash",
    input: { command: "printf SECRET_COMMAND > generated.txt" },
    content: [{ type: "text", text: "ok" }],
    details: undefined,
    isError: false,
  });
  await harness.invoke("agent_settled", { type: "agent_settled" });
  assert.ok(harness.branchEntries.some((entry) => entry.customType === SPIKE_STATE_ENTRY_TYPE));

  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  assert.doesNotMatch(log, /SECRET_SOURCE_CONTENT|SECRET_WRITE_CONTENT|SECRET_COMMAND/);
  assert.match(log, /"reasonCode":"TARGET_NOT_READ"/);
  assert.match(log, /"reasonCode":"NO_PEERS_AVAILABLE"/);
  assert.match(log, /"mutationRiskTags":\["redirect"\]/);

  harness.branchEntries.splice(0, harness.branchEntries.length);
  await harness.invoke("session_tree", {
    type: "session_tree",
    oldLeafId: "leaf-1",
    newLeafId: "older-leaf",
  });
  assert.equal(runtime.getState().successfulReads.size, 0);
  const blockedAfterTree = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "edit-3",
    toolName: "edit",
    input: { path: target, edits: [{ oldText: "DemoServiceImpl", newText: "DemoServiceImpl" }] },
  });
  assert.equal(blockedAfterTree.block, true);

  const statusCommand = harness.commands.get("convention-status");
  assert.ok(statusCommand);
  await statusCommand("", harness.ctx);
  const statusText = harness.notifications.at(-1) ?? "";
  assert.match(statusText, /pi-convention-sense V1 Guard/);
  assert.match(statusText, /config-source=project/);
  assert.match(statusText, /profile=missing/);
  assert.match(statusText, /packs=none/);
});

test("convention-reset requires confirmation and clears current-branch runtime state", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-reset-"));
  const target = join("src", "main", "java", "com", "acme", "demo", "service", "impl", "DemoServiceImpl.java");
  const absoluteTarget = join(cwd, target);
  mkdirSync(resolve(absoluteTarget, ".."), { recursive: true });
  writeFileSync(join(cwd, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  writeFileSync(absoluteTarget, "package com.acme.demo.service.impl; public class DemoServiceImpl {}\n");

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "reset-read",
    toolName: "read",
    input: { path: target },
    content: [],
    details: undefined,
    isError: false,
  });
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "reset-edit",
    toolName: "edit",
    input: { path: target, edits: [] },
    content: [],
    details: undefined,
    isError: false,
  });
  runtime.getGuardRuntime().grantBypass(absoluteTarget);
  runtime.getPostChangeAuditRuntime().addGap(absoluteTarget);

  assert.equal(runtime.getState().successfulReads.size, 1);
  assert.equal(runtime.getState().mutations.length, 1);
  assert.equal(runtime.getSnapshotCache().list().length, 1);
  assert.equal(runtime.getGuardRuntime().hasBypass(absoluteTarget), true);
  assert.equal(runtime.getPostChangeAuditRuntime().all().length, 1);

  const resetCommand = harness.commands.get("convention-reset");
  assert.ok(resetCommand);
  await resetCommand("", harness.ctx);
  assert.match(harness.notifications.at(-1) ?? "", /Usage: \/convention-reset confirm/);
  assert.equal(runtime.getState().successfulReads.size, 1);

  await resetCommand("confirm", harness.ctx);
  assert.equal(runtime.getState().successfulReads.size, 0);
  assert.equal(runtime.getState().recentReads.length, 0);
  assert.equal(runtime.getState().pendingReads.size, 0);
  assert.equal(runtime.getState().mutations.length, 0);
  assert.equal(runtime.getSnapshotCache().list().length, 0);
  assert.equal(runtime.getGuardRuntime().hasBypass(absoluteTarget), false);
  assert.equal(runtime.getPostChangeAuditRuntime().all().length, 0);
  assert.match(harness.notifications.at(-1) ?? "", /current-branch state reset/);

  const checkpoint = [...harness.branchEntries]
    .reverse()
    .find((entry) => entry.customType === SPIKE_STATE_ENTRY_TYPE);
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.data.successfulReads, []);
  assert.deepEqual(checkpoint.data.recentReads, []);

  await harness.invoke("session_tree", {
    type: "session_tree",
    oldLeafId: "leaf-1",
    newLeafId: "reset-leaf",
  });
  assert.equal(runtime.getState().successfulReads.size, 0);
  assert.equal(runtime.getSnapshotCache().list().length, 0);

  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  assert.match(log, /"event":"runtime_reset"/);
});

test("Observe extension builds, injects, and branch-rebuilds a real Java Snapshot", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-observe-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  const target = javaTarget();

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  assert.equal(runtime.getConfig().mode, "observe");

  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "read-java",
    toolName: "read",
    input: { path: target },
    content: [{ type: "text", text: "source omitted" }],
    details: undefined,
    isError: false,
  });
  const snapshot = runtime.getSnapshotCache().list()[0];
  assert.ok(snapshot);
  assert.equal(snapshot.status, "valid");
  assert.equal(snapshot.scope.module, "order");
  assert.equal(snapshot.candidates.length, 3);

  const contextResult = await harness.invoke("context", { type: "context", messages: [] });
  const injected = contextResult.messages.at(-1);
  assert.match(injected.content, /scope="java:order:service-impl"/);
  assert.match(injected.content, /dependency-injection: constructor \(2\/3/);

  const decision = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "edit-java",
    toolName: "edit",
    input: { path: target, edits: [{ oldText: "OrderService", newText: "OrderService" }] },
  });
  assert.equal(decision, undefined);
  assert.equal(runtime.getState().guardCounters.allow, 1);

  await harness.invoke("agent_settled", { type: "agent_settled" });
  const firstBranch = harness.branchEntries.slice();
  const paymentTarget = target.replace("OrderServiceImpl.java", "PaymentServiceImpl.java");
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "read-payment",
    toolName: "read",
    input: { path: paymentTarget },
    content: [{ type: "text", text: "source omitted" }],
    details: undefined,
    isError: false,
  });
  assert.equal(runtime.getSnapshotCache().list().length, 2);
  const deduplicatedContext = await harness.invoke("context", { type: "context", messages: [] });
  const deduplicatedContent = deduplicatedContext.messages.at(-1).content as string;
  assert.equal(
    (deduplicatedContent.match(/<local-convention scope="java:order:service-impl"/g) ?? []).length,
    1,
    "only the newest Snapshot for a Scope should be injected",
  );
  assert.match(deduplicatedContent, /PaymentServiceImpl\.java/);

  harness.branchEntries.splice(0, harness.branchEntries.length, ...firstBranch);
  await harness.invoke("session_tree", {
    type: "session_tree",
    oldLeafId: "second-java-read",
    newLeafId: "first-java-read",
  });
  const rebuilt = runtime.getSnapshotCache().list();
  assert.equal(rebuilt.length, 1);
  assert.ok(rebuilt[0]?.targetPath.endsWith("OrderServiceImpl.java"));
  assert.equal(runtime.getState().recentReads.length, 1);
});

test("Practice suggest mode injects bounded advisory questions without changing Guard", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-practice-extension-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  const target = javaTarget();
  writeFileSync(
    join(cwd, target),
    `
      package com.acme.order.service.impl;
      import org.springframework.transaction.annotation.Transactional;
      public class OrderServiceImpl {
        @Transactional
        public void approve(Order order) {
          validateOrder(order);
          order.setStatus(APPROVED);
          orderMapper.update(order);
          notificationGateway.publish(order);
        }
      }
    `,
  );

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  assert.equal(runtime.getConfig().practiceReview.mode, "suggest");

  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "practice-read",
    toolName: "read",
    input: { path: target },
    content: [],
    details: undefined,
    isError: false,
  });
  const context = await harness.invoke("context", { type: "context", messages: [] });
  const message = context.messages.at(-1);
  const content = String(message.content ?? "");
  assert.match(content, /<local-convention/);
  assert.match(content, /<engineering-practice status="advisory">/);
  assert.match(content, /partial failure/i);
  assert.match(content, /Comments that restate the code/);
  assert.ok(message.details.includedPracticeSignalIds.includes("practice.transaction-side-effect"));
  assert.ok(message.details.tokenEstimate <= runtime.getConfig().maxContextTokens);

  const editDecision = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "practice-edit",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(editDecision, undefined);

  const statusCommand = harness.commands.get("convention-status");
  assert.ok(statusCommand);
  await statusCommand("", harness.ctx);
  assert.match(harness.notifications.at(-1) ?? "", /practice=suggest, practice-tokens=400/);

  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  assert.match(log, /"practiceSignalCount":3/);
  assert.match(log, /practice\.transaction-side-effect/);
  assert.doesNotMatch(log, /notificationGateway\.publish|partial failure/);

  await harness.invoke("agent_settled", { type: "agent_settled" });
  const activeBranch = [...harness.branchEntries];
  harness.branchEntries.splice(0);
  await harness.invoke("session_tree", {
    type: "session_tree",
    oldLeafId: "practice-branch",
    newLeafId: "empty-branch",
  });
  const isolatedBranch = await harness.invoke("context", { type: "context", messages: [] });
  assert.doesNotMatch(String(isolatedBranch.messages.at(-1).content ?? ""), /engineering-practice/);

  harness.branchEntries.splice(0, harness.branchEntries.length, ...activeBranch);
  await harness.invoke("session_tree", {
    type: "session_tree",
    oldLeafId: "empty-branch",
    newLeafId: "practice-branch",
  });
  const restoredBranch = await harness.invoke("context", { type: "context", messages: [] });
  assert.match(String(restoredBranch.messages.at(-1).content ?? ""), /engineering-practice/);

  const separateSession = createHarness(cwd);
  registerConventionSenseSpike(separateSession.api);
  await separateSession.invoke("session_start", { type: "session_start", reason: "startup" });
  const isolatedSession = await separateSession.invoke("context", { type: "context", messages: [] });
  assert.doesNotMatch(String(isolatedSession.messages.at(-1).content ?? ""), /engineering-practice/);
});

test("Practice auto-once continues the current Agent once and resets by task and Branch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-practice-auto-once-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  const target = javaTarget();
  const absoluteTarget = join(cwd, target);
  writeGuardConfig(cwd, {
    maxContextTokens: 1800,
    practiceReview: { mode: "auto-once", maxContextTokens: 400 },
  });
  writeFileSync(
    absoluteTarget,
    `
      package com.acme.order.service.impl;
      import org.springframework.transaction.annotation.Transactional;
      public class OrderServiceImpl {
        @Transactional
        public void approve(Order order) {
          validateOrder(order);
          order.setStatus(APPROVED);
          orderMapper.update(order);
          notificationGateway.publish(order);
        }
      }
    `,
  );
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial"],
    { cwd },
  );

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  assert.equal(runtime.getConfig().practiceReview.mode, "auto-once");

  const startTask = async () => harness.invoke("before_agent_start", {
    type: "before_agent_start",
    prompt: "update the order flow",
    systemPrompt: "base-system",
    systemPromptOptions: {
      selectedTools: ["read", "edit", "bash"],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {} as Record<string, string>,
      contextFiles: [],
      skills: [],
    },
  });
  const settleEvent = (
    canContinue = true,
    entries: any[] = [],
    outcome: "completed" | "aborted" | "error" = "completed",
  ) => ({
    type: "agent_before_settle",
    entries,
    continue: false,
    outcome,
    context: {
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue,
    },
  });

  await startTask();
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "auto-read",
    toolName: "read",
    input: { path: target },
    content: [],
    details: undefined,
    isError: false,
  });
  const context = await harness.invoke("context", { type: "context", messages: [] });
  const autoContextMessage = context.messages.at(-1);
  assert.match(String(autoContextMessage.content ?? ""), /local-convention/);
  assert.deepEqual(
    autoContextMessage.details.includedPracticeSignalIds,
    [],
    "auto-once must not duplicate suggest Capsule analysis in ordinary Context",
  );

  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "auto-trivial-edit",
    toolName: "edit",
    input: {
      path: target,
      edits: [{ oldText: "SECRET_AUTO_DIFF", newText: "SECRET_AUTO_REPLACEMENT" }],
    },
    content: [],
    details: undefined,
    isError: false,
  });
  const trivialReview = await harness.invoke("agent_before_settle", settleEvent());
  assert.equal(trivialReview, undefined, "a marker-free edit must not review an unrelated complex flow");

  await startTask();
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "auto-relevant-edit",
    toolName: "edit",
    input: {
      path: target,
      edits: [{
        oldText: "notificationGateway.publish(order);",
        newText: "notificationGateway.publishApproved(order);",
      }],
    },
    content: [],
    details: undefined,
    isError: false,
  });
  const priorDraft = { type: "custom", customType: "prior-extension", data: { safe: true } };
  const firstReview = await harness.invoke("agent_before_settle", settleEvent(false, [priorDraft]));
  assert.equal(firstReview.continue, true);
  assert.equal(firstReview.entries.length, 2);
  assert.deepEqual(firstReview.entries[0], priorDraft, "earlier boundary drafts must be preserved");
  const reviewEntry = firstReview.entries[1];
  assert.equal(reviewEntry.type, "custom_message");
  assert.equal(reviewEntry.customType, "pi-convention-sense-practice-review");
  assert.equal(reviewEntry.display, false);
  assert.match(reviewEntry.content, /one concise final self-review/i);
  assert.match(reviewEntry.content, /partial failure/i);
  assert.doesNotMatch(reviewEntry.content, /notificationGateway\.publish|SECRET_AUTO/);
  assert.ok(reviewEntry.details.tokenEstimate <= 400);

  const loopAttempt = await harness.invoke("agent_before_settle", settleEvent());
  assert.equal(loopAttempt, undefined, "the continuation must not schedule another review");

  await startTask();
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "auto-lsp",
    toolName: "lsp",
    input: { path: target },
    content: [],
    details: undefined,
    isError: false,
  });
  const noMutation = await harness.invoke("agent_before_settle", settleEvent());
  assert.equal(noMutation, undefined, "pi-lens diagnostics are not mutations");

  await startTask();
  const shellCommand = "node -e \"require('fs').writeFileSync('target','changed')\"";
  await harness.invoke("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "auto-shell",
    toolName: "bash",
    args: { command: shellCommand },
  });
  writeFileSync(absoluteTarget, `${readFileSync(absoluteTarget, "utf8")}\n// shell mutation\n`);
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "auto-shell",
    toolName: "bash",
    input: { command: shellCommand },
    content: [],
    details: undefined,
    isError: false,
  });
  const shellReview = await harness.invoke("agent_before_settle", settleEvent());
  assert.equal(shellReview.continue, true, "a detected shell source mutation should participate");

  await startTask();
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "branch-edit",
    toolName: "edit",
    input: {
      path: target,
      edits: [{
        oldText: "notificationGateway.publish(order);",
        newText: "notificationGateway.publishApproved(order);",
      }],
    },
    content: [],
    details: undefined,
    isError: false,
  });
  harness.branchEntries.splice(0);
  await harness.invoke("session_tree", {
    type: "session_tree",
    oldLeafId: "practice-auto-branch",
    newLeafId: "empty-branch",
  });
  const branchReview = await harness.invoke("agent_before_settle", settleEvent());
  assert.equal(branchReview, undefined, "review generation must not cross Branches");

  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  assert.match(log, /"event":"practice_review_decision"/);
  assert.match(log, /"action":"continue"/);
  assert.match(log, /"reason":"already-requested"/);
  assert.match(log, /"reason":"no-relevant-mutation"/);
  assert.doesNotMatch(
    log,
    /SECRET_AUTO_DIFF|SECRET_AUTO_REPLACEMENT|notificationGateway\.publishApproved|partial failure/,
  );
});

test("scope-unknown Practice fallback stays read-bound, advisory, and one-shot", async () => {
  const createProject = (prefix: string, practiceMode: "suggest" | "auto-once") => {
    const cwd = mkdtempSync(join(tmpdir(), prefix));
    const sourceRoot = join(cwd, "src", "main", "java", "com", "acme", "provider");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(cwd, "pom.xml"), "<project/>\n");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "convention-sense.json"),
      JSON.stringify({
        mode: "observe",
        injectContext: true,
        includeLanguages: ["java"],
        practiceReview: { mode: practiceMode, maxContextTokens: 400 },
      }),
    );
    return { cwd, sourceRoot };
  };
  const readResult = (path: string, id: string) => ({
    type: "tool_result",
    toolCallId: id,
    toolName: "read",
    input: { path },
    content: [],
    details: undefined,
    isError: false,
  });

  const suggestProject = createProject("pi-convention-practice-scope-unknown-suggest-", "suggest");
  const suggestTarget = join(suggestProject.sourceRoot, "ProviderRouter.java");
  writeFileSync(
    suggestTarget,
    "class ProviderRouter { Object route(int type) { switch (type) { case 1: return a(); case 2: return b(); case 3: return c(); default: return d(); } } }\n",
  );
  const suggestHarness = createHarness(suggestProject.cwd);
  const suggestRuntime = registerConventionSenseSpike(suggestHarness.api);
  await suggestHarness.invoke("session_start", { type: "session_start", reason: "startup" });
  await suggestHarness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "fallback-suggest-unread-edit",
    toolName: "edit",
    input: { path: suggestTarget, edits: [] },
  });
  const unreadContext = await suggestHarness.invoke("context", { type: "context", messages: [] });
  assert.doesNotMatch(
    String(unreadContext.messages.at(-1).content ?? ""),
    /engineering-practice/,
    "scope-unknown without a successful read must not activate fallback",
  );
  await suggestHarness.invoke("tool_result", readResult(suggestTarget, "fallback-suggest-read"));
  assert.equal(suggestRuntime.getSnapshotCache().list().length, 0, "fallback must not fabricate a Snapshot");
  const suggestContext = await suggestHarness.invoke("context", { type: "context", messages: [] });
  const suggestMessage = suggestContext.messages.at(-1);
  assert.match(String(suggestMessage.content ?? ""), /local-convention status="unavailable"/);
  assert.match(String(suggestMessage.content ?? ""), /stable variation axis/i);
  assert.deepEqual(suggestMessage.details.includedPracticeSignalIds, ["practice.variation-axis"]);
  const suggestLog = readFileSync(
    join(suggestProject.cwd, ".pi", "convention-sense", "observe.ndjson"),
    "utf8",
  );
  assert.match(suggestLog, /"practiceFallbackAnalysisCount":1/);

  const autoProject = createProject("pi-convention-practice-scope-unknown-auto-", "auto-once");
  const autoTarget = join(autoProject.sourceRoot, "ProviderRouter.java");
  const simpleTarget = join(autoProject.sourceRoot, "HealthClient.java");
  writeFileSync(
    autoTarget,
    "class ProviderRouter { Object route(int type) { switch (type) { case 1: return a(); case 2: return b(); case 3: return c(); default: return d(); } } }\n",
  );
  writeFileSync(simpleTarget, "class HealthClient { Object call() { return remoteClient.get(); } }\n");
  const autoHarness = createHarness(autoProject.cwd);
  const autoRuntime = registerConventionSenseSpike(autoHarness.api);
  await autoHarness.invoke("session_start", { type: "session_start", reason: "startup" });
  const startTask = () => autoHarness.invoke("before_agent_start", {
    type: "before_agent_start",
    prompt: "update provider routing",
    systemPrompt: "base-system",
    systemPromptOptions: {
      selectedTools: ["read", "edit"],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {} as Record<string, string>,
      contextFiles: [],
      skills: [],
    },
  });
  const settleEvent = () => ({
    type: "agent_before_settle",
    entries: [],
    continue: false,
    outcome: "completed" as const,
    context: {
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    },
  });

  await startTask();
  await autoHarness.invoke("tool_result", readResult(autoTarget, "fallback-auto-read"));
  await autoHarness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "fallback-auto-edit",
    toolName: "edit",
    input: {
      path: autoTarget,
      edits: [{ oldText: "switch (type)", newText: "switch (normalizedType)" }],
    },
    content: [],
    details: undefined,
    isError: false,
  });
  const review = await autoHarness.invoke("agent_before_settle", settleEvent());
  assert.equal(review.continue, true);
  assert.deepEqual(review.entries[0].details.signalIds, ["practice.variation-axis"]);
  assert.equal(review.entries[0].details.fallbackTargetCount, 1);
  assert.equal(autoRuntime.getSnapshotCache().list().length, 0);
  assert.equal(await autoHarness.invoke("agent_before_settle", settleEvent()), undefined);

  await startTask();
  await autoHarness.invoke("tool_result", readResult(simpleTarget, "fallback-simple-read"));
  await autoHarness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "fallback-simple-edit",
    toolName: "edit",
    input: {
      path: simpleTarget,
      edits: [{ oldText: "return remoteClient.get();", newText: "if (enabled) return remoteClient.get();" }],
    },
    content: [],
    details: undefined,
    isError: false,
  });
  assert.equal(
    await autoHarness.invoke("agent_before_settle", settleEvent()),
    undefined,
    "a scope-unknown API wrapper without a Practice Signal must not add a continuation",
  );
});

test("TypeScript and Vue participate in Extension Snapshot, Context, and Guard lifecycles", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-web-extension-"));
  cpSync(resolve("test", "fixtures", "typescript-vue"), cwd, { recursive: true });
  writeGuardConfig(cwd, { includeLanguages: ["typescript", "vue"] });
  const target = join("src", "views", "job", "batch", "index.vue");
  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  const unread = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "vue-unread-edit",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(unread.block, true);
  assert.match(unread.reason, /TARGET_NOT_READ/);

  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "vue-read",
    toolName: "read",
    input: { path: target },
    content: [],
    details: undefined,
    isError: false,
  });
  const snapshot = runtime.getSnapshotCache().list()[0];
  assert.ok(snapshot);
  assert.equal(snapshot.scope.language, "vue");
  assert.equal(snapshot.scope.role, "page");
  assert.equal(snapshot.status, "valid");
  assert.ok(snapshot.candidates.every((candidate) => candidate.scope.role === "page"));
  assert.ok(snapshot.candidates.every((candidate) => !candidate.path.includes("components")));

  const context = await harness.invoke("context", { type: "context", messages: [] });
  const content = context.messages.at(-1).content as string;
  assert.match(content, /<local-convention scope="vue:[^"]+:page"/);
  assert.match(content, /component-style: script-setup/);

  const allowed = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "vue-after-context",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(allowed, undefined);
});

test("Guard requires recent injected valid Evidence before allowing an edit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-guard-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  writeGuardConfig(cwd);
  const target = javaTarget();
  const harness = createHarness(cwd);
  registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  const unread = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "unread-edit",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(unread.block, true);
  assert.match(unread.reason, /TARGET_NOT_READ/);

  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "read-target",
    toolName: "read",
    input: { path: target },
    content: [],
    details: undefined,
    isError: false,
  });
  const notInjected = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "before-context",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(notInjected.block, true);
  assert.match(notInjected.reason, /SNAPSHOT_NOT_INJECTED/);

  await harness.invoke("context", { type: "context", messages: [] });
  const allowed = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "after-context",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(allowed, undefined);
});

test("prospective new-file discovery and one-time bypass cannot deadlock Guard", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-prospective-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  writeGuardConfig(cwd);
  const target = javaTarget();
  const newTarget = target.replace("OrderServiceImpl.java", "ShippingServiceImpl.java");
  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  const firstWrite = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "new-write-1",
    toolName: "write",
    input: { path: newTarget, content: "source omitted" },
  });
  assert.equal(firstWrite.block, true);
  assert.match(firstWrite.reason, /SNAPSHOT_NOT_INJECTED/);
  assert.equal(runtime.getSnapshotCache().get(resolve(cwd, newTarget))?.targetKind, "prospective");

  const context = await harness.invoke("context", { type: "context", messages: [] });
  assert.ok(context.messages.some((message: any) => /ShippingServiceImpl/.test(message.content)));
  const retry = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "new-write-2",
    toolName: "write",
    input: { path: newTarget, content: "source omitted" },
  });
  assert.equal(retry, undefined);

  const noPeerTarget = join(
    "order",
    "src",
    "main",
    "java",
    "com",
    "acme",
    "order",
    "controller",
    "LonelyController.java",
  );
  const noPeerWrite = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "no-peer-write",
    toolName: "write",
    input: { path: noPeerTarget, content: "source omitted" },
  });
  assert.equal(noPeerWrite, undefined, "a prospective target with no same-role peers must fail open");

  const bypass = harness.commands.get("convention-bypass");
  assert.ok(bypass);
  await bypass(target, harness.ctx);
  const bypassed = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "bypass-edit-1",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(bypassed, undefined);
  const blockedAgain = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "bypass-edit-2",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(blockedAgain.block, true);
  assert.equal(runtime.getState().bypassCount, 1);

  await bypass(target, harness.ctx);
  await harness.invoke("session_tree", {
    type: "session_tree",
    oldLeafId: "bypass-branch",
    newLeafId: "other-branch",
  });
  const bypassCleared = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "bypass-after-tree",
    toolName: "edit",
    input: { path: target, edits: [] },
  });
  assert.equal(bypassCleared.block, true, "one-time bypass must not cross branches");
});

test("explicit third-party mappings participate in read and mutation ledgers", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-mapping-"));
  const target = join("src", "main", "java", "com", "acme", "demo", "service", "impl", "DemoServiceImpl.java");
  mkdirSync(join(cwd, "src", "main", "java", "com", "acme", "demo", "service", "impl"), { recursive: true });
  writeFileSync(join(cwd, "pom.xml"), "<project/>\n");
  writeFileSync(join(cwd, target), "package com.acme.demo.service.impl; public class DemoServiceImpl {}\n");
  writeGuardConfig(cwd, {
    toolMappings: [
      { toolName: "custom_read", operation: "read", pathField: "file.path" },
      { toolName: "custom_patch", operation: "edit", pathField: "target.path" },
    ],
  });
  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "custom-read",
    toolName: "custom_read",
    input: { file: { path: target } },
    content: [],
    details: undefined,
    isError: false,
  });
  assert.equal(runtime.getState().successfulReads.size, 1);

  const customEdit = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "custom-edit",
    toolName: "custom_patch",
    input: { target: { path: target }, patch: "not logged" },
  });
  assert.equal(customEdit, undefined);
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "custom-edit",
    toolName: "custom_patch",
    input: { target: { path: target }, patch: "SECRET_PATCH" },
    content: [],
    details: undefined,
    isError: false,
  });
  assert.equal(runtime.getState().mutations.length, 1);

  const before = { ...runtime.getState().guardCounters };
  const lsp = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "pi-lens",
    toolName: "lsp",
    input: { path: target },
  });
  assert.equal(lsp, undefined);
  assert.deepEqual(runtime.getState().guardCounters, before);
  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  assert.doesNotMatch(log, /SECRET_PATCH/);
});

test("Git post-change audit detects a second modification to an already dirty Java file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-git-audit-"));
  const target = join("src", "main", "java", "com", "acme", "demo", "DemoService.java");
  mkdirSync(join(cwd, "src", "main", "java", "com", "acme", "demo"), { recursive: true });
  writeFileSync(join(cwd, target), "package com.acme.demo; public class DemoService { String value = \"clean\"; }\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial"],
    { cwd },
  );
  writeFileSync(join(cwd, target), "package com.acme.demo; public class DemoService { String value = \"dirty-one\"; }\n");

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  const command = "node -e \"require('fs').writeFileSync('target','changed')\"";
  await harness.invoke("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "shell-dirty",
    toolName: "bash",
    args: { command },
  });
  writeFileSync(join(cwd, target), "package com.acme.demo; public class DemoService { String value = \"dirty-two\"; }\n");
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "shell-dirty",
    toolName: "bash",
    input: { command },
    content: [],
    details: undefined,
    isError: false,
  });

  assert.equal(runtime.getState().postChangeAuditCount, 1);
  assert.equal(runtime.getState().postChangeGapCount, 1);
  assert.equal(runtime.getPostChangeAuditRuntime().all().length, 1);
  const context = await harness.invoke("context", { type: "context", messages: [] });
  assert.ok(context.messages.some((message: any) => /convention-post-change-audit/.test(message.content)));

  await harness.invoke("agent_settled", { type: "agent_settled" });
  assert.equal(runtime.getPostChangeAuditRuntime().all().length, 0);
  assert.match(harness.notifications.at(-1) ?? "", /post-change audit found 1/);
});

test("trusted Project Profile refines candidate roles and injects a Knowledge Capsule", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-profile-extension-"));
  const writeFixture = (relativePath: string, content: string): string => {
    const path = join(cwd, ...relativePath.split("/"));
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  execFileSync("git", ["init", "-q"], { cwd });
  writeFixture("pom.xml", "<project><modules><module>snail-job-server-interface</module></modules></project>");
  writeFixture(
    "snail-job-server-interface/snail-job-server-ui/pom.xml",
    "<project><artifactId>snail-job-server-ui</artifactId></project>",
  );
  writeFixture(
    "snail-job-server-interface/snail-job-server-web/pom.xml",
    "<project><artifactId>snail-job-server-web</artifactId></project>",
  );
  const target = "snail-job-server-interface/snail-job-server-ui/src/main/java/com/acme/ui/controller/WebController.java";
  writeFixture(target, "package com.acme.ui.controller; @Controller public class WebController {}\n");
  for (const name of ["WebController", "LoginController"]) {
    writeFixture(
      `snail-job-server-interface/snail-job-server-web/src/main/java/com/acme/web/controller/${name}.java`,
      `package com.acme.web.controller; @Controller public class ${name} {}\n`,
    );
  }
  for (const name of ["SystemInfoController", "JobTaskController", "DashboardController"]) {
    writeFixture(
      `snail-job-server-interface/snail-job-server-web/src/main/java/com/acme/web/controller/${name}.java`,
      `package com.acme.web.controller; @RestController public class ${name} {}\n`,
    );
  }
  writeFixture(
    ".convention-sense/profile.json",
    JSON.stringify({
      schemaVersion: 1,
      profileVersion: "1.0.0",
      project: { name: "profile-extension-fixture", repositoryRoot: "." },
      generatedAt: "2026-09-22T00:00:00.000Z",
      generatedBy: "agent",
      review: {
        status: "reviewed",
        reviewedAt: "2026-09-22T01:00:00.000Z",
        reviewedBy: "test",
      },
      technologies: [],
      packs: [{ id: "java-spring", version: "1.0.0", enabled: true, source: "builtin" }],
      modules: [
        {
          id: "server-ui",
          title: "Server UI",
          priority: 10,
          selector: { paths: ["snail-job-server-interface/snail-job-server-ui/**"] },
          architecture: ["spring-mvc-view"],
          knowledgeRefs: ["ui-boundary"],
        },
      ],
      scopeOverrides: [
        {
          id: "ui-view-controller",
          priority: 30,
          selector: {
            paths: ["snail-job-server-interface/snail-job-server-ui/**"],
            baseRoles: ["controller"],
            annotationsAny: ["Controller"],
          },
          effectiveRole: "mvc-view-controller",
          confidence: "high",
          evidence: [{ kind: "source", path: target, detail: "Uses @Controller" }],
        },
        {
          id: "web-view-controller",
          priority: 20,
          selector: {
            paths: ["snail-job-server-interface/snail-job-server-web/**"],
            baseRoles: ["controller"],
            annotationsAny: ["Controller"],
          },
          effectiveRole: "mvc-view-controller",
          confidence: "high",
          evidence: [{ kind: "source", path: "server-web/WebController.java", detail: "Uses @Controller" }],
        },
        {
          id: "rest-controller",
          priority: 10,
          selector: {
            paths: ["snail-job-server-interface/snail-job-server-web/**"],
            baseRoles: ["controller"],
            annotationsAny: ["RestController"],
          },
          effectiveRole: "rest-controller",
          confidence: "high",
          evidence: [{ kind: "source", path: "server-web/SystemInfoController.java", detail: "Uses @RestController" }],
        },
      ],
      knowledge: [
        {
          id: "ui-boundary",
          category: "architecture",
          title: "UI boundary",
          summary: "UI controllers return server-rendered view names.",
          strength: "hard",
          selector: { paths: ["snail-job-server-interface/snail-job-server-ui/**"] },
          source: "human",
        },
      ],
      conventions: [],
    }),
  );

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "profile-read",
    toolName: "read",
    input: { path: target },
    content: [],
    details: undefined,
    isError: false,
  });

  const snapshot = runtime.getSnapshotCache().list()[0];
  assert.ok(snapshot);
  assert.equal(snapshot.scope.effectiveRole, "mvc-view-controller");
  assert.equal(snapshot.analyzerVersion, "multi-lexical-v6-semantic-peers");
  assert.ok(snapshot.candidates.every((candidate) => !candidate.path.includes("SystemInfoController")));
  assert.ok(snapshot.candidates.every((candidate) => !candidate.path.includes("JobTaskController")));
  assert.ok(snapshot.projectContext);

  const context = await harness.invoke("context", { type: "context", messages: [] });
  const content = context.messages.at(-1).content as string;
  assert.match(content, /<project-knowledge/);
  assert.match(content, /effective role: mvc-view-controller/i);
  assert.match(content, /scope="java:snail-job-server-interface:snail-job-server-ui:mvc-view-controller"/);
  assert.doesNotMatch(content, /SystemInfoController|JobTaskController|DashboardController/);

  const statusCommand = harness.commands.get("convention-status");
  assert.ok(statusCommand);
  await statusCommand("", harness.ctx);
  const statusText = harness.notifications.at(-1) ?? "";
  assert.match(statusText, /config-source=defaults/);
  assert.match(statusText, /profile=loaded, review=reviewed, fingerprint=[a-f0-9]{16}/);
  assert.match(statusText, /packs=java-spring@1\.0\.0/);

  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  assert.match(log, /"projectProfileStatus":"loaded"/);
  assert.match(log, /"effectiveRole":"mvc-view-controller"/);
});

test("external repository Profile is ignored even when the startup project is trusted", async () => {
  const base = mkdtempSync(join(tmpdir(), "pi-convention-external-profile-"));
  const cwd = join(base, "session-project");
  const externalRoot = join(base, "external-java-project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(externalRoot, ".git"), { recursive: true });
  cpSync(resolve("test", "fixtures", "java-maven"), externalRoot, { recursive: true });

  const relativeTarget = "order/src/main/java/com/acme/order/service/impl/OrderServiceImpl.java";
  const target = join(externalRoot, ...relativeTarget.split("/"));
  mkdirSync(join(externalRoot, ".convention-sense"), { recursive: true });
  writeFileSync(
    join(externalRoot, ".convention-sense", "profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      profileVersion: "1.0.0",
      project: { name: "external-java-project", repositoryRoot: "." },
      generatedAt: "2026-09-23T00:00:00.000Z",
      generatedBy: "agent",
      review: { status: "draft" },
      technologies: [],
      packs: [{ id: "java-spring", version: "1.0.0", enabled: true, source: "builtin" }],
      modules: [],
      scopeOverrides: [
        {
          id: "external-service-role",
          priority: 100,
          selector: { paths: ["order/**"], baseRoles: ["service-impl"] },
          effectiveRole: "external-profile-service",
          confidence: "high",
          evidence: [{ kind: "source", path: relativeTarget, detail: "External profile test" }],
        },
      ],
      knowledge: [
        {
          id: "external-only-knowledge",
          category: "architecture",
          title: "External only knowledge",
          summary: "This item must not enter a session started from another repository.",
          strength: "hard",
          selector: { paths: ["order/**"] },
          source: "human",
        },
      ],
      conventions: [],
    }),
  );
  assert.equal(loadProjectProfile(externalRoot, true).status, "loaded");

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "external-profile-read",
    toolName: "read",
    input: { path: target },
    content: [],
    details: undefined,
    isError: false,
  });

  const snapshot = runtime.getSnapshotCache().list()[0];
  assert.ok(snapshot);
  assert.equal(snapshot.repositoryRoot, externalRoot);
  assert.equal(snapshot.scope.role, "service-impl");
  assert.equal(snapshot.scope.effectiveRole, undefined);
  assert.equal(snapshot.projectContext, undefined);
  assert.ok(snapshot.candidates.every((candidate) => candidate.path.startsWith(externalRoot)));
  assert.ok(snapshot.candidates.every((candidate) => !candidate.path.startsWith(cwd)));

  const context = await harness.invoke("context", { type: "context", messages: [] });
  const contextText = context.messages.map((message: any) => String(message.content ?? "")).join("\n");
  assert.doesNotMatch(contextText, /<project-knowledge|external-profile-service|External only knowledge/);

  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  assert.match(log, /"profileStatus":"ignored"/);
  assert.match(log, /Project Profile exists but was ignored because the project is not trusted/);
});

test("unexpected handler exceptions fail open in every mode and are logged without error text", async () => {
  for (const mode of ["observe", "guard"] as const) {
    const cwd = mkdtempSync(join(tmpdir(), `pi-convention-failopen-${mode}-`));
    cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
    writeGuardConfig(cwd, { mode });
    const target = javaTarget();
    const harness = createHarness(cwd);
    harness.allowHandlerErrors = true;
    const runtime = registerConventionSenseSpike(harness.api);
    await harness.invoke("session_start", { type: "session_start", reason: "startup" });
    await harness.invoke("tool_result", {
      type: "tool_result",
      toolCallId: "read-target",
      toolName: "read",
      input: { path: target },
      content: [],
      details: undefined,
      isError: false,
    });
    await harness.invoke("context", { type: "context", messages: [] });

    // A transient filesystem error (for example EBUSY on Windows) inside Snapshot freshness checks.
    const cache = runtime.getSnapshotCache();
    cache.getFresh = () => {
      throw Object.assign(new Error("EBUSY SECRET_ERROR_TEXT"), { code: "EBUSY" });
    };

    // Pi's runner has no try/catch around tool_call: a throw there would block the user's edit.
    const edit = await harness.invoke("tool_call", {
      type: "tool_call",
      toolCallId: `edit-${mode}`,
      toolName: "edit",
      input: { path: target, edits: [{ oldText: "a", newText: "b" }] },
    });
    assert.equal(edit, undefined, `${mode}: an analysis exception must never block edit/write`);

    const context = await harness.invoke("context", { type: "context", messages: [] });
    assert.equal(context, undefined, `${mode}: a failing context handler must leave messages unchanged`);
    await harness.invoke("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: `bash-${mode}`,
      toolName: "bash",
      args: { command: "printf x > out.txt" },
    });

    const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
    assert.match(log, /"event":"handler_error"/);
    for (const handlerEvent of ["tool_call", "context", "tool_execution_start"]) {
      assert.match(log, new RegExp(`"handlerEvent":"${handlerEvent}"`), `${mode}: missing handler_error for ${handlerEvent}`);
    }
    assert.match(log, /"errorCode":"EBUSY"/);
    assert.doesNotMatch(log, /SECRET_ERROR_TEXT/, "error messages can embed source text and must not be logged");
  }
});

test(
  "Guard accepts drive-letter and case variants of a path that was read",
  { skip: !isCaseInsensitivePlatform() },
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-convention-pathcase-"));
    cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
    writeGuardConfig(cwd);
    const absolute = resolve(cwd, javaTarget());
    const harness = createHarness(cwd);
    const runtime = registerConventionSenseSpike(harness.api);
    await harness.invoke("session_start", { type: "session_start", reason: "startup" });
    await harness.invoke("tool_result", {
      type: "tool_result",
      toolCallId: "read-original",
      toolName: "read",
      input: { path: absolute },
      content: [],
      details: undefined,
      isError: false,
    });
    await harness.invoke("context", { type: "context", messages: [] });

    const flippedDrive = absolute.replace(/^([A-Za-z]):/, (_match, letter: string) =>
      letter === letter.toUpperCase() ? `${letter.toLowerCase()}:` : `${letter.toUpperCase()}:`,
    );
    const variants: Record<string, string> = {
      "same spelling": absolute,
      "flipped drive letter": flippedDrive,
      "different file name case": absolute.replace("OrderServiceImpl", "orderserviceimpl"),
      "forward slashes": absolute.replaceAll("\\", "/"),
    };
    for (const [name, path] of Object.entries(variants)) {
      const decision = await harness.invoke("tool_call", {
        type: "tool_call",
        toolCallId: `edit-${name}`,
        toolName: "edit",
        input: { path, edits: [{ oldText: "a", newText: "b" }] },
      });
      assert.equal(decision, undefined, `"${name}" must be recognized as the file that was read`);
    }
    assert.equal(runtime.getState().successfulReads.size, 1);
  },
);

test("a project config cannot redirect the log outside the plugin state directory", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-convention-logpath-"));
  const cwd = join(parent, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({ mode: "observe", logPath: "../escaped.ndjson" }),
  );
  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  assert.equal(existsSync(join(parent, "escaped.ndjson")), false);
  assert.equal(runtime.getLogger().filePath, resolve(cwd, ".pi", "convention-sense", "observe.ndjson"));
  assert.ok(existsSync(runtime.getLogger().filePath));
  assert.ok(runtime.getLoadedConfig().diagnostics.some((message) => /logPath/.test(message)));
});

function countCheckpoints(harness: Harness): number {
  return harness.branchEntries.filter((entry) => entry.customType === SPIKE_STATE_ENTRY_TYPE).length;
}

async function readFile(harness: Harness, cwd: string, name: string, id: string): Promise<void> {
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: id,
    toolName: "read",
    input: { path: join(cwd, "src", "main", "java", "com", "acme", "pkg", name) },
    content: [],
    details: undefined,
    isError: false,
  });
}

test("the checkpoint is appended once per agent run, on shutdown, and only when state changed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-checkpoint-"));
  const harness = createHarness(cwd);
  registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  for (let index = 0; index < 30; index += 1) await readFile(harness, cwd, `File${index}.java`, `r${index}`);
  assert.equal(countCheckpoints(harness), 0, "tool results must not append a full checkpoint each");

  await harness.invoke("agent_settled", { type: "agent_settled" });
  assert.equal(countCheckpoints(harness), 1);
  await harness.invoke("agent_settled", { type: "agent_settled" });
  assert.equal(countCheckpoints(harness), 1, "an unchanged ledger must not append another checkpoint");

  await readFile(harness, cwd, "Late.java", "late");
  await harness.invoke("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(countCheckpoints(harness), 2, "pending changes are flushed on shutdown");
  const last = harness.branchEntries.filter((entry) => entry.customType === SPIKE_STATE_ENTRY_TYPE).at(-1);
  assert.equal(last.data.successfulReads.length, 31);
});

test("checkpoint growth stays bounded across a long session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-checkpoint-size-"));
  const harness = createHarness(cwd);
  registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  for (let run = 0; run < 25; run += 1) {
    for (let index = 0; index < 20; index += 1) {
      await readFile(harness, cwd, `File${run * 20 + index}.java`, `r${run}-${index}`);
    }
    await harness.invoke("agent_settled", { type: "agent_settled" });
  }

  const bytes = harness.branchEntries.reduce((total, entry) => total + JSON.stringify(entry).length, 0);
  assert.ok(bytes < 2 * 1024 * 1024, `500 reads wrote ${(bytes / 1024 / 1024).toFixed(2)} MiB of checkpoints`);
  const last = harness.branchEntries.filter((entry) => entry.customType === SPIKE_STATE_ENTRY_TYPE).at(-1);
  assert.ok(last.data.successfulReads.length <= 300);
  assert.ok(last.data.recentReads.length <= 100);
});

test("a symlinked default log file is never written through, even while the extension keeps working", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-logsymlink-"));
  const outside = join(mkdtempSync(join(tmpdir(), "pi-convention-outside-")), "outside.txt");
  writeFileSync(outside, "ORIGINAL\n");
  mkdirSync(join(cwd, ".pi", "convention-sense"), { recursive: true });
  try {
    symlinkSync(outside, join(cwd, ".pi", "convention-sense", "observe.ndjson"), "file");
  } catch {
    t.skip("file symlinks cannot be created here");
    return;
  }

  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "read-1",
    toolName: "read",
    input: { path: join(cwd, "A.java") },
    content: [],
    details: undefined,
    isError: false,
  });
  await harness.invoke("agent_settled", { type: "agent_settled" });

  assert.equal(readFileSync(outside, "utf8"), "ORIGINAL\n");
  assert.equal(runtime.getLogger().level, "silent");
  assert.equal(runtime.getState().successfulReads.size, 1, "the ledger keeps working without a log");
});

test("a controlled edit does not rescan the repository, but writing a new source file does", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-index-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  writeGuardConfig(cwd, { mode: "observe" });
  const absolute = resolve(cwd, javaTarget());
  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  const toolResult = (toolName: string, input: Record<string, unknown>, id: string) =>
    harness.invoke("tool_result", { type: "tool_result", toolCallId: id, toolName, input, content: [], details: undefined, isError: false });

  await toolResult("read", { path: absolute }, "read-1");
  assert.equal(runtime.getAnalyzer().indexBuildCount, 1);

  writeFileSync(absolute, `${readFileSync(absolute, "utf8")}\n// edited\n`);
  await toolResult("edit", { path: absolute, edits: [{ oldText: "a", newText: "b" }] }, "edit-1");
  await harness.invoke("context", { type: "context", messages: [] }); // re-analyzes the now-stale Snapshot
  assert.equal(runtime.getAnalyzer().indexBuildCount, 1, "an edit never changes the set of files");

  const created = join(absolute, "..", "ShippingServiceImpl.java");
  writeFileSync(created, "package com.acme.order.service.impl; public class ShippingServiceImpl implements ShippingService {}\n");
  await toolResult("write", { path: created, content: "x" }, "write-1");
  await toolResult("read", { path: absolute }, "read-2");
  assert.equal(runtime.getAnalyzer().indexBuildCount, 2, "a created file invalidates the index");
  assert.ok(
    runtime.getSnapshotCache().get(absolute)?.candidates.some((candidate) => candidate.path.endsWith("ShippingServiceImpl.java")),
    "the new file is a peer candidate",
  );
});

async function conventionStatus(harness: Harness): Promise<string> {
  const command = harness.commands.get("convention-status");
  assert.ok(command);
  await command("", harness.ctx);
  return harness.notifications.at(-1) ?? "";
}

test("convention-status shows trust and enabled languages, and hints when a web project is not analyzed", async () => {
  // A web project with the default config: Java only, so TypeScript/Vue silently do nothing.
  const web = mkdtempSync(join(tmpdir(), "pi-convention-status-web-"));
  writeFileSync(join(web, "package.json"), '{"name":"web","dependencies":{"vue":"3.4.0"}}');
  const webHarness = createHarness(web);
  registerConventionSenseSpike(webHarness.api);
  await webHarness.invoke("session_start", { type: "session_start", reason: "startup" });
  const webStatus = await conventionStatus(webHarness);
  assert.match(webStatus, /project-trusted=true/);
  assert.match(webStatus, /languages=java(\n|$)/);
  assert.match(webStatus, /hint=package\.json found but TypeScript\/Vue analysis is off/);

  // The same project once TypeScript/Vue are enabled: no hint.
  const enabled = mkdtempSync(join(tmpdir(), "pi-convention-status-enabled-"));
  writeFileSync(join(enabled, "package.json"), '{"name":"web","dependencies":{"vue":"3.4.0"}}');
  writeGuardConfig(enabled, { mode: "observe", includeLanguages: ["java", "typescript", "vue"] });
  const enabledHarness = createHarness(enabled);
  registerConventionSenseSpike(enabledHarness.api);
  await enabledHarness.invoke("session_start", { type: "session_start", reason: "startup" });
  const enabledStatus = await conventionStatus(enabledHarness);
  assert.match(enabledStatus, /languages=java,typescript,vue/);
  assert.doesNotMatch(enabledStatus, /hint=/);

  // A Java project has nothing to hint about.
  const java = mkdtempSync(join(tmpdir(), "pi-convention-status-java-"));
  writeFileSync(join(java, "pom.xml"), "<project/>");
  const javaHarness = createHarness(java);
  registerConventionSenseSpike(javaHarness.api);
  await javaHarness.invoke("session_start", { type: "session_start", reason: "startup" });
  assert.doesNotMatch(await conventionStatus(javaHarness), /hint=/);

  // A Java project whose package.json only serves tooling (husky, commitlint) is not a web project.
  const tooling = mkdtempSync(join(tmpdir(), "pi-convention-status-tooling-"));
  writeFileSync(join(tooling, "pom.xml"), "<project/>");
  writeFileSync(join(tooling, "package.json"), '{"devDependencies":{"husky":"9.0.0","@commitlint/cli":"19.0.0"}}');
  const toolingHarness = createHarness(tooling);
  registerConventionSenseSpike(toolingHarness.api);
  await toolingHarness.invoke("session_start", { type: "session_start", reason: "startup" });
  assert.doesNotMatch(await conventionStatus(toolingHarness), /hint=/, "no evidence of web sources, no hint");

  // A tsconfig.json next to the package.json is evidence enough.
  const typed = mkdtempSync(join(tmpdir(), "pi-convention-status-typed-"));
  writeFileSync(join(typed, "package.json"), '{"name":"lib"}');
  writeFileSync(join(typed, "tsconfig.json"), "{}");
  const typedHarness = createHarness(typed);
  registerConventionSenseSpike(typedHarness.api);
  await typedHarness.invoke("session_start", { type: "session_start", reason: "startup" });
  assert.match(await conventionStatus(typedHarness), /hint=package\.json found but TypeScript\/Vue analysis is off/);
});

test("convention-status says when the project config was ignored because the project is not trusted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-status-untrusted-"));
  writeGuardConfig(cwd, { mode: "guard" });
  const harness = createHarness(cwd, { trusted: false });
  harness.allowHandlerErrors = false;
  registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  const status = await conventionStatus(harness);
  assert.match(status, /project-trusted=false/);
  assert.match(status, /config-source=defaults/);
  assert.match(status, /ignored because the project is not trusted/);
});

test("Guard fails open for an oversized target instead of analyzing it or blocking", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-huge-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  writeGuardConfig(cwd, { mode: "guard" });
  const absolute = resolve(cwd, javaTarget());
  writeFileSync(
    absolute,
    `package com.acme.order.service.impl;\npublic class OrderServiceImpl implements OrderService {}\n// ${"x".repeat(MAX_ANALYZED_FILE_BYTES)}\n`,
  );
  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  await harness.invoke("tool_result", {
    type: "tool_result",
    toolCallId: "read-huge",
    toolName: "read",
    input: { path: absolute },
    content: [],
    details: undefined,
    isError: false,
  });
  assert.equal(runtime.getSnapshotCache().list().length, 0, "no Snapshot for an oversized file");

  const decision = await harness.invoke("tool_call", {
    type: "tool_call",
    toolCallId: "edit-huge",
    toolName: "edit",
    input: { path: absolute, edits: [{ oldText: "a", newText: "b" }] },
  });
  assert.equal(decision, undefined, "an oversized target must never be blocked");
  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  assert.match(log, /"reasonCode":"ANALYSIS_FAILED_OPEN"/);

  // Why the analysis failed is logged as a classification, never as the error message (messages can embed paths or text).
  const skipped = log.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((record) => record.event === "snapshot_skipped");
  assert.ok(skipped, "the skipped analysis is logged");
  assert.equal(skipped.payload.reason, "analysis-error");
  assert.equal(skipped.payload.errorName, "Error");
  assert.equal("error" in skipped.payload, false, "the raw error message must not be logged");
  assert.doesNotMatch(log, /too large to analyze/i);
});

test("files created or deleted by a shell command refresh the repository index", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-shell-index-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial"],
    { cwd },
  );
  writeGuardConfig(cwd, { mode: "observe" });
  const absolute = resolve(cwd, javaTarget());
  const created = join(absolute, "..", "ShippingServiceImpl.java");
  const harness = createHarness(cwd);
  const runtime = registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });

  const read = () => harness.invoke("tool_result", {
    type: "tool_result", toolCallId: "read", toolName: "read", input: { path: absolute }, content: [], details: undefined, isError: false,
  });
  const peers = () => runtime.getSnapshotCache().get(absolute)?.candidates.map((candidate) => candidate.path) ?? [];
  // A risky shell command: Git baseline before, the real change on disk, then the audit after.
  const shell = async (command: string, change: () => void) => {
    await harness.invoke("tool_execution_start", { type: "tool_execution_start", toolCallId: "shell", toolName: "bash", args: { command } });
    change();
    await harness.invoke("tool_result", {
      type: "tool_result", toolCallId: "shell", toolName: "bash", input: { command }, content: [], details: undefined, isError: false,
    });
  };

  await read();
  assert.equal(runtime.getAnalyzer().indexBuildCount, 1);

  await shell("echo x > notes.txt", () => writeFileSync(created, "package com.acme.order.service.impl; public class ShippingServiceImpl implements ShippingService {}"));
  await read();
  assert.equal(runtime.getAnalyzer().indexBuildCount, 2, "a source file created by a shell command invalidates the index");
  assert.ok(peers().some((path) => path.endsWith("ShippingServiceImpl.java")), "and becomes a peer candidate");

  await shell("rm ShippingServiceImpl.java", () => rmSync(created));
  await read();
  assert.equal(runtime.getAnalyzer().indexBuildCount, 3, "a deleted source file invalidates it again");
  assert.ok(!peers().some((path) => path.endsWith("ShippingServiceImpl.java")));
});
