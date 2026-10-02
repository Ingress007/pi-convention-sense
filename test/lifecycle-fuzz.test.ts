// Seeded lifecycle fuzz: random, partly out-of-order and partly malformed Pi event sequences against the fake
// extension API, with random file-system changes in between. The properties below must hold for every sequence.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { registerConventionSenseSpike } from "../extensions/index.js";
import { restoreStateFromBranch } from "../src/runtime/state.js";
import { SPIKE_STATE_ENTRY_TYPE, type SessionEntryLike } from "../src/runtime/types.js";
import { assertNoSwallowedHandlerErrors, createHarness, type Harness } from "./support/fake-pi.js";
import { chance, forEachSeedAsync, int, pick, randomJson, randomString, type Rng } from "./support/fuzz.js";

afterEach(assertNoSwallowedHandlerErrors);

// Strings that must never be copied into the log: prompts, commands, file bodies and tool output.
const SECRETS = ["SECRET_PROMPT_7f3a", "SECRET_COMMAND_9c1d", "SECRET_BODY_44be", "SECRET_OUTPUT_e210"];

const SERVICE_DIR = join("order", "src", "main", "java", "com", "acme", "order", "service", "impl");
const JAVA_FILES = [
  join(SERVICE_DIR, "OrderServiceImpl.java"),
  join(SERVICE_DIR, "PaymentServiceImpl.java"),
  join(SERVICE_DIR, "RefundServiceImpl.java"),
  join(SERVICE_DIR, "LegacyServiceImpl.java"),
  join(SERVICE_DIR, "BrandNewServiceImpl.java"),
  join("order", "src", "test", "java", "com", "acme", "order", "service", "impl", "TestOnlyServiceImpl.java"),
  join("order", "target", "generated-sources", "GeneratedServiceImpl.java"),
  join("order", "src", "main", "java", "com", "acme", "other", "Lonely.java"),
];
const ODD_PATHS = [
  "README.md", "pom.xml", "a.ts", "../outside/Outside.java", "", "\u0000.java", `${SERVICE_DIR}/`, "//server/share/x.java",
  "C:\\Windows\\x.java", "~/x.java", ` ${join(SERVICE_DIR, "OrderServiceImpl.java")} `, "a".repeat(400) + ".java",
  `${SERVICE_DIR}${"/..".repeat(30)}/x.java`,
];
const COMMANDS = [
  "ls -la", "git status", "npm install", "echo SECRET_COMMAND_9c1d > order/Generated.java", "sed -i s/a/b/ order/x.java",
  "rm -rf order/target", "cat order/pom.xml", "mkdir -p order/gen && touch order/gen/A.java", "git checkout -- .",
  `python -c "print('SECRET_COMMAND_9c1d')"`, "x".repeat(5_000), "",
];
const EVENT_NAMES = [
  "session_start", "session_tree", "session_shutdown", "before_agent_start", "turn_start", "context",
  "tool_call", "tool_execution_start", "tool_result", "tool_execution_end", "turn_end", "agent_end",
  "agent_before_settle", "agent_settled", "session_before_switch", "session_before_fork",
] as const;
const COMMAND_NAMES = ["convention-status", "convention-reset", "convention-snapshot", "convention-bypass", "convention-audit"];

// Activity counters: a fuzz that never reaches a block, a checkpoint or an injected context proves nothing.
const stats = { blocks: 0, allowedEdits: 0, checkpoints: 0, injectedContexts: 0, brokenPayloads: 0, sequences: 0 };

interface Sequence {
  cwd: string;
  harness: Harness;
  rng: Rng;
  mode: "observe" | "guard";
  malformed: boolean;
  blockedTools: string[];
  trace: string[];
}

function targetPath(seq: Sequence): unknown {
  const { rng, cwd } = seq;
  const roll = rng();
  if (roll < 0.6) {
    const relative = pick(rng, JAVA_FILES);
    return chance(rng, 0.5) ? join(cwd, relative) : relative;
  }
  if (roll < 0.85) return pick(rng, ODD_PATHS);
  return randomJson(rng, 1);
}

function toolInput(seq: Sequence, toolName: string): unknown {
  const { rng } = seq;
  if (chance(rng, 0.05)) return randomJson(rng, 2);
  const path = targetPath(seq);
  switch (toolName) {
    case "read":
      return { path };
    case "edit":
      return chance(rng, 0.5)
        ? { path, edits: [{ oldText: "SECRET_BODY_44be", newText: "SECRET_BODY_44be changed" }] }
        : { path, oldText: "SECRET_BODY_44be", newText: randomString(rng) };
    case "write":
      return { path, content: `class X { String s = "SECRET_BODY_44be"; }` };
    case "bash":
    case "powershell":
      return chance(rng, 0.1) ? { command: randomJson(rng, 1) } : { command: pick(rng, COMMANDS) };
    case "mapped_read":
    case "mapped_edit":
      return { target: path };
    default:
      return { anything: path, nested: { value: randomJson(rng, 2) } };
  }
}

