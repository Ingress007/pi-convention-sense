import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerConventionSenseSpike } from "../extensions/index.js";
import { loadProjectProfile } from "../src/profile/profile-loader.js";
import { SPIKE_STATE_ENTRY_TYPE } from "../src/runtime/types.js";

type Handler = (event: any, ctx: any) => any;

interface Harness {
  api: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  branchEntries: any[];
  notifications: string[];
  statuses: Array<string | undefined>;
  ctx: ExtensionContext;
  invoke(event: string, payload: any): Promise<any>;
}

function createHarness(cwd: string): Harness {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const branchEntries: any[] = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];

  const api = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    appendEntry(customType: string, data: unknown) {
      branchEntries.push({ type: "custom", customType, data });
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;

  const sessionManager = {
    getSessionId: () => "session-1",
    getSessionFile: () => join(cwd, "session.jsonl"),
    getLeafId: () => "leaf-1",
    getBranch: () => branchEntries,
  };

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    sessionManager,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
    },
  } as unknown as ExtensionContext;

  return {
    api,
    handlers,
    commands,
    branchEntries,
    notifications,
    statuses,
    ctx,
    async invoke(event: string, payload: any): Promise<any> {
      let result: any;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

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

  const promptResult = await harness.invoke("before_agent_start", {
    type: "before_agent_start",
    prompt: "change target",
    systemPrompt: "base-system",
    systemPromptOptions: { selectedTools: ["read", "edit", "write"] },
  });
  assert.match(promptResult.systemPrompt, /Local Convention Evidence/);

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
  assert.ok(harness.branchEntries.some((entry) => entry.customType === SPIKE_STATE_ENTRY_TYPE));
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
  assert.equal(snapshot.analyzerVersion, "multi-lexical-v5-typescript-vue-profile");
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
