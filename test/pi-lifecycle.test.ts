// Real Pi: slash commands, compaction and reload. Same offline setup as pi-integration.test.ts (Pi's own agent
// loop and extension runner, scripted model), covering the lifecycle events that a hand-written fake cannot.
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { SPIKE_STATE_ENTRY_TYPE } from "../src/runtime/types.js";
import { createPiHarness, finalTurn, toolTurn, type PiHarness } from "./support/pi-session.js";

const fixture = resolve("test", "fixtures", "java-maven");
const targetRelative = join("order", "src", "main", "java", "com", "acme", "order", "service", "impl", "OrderServiceImpl.java");
const OLD_LINE = 'log.info("creating order {}", request.getId());';
const NEW_LINE = 'log.info("creating order {} for audit", request.getId());';

function seedJavaProject(cwd: string): void {
  cpSync(fixture, cwd, { recursive: true });
}

const editCall = (target: string) => ({ name: "edit", args: { path: target, edits: [{ oldText: OLD_LINE, newText: NEW_LINE }] } });
const readCall = (target: string) => ({ name: "read", args: { path: target } });

async function withHarness(
  options: Parameters<typeof createPiHarness>[0],
  body: (harness: PiHarness, target: string) => Promise<void>,
): Promise<void> {
  const harness = await createPiHarness(options);
  try {
    assert.deepEqual(harness.extensionErrors, [], "the extension must load and start without errors");
    await body(harness, join(harness.cwd, targetRelative));
    assert.deepEqual(
      harness.logRecords().filter((record) => record.event === "handler_error"),
      [],
      "a handler threw: the fail-open wrapper hid it from this test",
    );
    assert.deepEqual(harness.extensionErrors, [], "Pi's extension runner reported an error");
  } finally {
    harness.dispose();
  }
}

const lastNotification = (harness: PiHarness): string => harness.notifications.at(-1) ?? "";

test("real Pi: the /convention commands run without a model call and report through the UI", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" }, captureUi: true }, async (harness, target) => {
    await harness.session.prompt("/convention-status");
    assert.equal(harness.modelMessages.length, 0, "a slash command must not reach the model");
    assert.match(lastNotification(harness), /pi-convention-sense V1 Guard \(guard\)/);
    assert.match(lastNotification(harness), /config-source=project, project-trusted=true/);
    assert.match(lastNotification(harness), /languages=java/);

    // Discovery through the real loop, then the commands see its state.
    await harness.run([toolTurn(readCall(target)), finalTurn()]);
    await harness.session.prompt("/convention-status");
    assert.match(lastNotification(harness), /reads=1, pending=0/);

    await harness.session.prompt("/convention-snapshot");
    assert.match(lastNotification(harness), /scope=java:order:service-impl/);
    assert.match(lastNotification(harness), /status=valid/);

    await harness.session.prompt("/convention-audit");
    assert.match(lastNotification(harness), /No pending Convention post-change findings\./);

    await harness.session.prompt("/convention-bypass");
    assert.match(lastNotification(harness), /Usage: \/convention-bypass <path>/);
    await harness.session.prompt(`/convention-bypass ${targetRelative}`);
    assert.match(lastNotification(harness), /One-time Convention Guard bypass granted/);
    assert.equal(harness.runtime().getGuardRuntime().hasBypass(target), true);

    await harness.session.prompt("/convention-reset");
    assert.match(lastNotification(harness), /Usage: \/convention-reset confirm/);
    assert.equal(harness.runtime().getState().successfulReads.size, 1, "without `confirm` nothing is cleared");
    await harness.session.prompt("/convention-reset confirm");
    assert.match(lastNotification(harness), /state reset/);
    assert.equal(harness.runtime().getState().successfulReads.size, 0);
    assert.equal(harness.runtime().getGuardRuntime().hasBypass(target), false, "a reset also drops pending bypasses");

    assert.equal(harness.modelMessages.length, 2, "only the scripted agent run (a read turn and a final turn) called the model");
    assert.ok(harness.statuses.length > 0, "the status line is kept up to date");
  });
});

test("real Pi: a bypass is single-use and exact-path", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" }, captureUi: true }, async (harness, target) => {
    await harness.session.prompt(`/convention-bypass ${targetRelative}`);
    // The first edit passes on the bypass alone (no read, no Snapshot); the second has no bypass left.
    await harness.run([toolTurn(editCall(target)), finalTurn()]);
    assert.equal(harness.toolOutcomes[0]?.isError, false, harness.toolOutcomes[0]?.text);
    assert.match(readFileSync(target, "utf8"), /for audit/);

    await harness.run([toolTurn({ name: "edit", args: { path: target, edits: [{ oldText: NEW_LINE, newText: OLD_LINE }] } }), finalTurn()]);
    const second = harness.toolOutcomes[1];
    assert.equal(second?.isError, true);
    assert.match(second?.text ?? "", /TARGET_NOT_READ/);
    assert.deepEqual(
      harness.logRecords().filter((record) => record.event === "guard_decision").map((record) => record.payload.reasonCode),
      ["BYPASS_GRANTED", "TARGET_NOT_READ"],
    );
  });
});