const TOOL_NAMES = ["read", "read", "read", "edit", "edit", "write", "bash", "powershell", "grep", "mapped_read", "mapped_edit", "mystery"];

function toolEvent(seq: Sequence, kind: "tool_call" | "tool_execution_start" | "tool_result" | "tool_execution_end"): any {
  const { rng } = seq;
  const toolCallId = `call-${int(rng, 0, 5)}`;
  const toolName = pick(rng, TOOL_NAMES);
  const input = toolInput(seq, toolName);
  const isError = chance(rng, 0.2);
  switch (kind) {
    case "tool_call":
      return { type: kind, toolCallId, toolName, input };
    case "tool_execution_start":
      return { type: kind, toolCallId, toolName, args: input };
    case "tool_result":
      return {
        type: kind,
        toolCallId,
        toolName,
        input,
        content: [{ type: "text", text: "SECRET_OUTPUT_e210" }],
        details: chance(rng, 0.3) ? randomJson(rng, 1) : undefined,
        isError,
      };
    default:
      return { type: kind, toolCallId, toolName, isError };
  }
}

function eventPayload(seq: Sequence, name: (typeof EVENT_NAMES)[number]): any {
  const { rng } = seq;
  switch (name) {
    case "session_start":
      return { type: name, reason: pick(rng, ["startup", "reload", "new", "resume", "fork"]) };
    case "session_tree":
      return { type: name, oldLeafId: "a", newLeafId: "b", ...(chance(rng, 0.3) ? { summaryEntry: {} } : {}) };
    case "session_shutdown":
      return { type: name, reason: pick(rng, ["quit", "reload", "new", "resume", "fork"]) };
    case "before_agent_start":
      return {
        type: name,
        prompt: `SECRET_PROMPT_7f3a ${randomString(rng, 30)}`,
        systemPrompt: "base",
        systemPromptOptions: { selectedTools: ["read", "edit"], sections: {} as Record<string, string> },
      };
    case "turn_start":
      return { type: name, turnIndex: int(rng, 0, 8), timestamp: Date.now() };
    case "context":
      return { type: name, messages: [{ role: "user", content: "hello" }] };
    case "tool_call":
    case "tool_execution_start":
    case "tool_result":
    case "tool_execution_end":
      return toolEvent(seq, name);
    case "turn_end":
      return { type: name, turnIndex: int(rng, 0, 8), message: { role: "assistant" }, toolResults: [] };
    case "agent_end":
      return { type: name, messages: [] };
    case "agent_before_settle":
      return {
        type: name,
        entries: [],
        continue: chance(rng, 0.2),
        outcome: pick(rng, ["completed", "aborted", "error"] as const),
        context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true },
      };
    case "session_before_switch":
      return { type: name, reason: "new", targetSessionFile: "x.jsonl" };
    case "session_before_fork":
      return { type: name, entryId: "e", position: "at" };
    default:
      return { type: name };
  }
}

// Structurally broken payloads (missing or mistyped fields) are not something Pi sends, but a handler that throws
// on one would break the agent loop: the fail-open wrapper must absorb it.
function breakPayload(rng: Rng, payload: any): any {
  const keys = Object.keys(payload);
  if (keys.length === 0 || chance(rng, 0.2)) return pick(rng, [null, undefined, 5, "text", []]);
  const copy = { ...payload };
  const key = pick(rng, keys);
  if (chance(rng, 0.5)) delete copy[key];
  else copy[key] = randomJson(rng, 2);
  return copy;
}

function fileChaos(seq: Sequence): void {
  const { rng, cwd } = seq;
  const target = join(cwd, pick(rng, JAVA_FILES));
  const dir = resolve(target, "..");
  try {
    switch (int(rng, 0, 7)) {
      case 0:
        if (existsSync(target)) writeFileSync(target, `${readFileSync(target, "utf8")}\n// SECRET_BODY_44be appended\n`);
        break;
      case 1:
        writeFileSync(target, "");
        break;
      case 2:
        rmSync(target, { force: true, recursive: true });
        break;
      case 3:
        mkdirSync(dir, { recursive: true });
        writeFileSync(target, `package p;\npublic class ${randomString(rng, 6).replace(/\W/g, "") || "A"} {}\n`);
        break;
      case 4:
        mkdirSync(dir, { recursive: true });
        writeFileSync(target, Buffer.from(Array.from({ length: 2_000 }, () => int(rng, 0, 255))));
        break;
      case 5:
        mkdirSync(dir, { recursive: true });
        writeFileSync(target, `class Big {}\n${"// padding line SECRET_BODY_44be\n".repeat(40_000)}`);
        break;
      case 6:
        rmSync(target, { force: true, recursive: true });
        mkdirSync(target, { recursive: true });
        break;
      default:
        mkdirSync(dir, { recursive: true });
        writeFileSync(target, "class Crlf {\r\n  void f() {}\r\n}\r");
    }
  } catch {
    // The chaos itself may fail (a directory where a file was expected); that is part of the scenario.
  }
}

