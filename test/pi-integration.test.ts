// Real Pi lifecycle tests: Pi's own resource loader, agent loop, tool runner and extension runner,
// driven by a scripted offline model. These replace guesses about Pi's behavior (made by the
// hand-written fake in extension.test.ts) with the real thing.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { SPIKE_STATE_ENTRY_TYPE } from "../src/runtime/types.js";
import { createPiHarness, finalTurn, toolTurn, userTextMatching, type PiHarness } from "./support/pi-session.js";

const fixture = resolve("test", "fixtures", "java-maven");
const targetRelative = join("order", "src", "main", "java", "com", "acme", "order", "service", "impl", "OrderServiceImpl.java");
const OLD_LINE = 'log.info("creating order {}", request.getId());';
const NEW_LINE = 'log.info("creating order {} for audit", request.getId());';

function seedJavaProject(cwd: string): void {
  cpSync(fixture, cwd, { recursive: true });
}

function editCall(target: string) {
  return { name: "edit", args: { path: target, edits: [{ oldText: OLD_LINE, newText: NEW_LINE }] } };
}

function readCall(target: string) {
  return { name: "read", args: { path: target } };
}

async function withHarness(
  options: Parameters<typeof createPiHarness>[0],
  body: (harness: PiHarness, target: string) => Promise<void>,
  // Fault-injection tests expect swallowed handler errors; every other test must see none.
  settings: { allowHandlerErrors?: boolean } = {},
): Promise<void> {
  const harness = await createPiHarness(options);
  try {
    assert.deepEqual(harness.extensionErrors, [], "the extension must load and start without errors");
    await body(harness, join(harness.cwd, targetRelative));
    if (!settings.allowHandlerErrors) {
      const swallowed = harness.logRecords().filter((record) => record.event === "handler_error");
      assert.deepEqual(swallowed, [], "a handler threw: the fail-open wrapper hid it from this test");
    }
  } finally {
    harness.dispose();
  }
}

test("Pi's resource loader loads the package manifest's extension and Skill from TypeScript source", async () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { pi: { extensions: string[]; skills: string[] } };
  const cwd = mkdtempSync(join(tmpdir(), "pi-convention-loader-"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: manifest.pi.extensions.map((path) => resolve(path)),
    additionalSkillPaths: manifest.pi.skills.map((path) => resolve(path)),
  });
  await loader.reload();

  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  const [extension] = extensions;
  assert.ok(extension);
  for (const event of [
    "session_start",
    "session_tree",
    "session_shutdown",
    "before_agent_start",
    "context",
    "tool_execution_start",
    "tool_call",
    "tool_result",
    "tool_execution_end",
    "agent_before_settle",
    "agent_settled",
  ]) {
    assert.ok(extension.handlers.has(event), `missing handler: ${event}`);
  }
  assert.deepEqual(
    [...extension.commands.keys()].sort(),
    ["convention-audit", "convention-bypass", "convention-reset", "convention-snapshot", "convention-status"],
  );

  const skills = loader.getSkills();
  assert.deepEqual(skills.diagnostics, []);
  assert.deepEqual(skills.skills.map((skill) => skill.name), ["project-profiler"]);
});

test("real Pi: Guard blocks an unread edit, then allows it after Discovery and Context injection", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" } }, async (harness, target) => {
    const edit = editCall(target);
    await harness.run([toolTurn(edit), toolTurn(readCall(target)), toolTurn(edit), finalTurn()]);

    const [blocked, read, applied] = harness.toolOutcomes;
    assert.ok(blocked && read && applied);
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /Convention Guard blocked/);
    assert.match(blocked.text, /TARGET_NOT_READ/);
    assert.equal(read.isError, false);
    assert.equal(applied.isError, false, applied.text);
    assert.match(readFileSync(target, "utf8"), /creating order \{\} for audit/);

    // Stable guidance rides in the system prompt; the dynamic Snapshot is injected only after the read.
    assert.match(harness.modelRequests[0] ?? "", /Local Convention Evidence/);
    assert.match(harness.modelRequests[0] ?? "", /No valid convention snapshot/);
    assert.match(harness.modelRequests[2] ?? "", /Comparable implementations/);

    assert.deepEqual(
      harness.logRecords().filter((record) => record.event === "guard_decision").map((record) => record.payload.reasonCode),
      ["TARGET_NOT_READ", "SNAPSHOT_VALID"],
    );
  });
});

test("real Pi: tool_call hooks run before sibling tools execute, so a pending read never satisfies Guard", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" } }, async (harness, target) => {
    const before = readFileSync(target, "utf8");
    await harness.run([toolTurn(readCall(target), editCall(target)), finalTurn()]);

    const read = harness.toolOutcomes.find((outcome) => outcome.tool === "read");
    const edit = harness.toolOutcomes.find((outcome) => outcome.tool === "edit");
    assert.equal(read?.isError, false);
    assert.equal(edit?.isError, true);
    assert.match(edit?.text ?? "", /TARGET_NOT_READ/);
    assert.equal(readFileSync(target, "utf8"), before, "the blocked edit must not touch the file");
  });
});

