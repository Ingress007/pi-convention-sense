import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import {
  applyStableGuidanceSection,
  buildDynamicContext,
  STABLE_GUIDANCE_MARKER,
  STABLE_GUIDANCE_SECTION,
} from "../src/runtime/context.js";
import { loadSpikeConfig } from "../src/runtime/config.js";
import { NdjsonSpikeLogger } from "../src/runtime/logger.js";
import { evaluateConventionGuard, type ConventionGuardInput } from "../src/guard/convention-guard.js";
import { classifyShellMutationRisk, isPathInside, normalizeToolPath } from "../src/runtime/paths.js";
import { describeHandlerError, HandlerErrorLimiter } from "../src/runtime/handler-errors.js";
import { isCaseInsensitivePlatform, pathKey, PathSet } from "../src/runtime/path-key.js";
import { isRacyClean, RACY_WINDOW_MS } from "../src/runtime/racy-clean.js";
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
      practiceReview: { mode: "off", maxContextTokens: 280 },
      logging: { explainRanking: false },
    }),
  );
  const loaded = loadSpikeConfig(cwd, true);
  assert.equal(loaded.config.minEvidenceFiles, 4);
  assert.equal(loaded.config.maxEvidenceFiles, 4);
  assert.equal(loaded.config.maxContextTokens, 600);
  assert.deepEqual(loaded.config.includeLanguages, ["java"]);
  assert.deepEqual(loaded.config.exclude, ["**/out/**"]);
  assert.equal(loaded.config.practiceReview.mode, "off");
  assert.equal(loaded.config.practiceReview.maxContextTokens, 280);
  assert.equal(loaded.config.logging.explainRanking, false);
  assert.match(loaded.diagnostics.join("\n"), /Raised maxEvidenceFiles/);
});

