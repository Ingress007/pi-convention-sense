// "Has the model seen this evidence?" must depend on the evidence, not on when its Snapshot object was built.
// Editing the target rebuilds the Snapshot, but the peers and observations the model was shown are unchanged.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { registerConventionSenseSpike } from "../extensions/index.js";
import { assertNoSwallowedHandlerErrors, createHarness, type Harness } from "./support/fake-pi.js";

afterEach(assertNoSwallowedHandlerErrors);

const DIR = ["order", "src", "main", "java", "com", "acme", "order", "service", "impl"];

async function session(): Promise<{ harness: Harness; cwd: string; target: string; peer: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-injection-"));
  cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "convention-sense.json"), JSON.stringify({ mode: "guard" }));
  const harness = createHarness(cwd);
  registerConventionSenseSpike(harness.api);
  await harness.invoke("session_start", { type: "session_start", reason: "startup" });
  return { harness, cwd, target: join(cwd, ...DIR, "OrderServiceImpl.java"), peer: join(cwd, ...DIR, "PaymentServiceImpl.java") };
}

async function read(harness: Harness, path: string): Promise<void> {
  await harness.invoke("tool_result", { type: "tool_result", toolCallId: `read-${path.length}`, toolName: "read", input: { path }, content: [], details: undefined, isError: false });
}

async function editCall(harness: Harness, path: string, id: string): Promise<any> {
  return harness.invoke("tool_call", { type: "tool_call", toolCallId: id, toolName: "edit", input: { path, edits: [{ oldText: "a", newText: "b" }] } });
}

/** The edit tool finished: the file changed on disk and Pi reported a successful result. */
async function applyEdit(harness: Harness, path: string, id: string): Promise<void> {
  appendFileSync(path, `\n// edited by ${id}\n`);
  await harness.invoke("tool_result", {
    type: "tool_result", toolCallId: id, toolName: "edit", input: { path, edits: [{ oldText: "a", newText: "b" }] },
    content: [], details: undefined, isError: false,
  });
}

function decisions(cwd: string): string[] {
  const log = readFileSync(join(cwd, ".pi", "convention-sense", "observe.ndjson"), "utf8");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; payload: Record<string, any> })
    .filter((record) => record.event === "guard_decision")
    .map((record) => record.payload.reasonCode);
}

test("a second edit of the same target in the same turn is not blocked after the first edit rebuilt its Snapshot", async () => {
  const { harness, cwd, target } = await session();
  await read(harness, target);
  await harness.invoke("context", { type: "context", messages: [] });

  assert.equal(await editCall(harness, target, "edit-1"), undefined);
  await applyEdit(harness, target, "edit-1");
  // No Context event in between: Pi ran both tool calls from one assistant message.
  const second = await editCall(harness, target, "edit-2");
  assert.equal(second, undefined, `the evidence did not change, so the model has still seen it: ${second?.reason ?? ""}`);
  assert.deepEqual(decisions(cwd), ["SNAPSHOT_VALID", "SNAPSHOT_VALID"]);
});

test("a changed peer is new evidence: the edit waits until the next Context shows it", async () => {
  const { harness, cwd, target, peer } = await session();
  await read(harness, target);
  await harness.invoke("context", { type: "context", messages: [] });
  assert.equal(await editCall(harness, target, "edit-1"), undefined);

  // Another tool changed a peer the model was shown, and the target's Snapshot is rebuilt around the new peer content.
  appendFileSync(peer, "\n// a different way of logging: log.error(\"x\");\n");
  await applyEdit(harness, target, "edit-1");
  const blocked = await editCall(harness, target, "edit-2");
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /SNAPSHOT_NOT_INJECTED/);

  // The next Context shows the rebuilt evidence and the edit goes through.
  await harness.invoke("context", { type: "context", messages: [] });
  assert.equal(await editCall(harness, target, "edit-3"), undefined);
  assert.deepEqual(decisions(cwd), ["SNAPSHOT_VALID", "SNAPSHOT_NOT_INJECTED", "SNAPSHOT_VALID"]);
});
