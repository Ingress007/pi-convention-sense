// User-facing behavior of the /convention-* commands: what they show and what they complete.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { registerConventionSenseSpike } from "../extensions/index.js";
import { assertNoSwallowedHandlerErrors, createHarness, type Harness } from "./support/fake-pi.js";

afterEach(assertNoSwallowedHandlerErrors);

const TARGET = ["order", "src", "main", "java", "com", "acme", "order", "service", "impl", "OrderServiceImpl.java"];
const PEER = ["order", "src", "main", "java", "com", "acme", "order", "service", "impl", "PaymentServiceImpl.java"];
const shown = (...segments: string[]): string => segments.join("/");

async function project(mode: "guard" | "observe" = "guard"): Promise<{ harness: Harness; cwd: string; target: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-commands-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "convention-sense.json"), JSON.stringify({ mode }));
  const harness = createHarness(cwd);
  registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  return { harness, cwd, target: join(cwd, ...TARGET) };
}

async function command(harness: Harness, name: string, args = ""): Promise<string> {
  const handler = harness.commands.get(name);
  assert.ok(handler, `/${name} is not registered`);
  const before = harness.notifications.length;
  await handler(args, harness.ctx);
  assert.equal(harness.notifications.length, before + 1, `/${name} must notify exactly once`);
  return harness.notifications.at(-1) ?? "";
}

async function readFile(harness: Harness, path: string, id: string): Promise<void> {
  await harness.invoke("tool_result", { type: "tool_result", toolCallId: id, toolName: "read", input: { path }, content: [], details: undefined, isError: false });
}

async function edit(harness: Harness, path: string, id: string): Promise<any> {
  return harness.invoke("tool_call", { type: "tool_call", toolCallId: id, toolName: "edit", input: { path, edits: [{ oldText: "a", newText: "b" }] } });
}

test("/convention-status shows the last Guard decision and forgets it on reset", async () => {
  const { harness, target } = await project();
  assert.match(await command(harness, "convention-status"), /^last-guard=none$/m);

  const blocked = await edit(harness, target, "edit-1");
  assert.equal(blocked.block, true);
  assert.match(await command(harness, "convention-status"), new RegExp(`^last-guard=block TARGET_NOT_READ \\(edit\\) ${shown(...TARGET)}$`, "m"));

  await readFile(harness, target, "read-1");
  await harness.invoke("context", { type: "context", messages: [] });
  assert.equal(await edit(harness, target, "edit-2"), undefined);
  assert.match(await command(harness, "convention-status"), new RegExp(`^last-guard=allow SNAPSHOT_VALID \\(edit\\) ${shown(...TARGET)}$`, "m"));

  await command(harness, "convention-reset", "confirm");
  assert.match(await command(harness, "convention-status"), /^last-guard=none$/m);
});

test("observe mode reports its decision the same way", async () => {
  const { harness, target } = await project("observe");
  await edit(harness, target, "edit-1");
  assert.match(await command(harness, "convention-status"), new RegExp(`^last-guard=wouldBlock TARGET_NOT_READ \\(edit\\) ${shown(...TARGET)}$`, "m"));
});

test("/convention-snapshot accepts a path and says why when there is nothing to show", async () => {
  const { harness, cwd, target } = await project();
  assert.match(await command(harness, "convention-snapshot"), /No convention Snapshot is available/);
  assert.match(await command(harness, "convention-snapshot", shown(...TARGET)), /No convention Snapshot for .*OrderServiceImpl\.java.*read it first/i);

  await readFile(harness, target, "read-1");
  const newest = await command(harness, "convention-snapshot");
  assert.match(newest, /scope=java:order:service-impl/);
  const named = await command(harness, "convention-snapshot", shown(...TARGET));
  assert.equal(named, newest, "naming the only active target shows the same Snapshot");

  // A second target: asking for it by name shows that one, whichever was read last.
  const peer = join(cwd, ...PEER);
  await readFile(harness, peer, "read-2");
  assert.match(await command(harness, "convention-snapshot", shown(...PEER)), new RegExp(`target=${shown(...PEER)}`));
  assert.match(await command(harness, "convention-snapshot", shown(...TARGET)), new RegExp(`target=${shown(...TARGET)}`));

  // Absolute paths, an @-prefixed mention and surrounding spaces all work; other files and directories do not.
  assert.match(await command(harness, "convention-snapshot", `  @${target} `), new RegExp(`target=${shown(...TARGET)}`));
  assert.match(await command(harness, "convention-snapshot", "README.md"), /not a configured source file/i);
});

test("/convention-bypass completes the paths the Guard has been asked about", async () => {
  const { harness, cwd, target } = await project();
  const options = harness.commandOptions.get("convention-bypass");
  assert.ok(options?.getArgumentCompletions, "the command offers argument completions");
  const complete = (prefix: string): Array<{ value: string; label: string; description?: string }> | null => options.getArgumentCompletions?.(prefix);

  assert.equal(complete(""), null, "nothing has been asked yet, so there is nothing to suggest");

  await edit(harness, target, "edit-1");
  await edit(harness, join(cwd, ...PEER), "edit-2");
  const all = complete("");
  assert.deepEqual(all?.map((item) => item.value), [shown(...PEER), shown(...TARGET)], "the most recently asked target comes first");
  assert.equal(all?.[0]?.label, shown(...PEER));
  assert.match(all?.[1]?.description ?? "", /TARGET_NOT_READ/);

  assert.deepEqual(complete("order/src/main/java/com/acme/order/service/impl/Order")?.map((item) => item.value), [shown(...TARGET)]);
  assert.deepEqual(complete("orderserviceimpl")?.map((item) => item.value), [shown(...TARGET)], "a match anywhere in the path, ignoring case");
  assert.equal(complete("does-not-exist"), null);

  await command(harness, "convention-reset", "confirm");
  assert.equal(complete(""), null, "a reset forgets the targets");
});

test("a bypass is not offered in observe mode", async () => {
  const { harness, target } = await project("observe");
  await edit(harness, target, "edit-1");
  assert.equal(harness.commandOptions.get("convention-bypass")?.getArgumentCompletions?.(""), null);
});