test("invalid Practice config falls back to bounded suggest mode", () => {
  const cwd = tempProject();
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({ practiceReview: { mode: "always", maxContextTokens: 5000 } }),
  );

  const loaded = loadSpikeConfig(cwd, true);
  assert.equal(loaded.config.practiceReview.mode, "suggest");
  assert.equal(loaded.config.practiceReview.maxContextTokens, 400);
  assert.match(loaded.diagnostics.join("\n"), /expected off, suggest, or auto-once/);
  assert.match(loaded.diagnostics.join("\n"), /maxContextTokens/);
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
  const guardInput = (): ConventionGuardInput => ({
    config,
    targetPath: target,
    targetExists: true,
    targetRead: state.successfulReads.has(target),
    snapshotInjected: false,
    bypassGranted: false,
  });
  const whilePending = evaluateConventionGuard(guardInput());
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
  // The read no longer blocks; what is left is the Discovery gap that follows it (no Snapshot has been built here).
  assert.equal(evaluateConventionGuard(guardInput()).reasonCode, "SNAPSHOT_MISSING");
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

test("guard mode blocks existing unread files, while a new file never needs a prior read", () => {
  const cwd = tempProject();
  const state = createSpikeState();
  const config = { ...loadSpikeConfig(cwd, true).config, mode: "guard" as const };
  const existing = normalizeToolPath(cwd, "existing.ts");
  const next = normalizeToolPath(cwd, "new.ts");
  const decide = (targetPath: string, targetExists: boolean) =>
    evaluateConventionGuard({
      config,
      targetPath,
      targetExists,
      targetRead: state.successfulReads.has(targetPath),
      snapshotInjected: false,
      bypassGranted: false,
    });

  const blocked = decide(existing, true);
  assert.equal(blocked.action, "block");
  assert.equal(blocked.reasonCode, "TARGET_NOT_READ");

  const newFile = decide(next, false);
  assert.notEqual(newFile.reasonCode, "TARGET_NOT_READ", "a file that does not exist yet cannot have been read");
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

test("pathKey folds case only on case-insensitive platforms", () => {
  const lower = join("/repo", "src", "a.ts");
  const upper = join("/REPO", "SRC", "A.ts");
  assert.equal(pathKey(lower, "win32"), pathKey(upper, "win32"));
  assert.equal(pathKey(lower, "darwin"), pathKey(upper, "darwin"));
  assert.notEqual(pathKey(lower, "linux"), pathKey(upper, "linux"));
  assert.equal(isCaseInsensitivePlatform("win32"), true);
  assert.equal(isCaseInsensitivePlatform("darwin"), true);
  assert.equal(isCaseInsensitivePlatform("linux"), false);
});

test("PathSet matches by platform path key but keeps the original spelling", () => {
  const original = join(resolve("/repo"), "Order.java");
  const variant = join(resolve("/repo"), "order.java");
  const set = new PathSet([original]);
  assert.equal(set.has(original), true);
  assert.equal(set.has(variant), isCaseInsensitivePlatform());

  set.add(variant);
  assert.equal(set.size, isCaseInsensitivePlatform() ? 1 : 2);
  assert.equal([...set][0], original, "iteration (and therefore checkpoints) must keep the first spelling");

  assert.equal(set.delete(variant), isCaseInsensitivePlatform());
  assert.equal(set.has(original), !isCaseInsensitivePlatform());
});

test("the read ledger recognizes a differently cased path on case-insensitive platforms", () => {
  const state = createSpikeState();
  const cwd = resolve("/repo");
  recordToolResult(
    state,
    { toolCallId: "r1", toolName: "read", input: { path: "Src/A.java" }, isError: false },
    cwd,
    1,
  );
  assert.equal(state.successfulReads.has(resolve(cwd, "src/a.java")), isCaseInsensitivePlatform());
  recordToolResult(
    state,
    { toolCallId: "r2", toolName: "read", input: { path: "src/a.java" }, isError: false },
    cwd,
    2,
  );
  assert.equal(state.recentReads.length, isCaseInsensitivePlatform() ? 1 : 2, "recent reads must not duplicate one file");
});

test("logPath is confined to the plugin state directory", () => {
  const cwd = tempProject();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const fallback = loadSpikeConfig(cwd, true).config.logPath;
  const load = (logPath: string) => {
    writeFileSync(join(cwd, ".pi", "convention-sense.json"), JSON.stringify({ logPath }));
    return loadSpikeConfig(cwd, true);
  };

  for (const outside of [
    "../escaped.ndjson",
    "..\escaped.ndjson",
    resolve(cwd, "..", "escaped.ndjson"),
    "package.json",
    ".pi/settings.json",
    ".pi/extensions/loaded.ts",
    ".pi/convention-sense/../settings.json",
    ".pi/convention-sense",
  ]) {
    const loaded = load(outside);
    assert.equal(loaded.config.logPath, fallback, `${outside} must fall back to the default log path`);
    assert.ok(
      loaded.diagnostics.some((message) => /logPath/.test(message)),
      `${outside} must explain why it was ignored`,
    );
  }

  for (const inside of [
    ".pi/convention-sense/custom.ndjson",
    ".pi/convention-sense/runs/2026-10.ndjson",
    resolve(cwd, ".pi", "convention-sense", "absolute.ndjson"),
  ]) {
    const loaded = load(inside);
    assert.equal(loaded.config.logPath, inside);
    assert.deepEqual(loaded.diagnostics, []);
  }
});

test("logPath must not travel through a symbolic link or junction", () => {
  const cwd = tempProject();
  const elsewhere = tempProject();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  try {
    symlinkSync(elsewhere, join(cwd, ".pi", "convention-sense"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    return; // The platform or account cannot create links; nothing to verify here.
  }
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({ logPath: ".pi/convention-sense/redirected.ndjson" }),
  );
  const loaded = loadSpikeConfig(cwd, true);
  assert.equal(loaded.config.logPath, ".pi/convention-sense/observe.ndjson");
  assert.ok(loaded.diagnostics.some((message) => /logPath.*link/i.test(message)));
  assert.equal(loaded.config.logging.level, "silent", "the default location is linked too, so logging is disabled");
});

test("checkpoints keep the most recent reads and restore them", () => {
  const cwd = resolve("/repo");
  const state = createSpikeState();
  const read = (name: string, now: number) =>
    recordToolResult(
      state,
      { toolCallId: `read-${name}-${now}`, toolName: "read", input: { path: name }, isError: false },
      cwd,
      now,
    );
  for (let index = 0; index < 400; index += 1) read(`File${index}.java`, index);
  read("File0.java", 1000); // an old file that is read again becomes recent again

  const checkpoint = checkpointState(state);
  assert.equal(checkpoint.successfulReads.length, 300);
  assert.ok(checkpoint.successfulReads.includes(resolve(cwd, "File0.java")), "a re-read file is recent");
  assert.ok(!checkpoint.successfulReads.includes(resolve(cwd, "File1.java")), "the oldest reads are dropped");
  assert.ok(checkpoint.successfulReads.includes(resolve(cwd, "File399.java")));
  assert.equal(state.successfulReads.size, 400, "the live ledger is not trimmed, only the checkpoint");

  const restored = restoreStateFromBranch([
    { type: "custom", customType: SPIKE_STATE_ENTRY_TYPE, data: checkpoint },
  ]);
  assert.equal(restored.successfulReads.size, 300);
  assert.equal(restored.successfulReads.has(resolve(cwd, "File399.java")), true);
});

function trySymlink(target: string, path: string, type: "file" | "dir" | "junction"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false; // The platform or account cannot create links.
  }
}

test("a symlinked default log file disables logging instead of writing through the link", (t) => {
  const cwd = tempProject();
  const outside = join(tempProject(), "outside.txt");
  writeFileSync(outside, "ORIGINAL\n");
  mkdirSync(join(cwd, ".pi", "convention-sense"), { recursive: true });
  if (!trySymlink(outside, join(cwd, ".pi", "convention-sense", "observe.ndjson"), "file")) {
    t.skip("file symlinks cannot be created here");
    return;
  }

  // The default path is used when there is no project config and when the project is untrusted.
  for (const trusted of [false, true]) {
    const loaded = loadSpikeConfig(cwd, trusted);
    assert.equal(loaded.config.logging.level, "silent", `trusted=${trusted}: logging must be disabled`);
    assert.ok(loaded.diagnostics.some((message) => /log.*(symbolic link|junction)/i.test(message)));
  }
});

test("a custom logPath that is a symlinked file falls back to the default path", (t) => {
  const cwd = tempProject();
  const outside = join(tempProject(), "outside.txt");
  writeFileSync(outside, "ORIGINAL\n");
  mkdirSync(join(cwd, ".pi", "convention-sense"), { recursive: true });
  if (!trySymlink(outside, join(cwd, ".pi", "convention-sense", "custom.ndjson"), "file")) {
    t.skip("file symlinks cannot be created here");
    return;
  }
  writeFileSync(
    join(cwd, ".pi", "convention-sense.json"),
    JSON.stringify({ logPath: ".pi/convention-sense/custom.ndjson" }),
  );

  const loaded = loadSpikeConfig(cwd, true);
  assert.equal(loaded.config.logPath, ".pi/convention-sense/observe.ndjson");
  assert.notEqual(loaded.config.logging.level, "silent", "the real default path is safe, so logging stays on");
  assert.ok(loaded.diagnostics.some((message) => /logPath.*(symbolic link|junction)/i.test(message)));
});

test("the logger itself refuses to append through a symbolic link", (t) => {
  const dir = tempProject();
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "ORIGINAL\n");
  const link = join(dir, "observe.ndjson");
  if (!trySymlink(outside, link, "file")) {
    t.skip("file symlinks cannot be created here");
    return;
  }

  const logger = new NdjsonSpikeLogger(link, "info");
  logger.write("probe_event", { note: "must not reach the outside file" });
  assert.equal(readFileSync(outside, "utf8"), "ORIGINAL\n");
  assert.match(logger.lastError ?? "", /symbolic link/i);
});

test("isPathInside is the single definition of 'inside this directory'", () => {
  const root = resolve("/repo", "project");
  assert.equal(isPathInside(root, join(root, "a", "b.ts")), true);
  assert.equal(isPathInside(root, root), false, "the root itself is not strictly inside");
  assert.equal(isPathInside(root, root, { allowEqual: true }), true);
  assert.equal(isPathInside(root, resolve(root, "..", "sibling", "x.ts")), false);
  assert.equal(isPathInside(root, resolve(root, "..")), false);
  assert.equal(isPathInside(root, `${root}-other${sep}x.ts`), false, "a sibling sharing the name prefix is outside");
  assert.equal(isPathInside(root, join(root, "..hidden", "x.ts")), true, "a directory named '..hidden' is inside");
});

test("describeHandlerError reports name, code and location without the message", () => {
  function failingHelper(): never {
    throw Object.assign(new TypeError("SECRET_MESSAGE containing source text"), { code: "ERR_PROBE" });
  }
  let thrown: unknown;
  try {
    failingHelper();
  } catch (error) {
    thrown = error;
  }
  const described = describeHandlerError(thrown);
  assert.equal(described.errorName, "TypeError");
  assert.equal(described.errorCode, "ERR_PROBE");
  assert.match(described.errorLocation ?? "", /failingHelper/);
  assert.match(described.errorLocation ?? "", /core\.test\.js:\d+/);
  assert.doesNotMatch(JSON.stringify(described), /SECRET_MESSAGE|source text/);
});

test("describeHandlerError skips Node internal frames and tolerates non-Error throws", () => {
  let fsError: unknown;
  try {
    readFileSync(join(tempProject(), "does-not-exist.txt"));
  } catch (error) {
    fsError = error;
  }
  const described = describeHandlerError(fsError);
  assert.equal(described.errorCode, "ENOENT");
  assert.doesNotMatch(described.errorLocation ?? "", /node:/);
  assert.match(described.errorLocation ?? "", /core\.test\.js:\d+/, "the first frame outside Node internals");

  assert.deepEqual(describeHandlerError("boom"), { errorName: "string" });
  assert.deepEqual(describeHandlerError(null), { errorName: "object" });
  assert.deepEqual(describeHandlerError({ code: 42 }), { errorName: "object" });
});

test("HandlerErrorLimiter reports the first occurrence and then every tenth power", () => {
  const limiter = new HandlerErrorLimiter();
  const logged: number[] = [];
  for (let index = 0; index < 1100; index += 1) {
    const result = limiter.record("tool_call|TypeError||index.js:1");
    if (result.log) logged.push(result.occurrences);
  }
  assert.deepEqual(logged, [1, 10, 100, 1000]);
  assert.equal(limiter.record("context|RangeError||index.js:2").log, true, "distinct errors are independent");
});

test("shell redirects that cannot write a source file do not count as mutation risk", () => {
  const harmless = [
    "ls src 2>/dev/null",
    "mvn -q test > /dev/null",
    "mvn -q test >/dev/null 2>&1",
    "npm run build 2>&1",
    "cmd > nul",
    "Get-ChildItem > $null",
    "echo done >&2",
    "git log --oneline | head -5",
    "grep -rn 'a>b' src",
    "npm install",
    "mvn -q clean install -DskipTests",
    "pnpm install --frozen-lockfile",
    "sudo apt-get install -y git",
    "cd frontend && npm install",
    "cd app; mvn -q clean install",
    "yarn install && yarn build",
  ];
  for (const command of harmless) {
    assert.deepEqual(classifyShellMutationRisk(command), [], `no risk expected for: ${command}`);
  }

  const risky = [
    "echo x > out.txt",
    "echo x >> out.txt",
    "printf '%s' data >out.java",
    "ls 2> errors.txt",
    "cat a.txt > src/Main.java",
    "Get-Content a | Set-Content b.txt",
    "install -m 644 a.conf /etc/a.conf",
    "echo x > nul.txt",
    "echo x > /dev/null.log",
    "npm install && rm -rf dist",
    "npm run build && install -m 644 a.conf /etc/a.conf",
  ];
  for (const command of risky) {
    assert.notDeepEqual(classifyShellMutationRisk(command), [], `risk expected for: ${command}`);
  }
  assert.ok(classifyShellMutationRisk("echo x > out.txt").includes("redirect"));
});

test("isRacyClean trusts an mtime only when it is clearly older than the reference time", () => {
  const now = 1_000_000_000;
  assert.equal(isRacyClean(now - RACY_WINDOW_MS - 1, now), false);
  assert.equal(isRacyClean(now - RACY_WINDOW_MS, now), true);
  assert.equal(isRacyClean(now, now), true);
  assert.equal(isRacyClean(now + 60_000, now), true, "an mtime in the future can never be trusted");
});