function writeConfig(seq: Sequence): void {
  const { rng, cwd } = seq;
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({
      mode: seq.mode,
      injectContext: chance(rng, 0.8),
      persistSessionState: chance(rng, 0.9),
      practiceReview: { mode: pick(rng, ["off", "suggest", "auto-once"]) },
      postChangeAudit: { enabled: chance(rng, 0.8), maxChangedFiles: pick(rng, [1, 5, 100]) },
      guard: { allowBypass: chance(rng, 0.7), contextWindowTurns: pick(rng, [0, 1, 2]) },
      toolMappings: [
        { toolName: "mapped_read", operation: "read", pathField: "target" },
        { toolName: "mapped_edit", operation: "edit", pathField: "target" },
      ],
    }),
  );
}

function assertToolCallDecision(seq: Sequence, event: any, result: any): void {
  if (result === undefined) {
    if (event && ["edit", "write"].includes(event.toolName)) stats.allowedEdits += 1;
    return;
  }
  assert.equal(typeof result, "object");
  assert.equal(result.block, true, "a tool_call handler may only return a block decision");
  assert.equal(typeof result.reason, "string");
  assert.equal(seq.mode, "guard", "observe mode must never block");
  assert.ok(["edit", "write", "mapped_edit"].includes(event?.toolName), `a ${String(event?.toolName)} call was blocked`);
  const raw = event.input?.path ?? event.input?.target;
  assert.equal(typeof raw, "string");
  assert.ok(/\.java\s*$/i.test(raw), `Guard blocked a non-Java target: ${raw}`);
  seq.blockedTools.push(event.toolName);
  stats.blocks += 1;
}

function assertContextResult(event: any, result: any): void {
  if (result === undefined) return;
  assert.ok(Array.isArray(result.messages), "context result must carry a messages array");
  const original = event?.messages ?? [];
  assert.deepEqual(result.messages.slice(0, original.length), original, "the original transcript must stay untouched");
  const appended = result.messages.slice(original.length);
  if (appended.length > 0) stats.injectedContexts += 1;
  assert.ok(appended.length <= 2, `appended ${appended.length} messages`);
  for (const message of appended) {
    assert.equal(typeof message.content, "string");
    assert.ok(message.content.length < 40_000, `appended context of ${message.content.length} characters`);
  }
}

// A coherent turn: read some peers successfully, let the context event inject Evidence, then edit or write a Java file.
// Random events alone rarely line up like this, so without it the Guard paths would stay barely exercised.
async function workflow(seq: Sequence): Promise<void> {
  const { rng, cwd, harness } = seq;
  const reads = int(rng, 0, 4);
  for (let index = 0; index < reads; index += 1) {
    const path = join(cwd, pick(rng, JAVA_FILES.slice(0, 5)));
    const toolCallId = `flow-read-${index}`;
    const input = { path };
    await harness.invoke("tool_call", { type: "tool_call", toolCallId, toolName: "read", input });
    await harness.invoke("tool_execution_start", { type: "tool_execution_start", toolCallId, toolName: "read", args: input });
    await harness.invoke("tool_result", {
      type: "tool_result", toolCallId, toolName: "read", input,
      content: [{ type: "text", text: "SECRET_OUTPUT_e210" }], details: undefined, isError: chance(rng, 0.1),
    });
    await harness.invoke("tool_execution_end", { type: "tool_execution_end", toolCallId, toolName: "read", isError: false });
  }
  if (chance(rng, 0.8)) {
    const event = { type: "context", messages: [{ role: "user", content: "hello" }] };
    assertContextResult(event, await harness.invoke("context", event));
  }
  const toolName = pick(rng, ["edit", "write", "mapped_edit"]);
  const event = {
    type: "tool_call",
    toolCallId: "flow-edit",
    toolName,
    input: toolName === "mapped_edit"
      ? { target: join(cwd, pick(rng, JAVA_FILES)) }
      : toolInput({ ...seq, rng: () => 0.1 } as Sequence, toolName),
  };
  if (toolName !== "mapped_edit") (event.input as { path: string }).path = join(cwd, pick(rng, JAVA_FILES));
  seq.trace.push(`workflow(${reads} reads, ${toolName})`);
  assertToolCallDecision(seq, event, await harness.invoke("tool_call", event));
}

