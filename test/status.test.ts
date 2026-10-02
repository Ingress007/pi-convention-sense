// The /convention-status text and the web-project hint.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createDefaultConfig } from "../src/runtime/config.js";
import { createSpikeState } from "../src/runtime/state.js";
import { buildStatus, formatStatus, looksLikeWebProject } from "../src/runtime/status.js";

const root = mkdtempSync(join(tmpdir(), "pi-convention-status-unit-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function project(files: Record<string, string>): string {
  const directory = join(root, `p${(counter += 1)}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  return directory;
}


test("a web project has TypeScript or Vue evidence, not just a package.json", () => {
  assert.equal(looksLikeWebProject(project({})), false, "no manifest");
  assert.equal(looksLikeWebProject(project({ "package.json": "{}" })), false, "an empty manifest");
  assert.equal(looksLikeWebProject(project({ "package.json": "{}", "tsconfig.json": "{}" })), true, "tsconfig.json is enough");
  for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of ["vue", "typescript", "@vue/runtime-core"]) {
      assert.equal(looksLikeWebProject(project({ "package.json": JSON.stringify({ [group]: { [name]: "1.0.0" } }) })), true, `${group}.${name}`);
    }
  }
  assert.equal(
    looksLikeWebProject(project({ "package.json": JSON.stringify({ devDependencies: { husky: "9", "@commitlint/cli": "19" }, dependencies: { "vue-router-like": "1" } }) })),
    false,
    "tooling and look-alike names do not count",
  );
});

test("a broken or unusual manifest is not a web project and never throws", () => {
  for (const text of ["{ not json", "", "null", "42", '"vue"', "[]", '{"dependencies":null}', '{"dependencies":"vue"}', '{"dependencies":["vue"]}']) {
    assert.equal(looksLikeWebProject(project({ "package.json": text })), false, JSON.stringify(text));
  }
  assert.equal(looksLikeWebProject(join(root, "does-not-exist")), false);
});

test("the status reflects state, counters and optional details", () => {
  const config = createDefaultConfig();
  const state = createSpikeState();
  state.successfulReads.add("/repo/A.java");
  state.mutations.push({ path: "/repo/A.java", toolName: "edit", completedAt: 1 });
  state.pendingReads.set("call-1", { path: "/repo/B.java", startedAt: 1 });
  state.shellRiskCount = 2;
  state.guardCounters = { allow: 5, wouldBlock: 3, block: 1 };
  state.contextInjectionCount = 7;
  state.bypassCount = 1;
  state.postChangeAuditCount = 4;
  state.postChangeGapCount = 2;
  state.restoredFromCheckpoint = true;

  const bare = buildStatus({ config, state, logPath: "/log.ndjson", configDiagnostics: [] });
  assert.equal(bare.snapshotCount, 0, "snapshot counters default to zero");
  assert.equal("sessionId" in bare || "sessionFile" in bare || "loggerError" in bare, false, "optional fields are absent, not undefined");
  const text = formatStatus(bare);
  assert.match(text, /^pi-convention-sense V1 Guard \(observe\)/);
  assert.match(text, /reads=1, pending=1, mutations=1/);
  assert.match(text, /guard allow\/wouldBlock\/block=5\/3\/1/);
  assert.match(text, /shell-risk=2, context-injections=7, bypass=1/);
  assert.match(text, /post-change audits\/gaps=4\/2/);
  assert.match(text, /snapshots total\/valid\/weak\/stale=0\/0\/0\/0/);
  assert.match(text, /state=restored/);
  assert.match(text, /log=\/log\.ndjson$/);
  assert.ok(!text.includes("logger-error=") && !text.includes("config="));

  const full = buildStatus({
    config: { ...config, enabled: false, mode: "guard" },
    state: createSpikeState(),
    logPath: "/l",
    configDiagnostics: ["first", "second"],
    snapshotCount: 4,
    validSnapshotCount: 2,
    weakSnapshotCount: 1,
    staleSnapshotCount: 1,
    sessionId: "s-1",
    sessionFile: "/s.jsonl",
    loggerError: "disk full",
  });
  assert.equal(full.sessionId, "s-1");
  assert.equal(full.sessionFile, "/s.jsonl");
  const fullText = formatStatus(full);
  assert.match(fullText, /\(guard, disabled\)/);
  assert.match(fullText, /snapshots total\/valid\/weak\/stale=4\/2\/1\/1/);
  assert.match(fullText, /state=fresh/);
  assert.match(fullText, /logger-error=disk full/);
  assert.match(fullText, /config=first; second/);
});

test("the status is a copy: later changes to the live state do not alter an earlier report", () => {
  const state = createSpikeState();
  const status = buildStatus({ config: createDefaultConfig(), state, logPath: "/l", configDiagnostics: ["a"] });
  state.guardCounters.block = 99;
  assert.equal(status.guardCounters.block, 0);
});