for (const mode of ["observe", "guard"] as const) {
  test(`real Pi: an unexpected analysis exception never blocks the tool (${mode} mode)`, async () => {
    let runtimeHandle: ReturnType<PiHarness["runtime"]> | undefined;
    await withHarness(
      { seed: seedJavaProject, config: { mode }, onRuntime: (runtime) => (runtimeHandle = runtime) },
      async (harness, target) => {
        const edit = editCall(target);
        // After the read succeeds, a transient filesystem error hits the Snapshot freshness check.
        const breakFreshness = () => {
          const cache = runtimeHandle?.getSnapshotCache();
          assert.ok(cache);
          cache.getFresh = () => {
            throw Object.assign(new Error("EBUSY SECRET_ERROR_TEXT"), { code: "EBUSY" });
          };
          return toolTurn(edit);
        };
        await harness.run([toolTurn(readCall(target)), breakFreshness, finalTurn()]);

        const applied = harness.toolOutcomes.find((outcome) => outcome.tool === "edit");
        assert.equal(applied?.isError, false, `Pi must not fail-safe block the edit: ${applied?.text}`);
        assert.match(readFileSync(target, "utf8"), /creating order \{\} for audit/);
        assert.deepEqual(harness.extensionErrors, [], "handlers must swallow their own errors");

        const errors = harness.logRecords().filter((record) => record.event === "handler_error");
        assert.ok(errors.some((record) => record.payload.handlerEvent === "tool_call"));
        assert.ok(errors.every((record) => record.payload.errorCode === "EBUSY"));
        assert.ok(
          errors.every((record) => /:\d+/.test(String(record.payload.errorLocation))),
          "each error carries file:line so a plain bug is locatable",
        );
        assert.doesNotMatch(JSON.stringify(harness.logRecords()), /SECRET_ERROR_TEXT/);
      },
      { allowHandlerErrors: true },
    );
  });
}

test("real Pi: the ledger is flushed when the run settles and follows real branch navigation", async () => {
  await withHarness({ seed: seedJavaProject, config: { mode: "guard" } }, async (harness, target) => {
    const manager = harness.session.sessionManager;
    const checkpoints = () => manager.getEntries().filter(
      (entry) => entry.type === "custom" && entry.customType === SPIKE_STATE_ENTRY_TYPE,
    );

    await harness.run([toolTurn(readCall(target)), finalTurn()], "read the service");
    assert.equal(harness.runtime().getState().successfulReads.size, 1);
    assert.equal(checkpoints().length, 1, "one checkpoint per run, appended through the real session manager");
    const settledLeaf = manager.getLeafId();
    assert.ok(settledLeaf);

    // Navigate back to the first user message: the checkpoint is not on that branch.
    const firstUser = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
    assert.ok(firstUser);
    await harness.session.navigateTree(firstUser.id, { summarize: false });
    assert.equal(harness.runtime().getState().successfulReads.size, 0, "the other branch has no read ledger");

    await harness.run([toolTurn(editCall(target)), finalTurn()], "now edit it");
    const edit = harness.toolOutcomes.filter((outcome) => outcome.tool === "edit").at(-1);
    assert.equal(edit?.isError, true);
    assert.match(edit?.text ?? "", /TARGET_NOT_READ/);

    // Navigate back to where the read happened: the ledger is rebuilt from that branch's checkpoint.
    await harness.session.navigateTree(settledLeaf, { summarize: false });
    assert.equal(harness.runtime().getState().successfulReads.size, 1);
  });
});

const PRACTICE_SERVICE = `
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
`;

function seedPracticeProject(cwd: string): void {
  seedJavaProject(cwd);
  writeFileSync(join(cwd, targetRelative), PRACTICE_SERVICE);
}

const AUTO_ONCE = { mode: "observe", practiceReview: { mode: "auto-once", maxContextTokens: 400 } };

test("real Pi: auto-once asks the current Agent to review a risky change exactly once", async () => {
  await withHarness({ seed: seedPracticeProject, config: AUTO_ONCE }, async (harness, target) => {
    const riskyEdit = {
      name: "edit",
      args: {
        path: target,
        edits: [{ oldText: "validateOrder(order);", newText: "validateOrder(order);\n    auditGateway.publish(order);" }],
      },
    };
    await harness.run([
      toolTurn(readCall(target)),
      toolTurn(riskyEdit),
      finalTurn("implemented"),
      finalTurn("reviewed: no further changes"), // the one continuation Pi grants
    ]);

    assert.equal(harness.faux.state.callCount, 4, "one extra model request, and only one");
    assert.equal(harness.faux.getPendingResponseCount(), 0);
    assert.doesNotMatch(harness.modelRequests[2] ?? "", /engineering-practice-review/, "no review before the run settles");
    assert.match(harness.modelRequests[3] ?? "", /engineering-practice/, "the continuation carries the bounded review question");
    const review = userTextMatching(harness.modelMessages[3], /<engineering-practice-review/);
    assert.match(review, /<engineering-practice-review status="one-shot">/);
    assert.doesNotMatch(review, /\.publish\(|\.update\(|setStatus/, "the review message must not contain source text");
    assert.ok(review.length < 2400, "the review stays bounded");

    const decisions = harness.logRecords().filter((record) => record.event === "practice_review_decision");
    assert.deepEqual(decisions.map((record) => `${record.payload.action}:${record.payload.reason}`), [
      "continue:practice-signals",
      "skip:already-requested",
    ]);
    assert.equal(harness.runtime().getState().guardCounters.block, 0, "Practice never changes Guard decisions");
  });
});

test("real Pi: auto-once stays silent for a simple edit", async () => {
  await withHarness({ seed: seedPracticeProject, config: AUTO_ONCE }, async (harness, target) => {
    await harness.run([
      toolTurn(readCall(target)),
      toolTurn({
        name: "edit",
        args: { path: target, edits: [{ oldText: "validateOrder(order);", newText: "validateOrder( order );" }] },
      }),
      finalTurn("implemented"),
    ]);

    assert.equal(harness.faux.state.callCount, 3, "a marker-free edit must not trigger a self-review");
    const decisions = harness.logRecords().filter((record) => record.event === "practice_review_decision");
    assert.deepEqual(decisions.map((record) => `${record.payload.action}:${record.payload.reason}`), [
      "skip:no-relevant-mutation",
    ]);
  });
});