test("real Pi: Discovery state and Snapshot injection survive a compaction", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" }, compaction: { keepRecentTokens: 1, reserveTokens: 1_000 } }, async (harness, target) => {
    await harness.run([toolTurn(readCall(target)), finalTurn("read it")]);
    assert.equal(harness.runtime().getState().successfulReads.size, 1);
    const checkpointsBefore = harness.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === SPIKE_STATE_ENTRY_TYPE).length;
    assert.ok(checkpointsBefore >= 1, "the run flushed a checkpoint");

    // Pi summarizes the conversation with the (scripted) model and drops the old messages from the context.
    harness.faux.setResponses([finalTurn("conversation summary")]);
    await harness.session.compact();
    assert.equal(
      harness.session.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
      true,
      "the session now carries a compaction entry",
    );
    assert.equal(harness.runtime().getState().successfulReads.size, 1, "the read ledger is not tied to the transcript");

    // The edit needs no second read, and the model still receives the Snapshot after the context was cut.
    await harness.run([toolTurn(editCall(target)), finalTurn()]);
    const applied = harness.toolOutcomes.at(-1);
    assert.equal(applied?.isError, false, applied?.text);
    assert.match(readFileSync(target, "utf8"), /for audit/);
    assert.match(harness.modelRequests.at(-2) ?? "", /Comparable implementations/);
    assert.deepEqual(
      harness.logRecords().filter((record) => record.event === "guard_decision").map((record) => record.payload.reasonCode),
      ["SNAPSHOT_VALID"],
    );
  });
});

test("real Pi: a reload restores the ledger from the branch and keeps the Guard working", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" } }, async (harness, target) => {
    await harness.run([toolTurn(readCall(target)), finalTurn("read it")]);
    assert.equal(harness.runtime().getState().successfulReads.size, 1);
    const firstRuntime = harness.runtime();

    await harness.session.reload();
    const reloaded = harness.runtime();
    assert.notEqual(reloaded, firstRuntime, "reload runs the extension factory again");
    assert.equal(reloaded.getState().restoredFromCheckpoint, true);
    assert.equal(reloaded.getState().successfulReads.size, 1, "the read survives the reload through the checkpoint");

    const lifecycle = harness.logRecords().filter((record) => ["session_shutdown", "session_start"].includes(record.event));
    assert.deepEqual(lifecycle.map((record) => `${record.event}:${record.payload.reason}`), [
      "session_start:startup",
      "session_shutdown:reload",
      "session_start:reload",
    ]);
    assert.equal(lifecycle.at(-1)?.payload.restoredFromCheckpoint, true);

    await harness.run([toolTurn(editCall(target)), finalTurn()]);
    const applied = harness.toolOutcomes.at(-1);
    assert.equal(applied?.isError, false, applied?.text);
    assert.deepEqual(
      harness.logRecords().filter((record) => record.event === "guard_decision").map((record) => record.payload.reasonCode),
      ["SNAPSHOT_VALID"],
    );
  });
});

test("real Pi: a reload that follows an unflushed ledger still starts clean", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" } }, async (harness, target) => {
    await harness.session.reload();
    assert.equal(harness.runtime().getState().restoredFromCheckpoint, false, "no checkpoint was ever written");
    await harness.run([toolTurn(editCall(target)), finalTurn()]);
    assert.match(harness.toolOutcomes[0]?.text ?? "", /TARGET_NOT_READ/, "an unread target is still a Discovery gap after the reload");
  });
});

test("real Pi: the bypass command offers completions from the targets the Guard was asked about", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" }, captureUi: true }, async (harness, target) => {
    const registered = harness.session.extensionRunner?.getRegisteredCommands().find((item) => item.name === "convention-bypass");
    assert.ok(registered?.getArgumentCompletions, "Pi sees the completion provider");
    assert.equal(await registered.getArgumentCompletions(""), null, "nothing asked yet");

    await harness.run([toolTurn(editCall(target)), finalTurn()]);
    const items = await registered.getArgumentCompletions("order");
    assert.deepEqual(items?.map((item) => item.value), [targetRelative.replaceAll("\\", "/")]);
    assert.match(items?.[0]?.description ?? "", /block TARGET_NOT_READ/);

    await harness.session.prompt("/convention-status");
    assert.match(lastNotification(harness), new RegExp(`^last-guard=block TARGET_NOT_READ \\(edit\\) ${targetRelative.replaceAll("\\", "/")}$`, "m"));
  });
});