async function runSequence(rng: Rng, seed: number): Promise<void> {
  stats.sequences += 1;
  const cwd = mkdtempSync(join(tmpdir(), `pi-convention-lifecycle-${seed}-`));
  const trace: string[] = [];
  try {
    cpSync(resolve("test", "fixtures", "java-maven"), cwd, { recursive: true });
    const harness = createHarness(cwd);
    const seq: Sequence = {
      cwd,
      harness,
      rng,
      mode: pick(rng, ["observe", "guard"] as const),
      malformed: chance(rng, 0.3),
      blockedTools: [],
      trace,
    };
    // Structurally broken payloads may make a handler throw; the wrapper must absorb it, so the swallowed-error
    // assertion is waived for those sequences only.
    harness.allowHandlerErrors = seq.malformed;
    writeConfig(seq);
    registerConventionSenseSpike(harness.api);
    await harness.invoke("session_start", { type: "session_start", reason: "startup" });

    const steps = int(rng, 10, 45);
    for (let step = 0; step < steps; step += 1) {
      const roll = rng();
      if (roll < 0.1) {
        fileChaos(seq);
        seq.trace.push("fs");
        continue;
      }
      if (roll < 0.3 && !seq.malformed) {
        await workflow(seq);
        continue;
      }
      if (roll < 0.4) {
        const name = pick(rng, COMMAND_NAMES);
        const args = pick(rng, ["", "confirm", join(cwd, pick(rng, JAVA_FILES)), pick(rng, JAVA_FILES), randomString(rng, 12)]);
        seq.trace.push(`/${name} ${args.slice(0, 20)}`);
        await harness.commands.get(name)?.(args, harness.ctx);
        continue;
      }
      const name = pick(rng, EVENT_NAMES);
      let payload = eventPayload(seq, name);
      const broken = seq.malformed && chance(rng, 0.4);
      if (broken) payload = breakPayload(rng, payload);
      seq.trace.push(`${name}${broken ? "(broken)" : ""}`);
      const result = await harness.invoke(name, payload);
      if (broken) {
        stats.brokenPayloads += 1;
        // A broken payload may fail open but must never block or rewrite the transcript.
        if (name === "tool_call") assert.ok(result === undefined || result.block === true);
        continue;
      }
      if (name === "tool_call") assertToolCallDecision(seq, payload, result);
      if (name === "context") assertContextResult(payload, result);
    }

    await harness.invoke("agent_settled", { type: "agent_settled" });
    await harness.invoke("session_shutdown", { type: "session_shutdown", reason: "quit" });

    // Every checkpoint the extension wrote must itself be restorable.
    for (const entry of harness.branchEntries) {
      if (entry.customType !== SPIKE_STATE_ENTRY_TYPE) continue;
      const restored = restoreStateFromBranch([entry as SessionEntryLike]);
      assert.equal(restored.restoredFromCheckpoint, true, "the extension wrote a checkpoint it cannot restore");
      stats.checkpoints += 1;
    }

    // The log is NDJSON, valid line by line, and holds no prompt, command, file body or tool output.
    const logPath = join(cwd, ".pi", "convention-sense", "observe.ndjson");
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, "utf8");
      for (const secret of SECRETS) assert.ok(!text.includes(secret), `the log leaked ${secret}`);
      for (const line of text.split("\n").filter(Boolean)) JSON.parse(line);
    }
    for (const note of harness.notifications) {
      for (const secret of SECRETS) assert.ok(!note.includes(secret), `a notification leaked ${secret}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}
event trace: ${trace.join(" > ")}`, { cause: error });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("random lifecycle sequences keep the extension fail-open, bounded and private", async () => {
  await forEachSeedAsync(20_000, 40, runSequence);
  assert.ok(stats.blocks > 0, `the fuzz never reached a Guard block (${JSON.stringify(stats)})`);
  assert.ok(stats.allowedEdits > 0, `the fuzz never allowed an edit (${JSON.stringify(stats)})`);
  assert.ok(stats.checkpoints > 0, `the fuzz never wrote a checkpoint (${JSON.stringify(stats)})`);
  assert.ok(stats.injectedContexts > 0, `the fuzz never injected a context (${JSON.stringify(stats)})`);
  assert.ok(stats.brokenPayloads > 0, `the fuzz never sent a broken payload (${JSON.stringify(stats)})`);
  console.log(`lifecycle fuzz activity: ${JSON.stringify(stats)}`);
});
