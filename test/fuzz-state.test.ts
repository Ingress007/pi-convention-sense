// Seeded fuzz tests for the two inputs a repository or a session file fully controls: the project config
// and the persisted checkpoint. A failure message names the seed, which reproduces the exact input.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadSpikeConfig } from "../src/runtime/config.js";
import { isSupportedGlob } from "../src/runtime/glob.js";
import { isPathInside } from "../src/runtime/paths.js";
import { checkpointState, createSpikeState, restoreStateFromBranch } from "../src/runtime/state.js";
import { SPIKE_STATE_ENTRY_TYPE, type SessionEntryLike } from "../src/runtime/types.js";
import { chance, forEachSeed, int, pick, randomJson, randomString, type Rng } from "./support/fuzz.js";

// ---- configuration fuzz -----------------------------------------------------------------------------------------

const NUMBER_EDGES = [0, 1, 2, 10, 11, 119, 120, 199, 200, 999, 1000, 1001, 1200, 1201, 7999, 8000, 8001, 86_399_999, 86_400_000, 86_400_001, -1, 1.5];
const GLOB_SAMPLES = ["**/a/**", "src/**/*.java", "*a*a*a*a*a*a*b", "", "x".repeat(600), "!**/keep/**", "{a,b}/**"];
const LOG_PATH_SAMPLES = [
  ".pi/convention-sense/custom.ndjson",
  ".pi/convention-sense/sub/dir/custom.ndjson",
  "../escape.log",
  "/absolute/elsewhere.log",
  "C:\\Windows\\escape.log",
  "",
  "   ",
  ".pi/convention-sense/../../escape.log",
  ".pi/convention-sense/../convention-sense/ok.ndjson",
];
const TOOL_MAPPING_SAMPLES: unknown[] = [
  { toolName: "my_read", operation: "read", pathField: "file.path" },
  { toolName: "my_edit", operation: "edit", pathField: "target" },
  { toolName: "read", operation: "read", pathField: "path" },
  { toolName: "dup", operation: "write", pathField: "path" },
  { toolName: "dup", operation: "write", pathField: "path" },
  { toolName: "evil", operation: "edit", pathField: "__proto__.polluted" },
  { toolName: "evil2", operation: "edit", pathField: "a.constructor.b" },
  { toolName: "bad", operation: "delete", pathField: "path" },
  { toolName: "", operation: "read", pathField: "path" },
  "nonsense",
  null,
];
const SECTIONS: Record<string, readonly string[]> = {
  guard: ["pathExceptions", "allowBypass", "requireRecentContext", "contextWindowTurns", "contextMaxAgeMs"],
  postChangeAudit: ["enabled", "notify", "maxChangedFiles"],
  practiceReview: ["mode", "maxContextTokens"],
  logging: ["level", "explainRanking"],
};
const TOP_LEVEL_KEYS = [
  "enabled", "mode", "minEvidenceFiles", "maxEvidenceFiles", "maxContextTokens", "scopeStrategy", "includeLanguages",
  "exclude", "injectContext", "persistSessionState", "logPath", "toolMappings",
];

function plausible(rng: Rng, key: string): unknown {
  switch (key) {
    case "mode":
    case "level":
      return pick(rng, ["observe", "guard", "off", "suggest", "auto-once", "info", "silent", "debug", "loud"]);
    case "scopeStrategy":
      return pick(rng, ["module-role", "other"]);
    case "includeLanguages":
      return Array.from({ length: int(rng, 0, 4) }, () => pick(rng, ["java", "TypeScript", "vue", "cobol", "", "JAVA"]));
    case "exclude":
    case "pathExceptions":
      return Array.from({ length: int(rng, 0, 4) }, () => pick(rng, GLOB_SAMPLES));
    case "logPath":
      return pick(rng, LOG_PATH_SAMPLES);
    case "toolMappings":
      return Array.from({ length: int(rng, 0, 5) }, () => pick(rng, TOOL_MAPPING_SAMPLES));
    default:
      return chance(rng, 0.5) ? pick(rng, NUMBER_EDGES) : chance(rng, 0.5);
  }
}

function randomSection(rng: Rng, keys: readonly string[]): unknown {
  if (chance(rng, 0.15)) return randomJson(rng);
  const section: Record<string, unknown> = {};
  for (const key of keys) {
    if (chance(rng, 0.6)) section[key] = chance(rng, 0.6) ? plausible(rng, key) : randomJson(rng);
  }
  return section;
}

function randomConfigFile(rng: Rng): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (chance(rng, 0.6)) config[key] = chance(rng, 0.6) ? plausible(rng, key) : randomJson(rng);
  }
  for (const [name, keys] of Object.entries(SECTIONS)) {
    if (chance(rng, 0.6)) config[name] = randomSection(rng, keys);
  }
  if (chance(rng, 0.2)) config[pick(rng, ["__proto__", "constructor", "prototype"])] = randomJson(rng);
  return config;
}

function assertConfigInvariants(loaded: ReturnType<typeof loadSpikeConfig>, root: string): void {
  const { config } = loaded;
  assert.ok(["observe", "guard"].includes(config.mode), `mode ${String(config.mode)}`);
  assert.ok(["off", "suggest", "auto-once"].includes(config.practiceReview.mode));
  assert.ok(["silent", "info", "debug"].includes(config.logging.level));
  const within = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  assert.ok(within(config.minEvidenceFiles, 1, 10) && within(config.maxEvidenceFiles, 1, 10), "evidence file counts");
  assert.ok(config.maxEvidenceFiles >= config.minEvidenceFiles, "max >= min");
  assert.ok(within(config.maxContextTokens, 200, 8000), "context tokens");
  assert.ok(within(config.practiceReview.maxContextTokens, 120, 1200), "practice tokens");
  assert.ok(within(config.guard.contextWindowTurns, 0, 100), "context window");
  assert.ok(within(config.guard.contextMaxAgeMs, 1_000, 86_400_000), "context max age");
  assert.ok(within(config.postChangeAudit.maxChangedFiles, 1, 1000), "audit file cap");
  for (const language of config.includeLanguages) {
    assert.ok(["java", "typescript", "vue"].includes(language), `unsupported language kept: ${language}`);
  }
  for (const pattern of [...config.exclude, ...config.guard.pathExceptions]) {
    assert.ok(isSupportedGlob(pattern), `unsupported glob kept: ${pattern.slice(0, 20)}`);
  }
  const seenTools = new Set<string>();
  for (const mapping of config.toolMappings) {
    assert.ok(!["read", "edit", "write", "bash", "powershell"].includes(mapping.toolName), "built-in tool remapped");
    assert.ok(!seenTools.has(mapping.toolName), "duplicate tool mapping");
    seenTools.add(mapping.toolName);
    assert.ok(["read", "edit", "write"].includes(mapping.operation));
    assert.ok(
      mapping.pathField.split(".").every(
        (segment) => /^[A-Za-z_$][\w$]*$/.test(segment) && !["__proto__", "prototype", "constructor"].includes(segment),
      ),
      `unsafe path field ${mapping.pathField}`,
    );
  }
  assert.ok(
    isPathInside(resolve(root, ".pi", "convention-sense"), resolve(root, config.logPath)),
    `log path escaped the state directory: ${config.logPath}`,
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype was polluted");
}

test("config loading survives arbitrary project config files", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-config-fuzz-"));
  try {
    mkdirSync(join(root, ".pi"));
    const file = join(root, ".pi", "convention-sense.json");
    forEachSeed(1_000, 300, (rng) => {
      const text = JSON.stringify(randomConfigFile(rng));
      // Half of the runs also corrupt the text itself: truncation, junk bytes, a BOM, a stray NUL.
      const damaged = chance(rng, 0.5)
        ? pick(rng, [
          () => text.slice(0, int(rng, 0, text.length)),
          () => `\uFEFF${text}`,
          () => text.replace(/[,:]/, pick(rng, ["", ";", "\u0000", "}"])),
          () => `${text}${randomString(rng, 12)}`,
          () => text.repeat(2),
          () => "[".repeat(20_000),
          () => "",
        ])()
        : text;
      writeFileSync(file, damaged);
      assertConfigInvariants(loadSpikeConfig(root, true), root);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unsupported or empty language list is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-language-config-"));
  try {
    mkdirSync(join(root, ".pi"));
    const file = join(root, ".pi", "convention-sense.json");
    writeFileSync(file, JSON.stringify({ includeLanguages: ["java", "Typescript", "cobol"] }));
    const mixed = loadSpikeConfig(root, true);
    assert.deepEqual(mixed.config.includeLanguages, ["java", "typescript"]);
    assert.ok(mixed.diagnostics.some((message) => /unsupported language/i.test(message) && message.includes("cobol")));

    writeFileSync(file, JSON.stringify({ includeLanguages: [] }));
    const empty = loadSpikeConfig(root, true);
    assert.deepEqual(empty.config.includeLanguages, []);
    assert.ok(empty.diagnostics.some((message) => /includeLanguages is empty/i.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- checkpoint fuzz --------------------------------------------------------------------------------------------

function randomPath(rng: Rng): string {
  const name = randomString(rng, 10).replace(/[\\/\u0000]/g, "_");
  return `/repo/${pick(rng, ["a", "b", "order", "user"])}/src/${name}.java`;
}

function validCheckpointData(rng: Rng): Record<string, unknown> {
  const state = createSpikeState();
  const readCount = pick(rng, [0, 3, 50, 300, 450]);
  for (let index = 0; index < readCount; index += 1) {
    const path = `${randomPath(rng)}.${index}`;
    state.successfulReads.add(path);
    state.recentReads.push({ path, completedAt: index });
  }
  for (let index = 0; index < int(rng, 0, 120); index += 1) {
    state.mutations.push({ path: randomPath(rng), toolName: pick(rng, ["edit", "write"] as const), completedAt: index });
  }
  state.shellRiskCount = int(rng, 0, 50);
  state.guardCounters = { allow: int(rng, 0, 9), wouldBlock: int(rng, 0, 9), block: int(rng, 0, 9) };
  state.bypassCount = int(rng, 0, 5);
  return { ...checkpointState(state) };
}

const CHECKPOINT_FIELDS = [
  "version", "successfulReads", "recentReads", "mutations", "shellRiskCount", "guardCounters", "bypassCount",
  "postChangeAuditCount", "postChangeGapCount",
];

function corrupt(rng: Rng, data: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...data };
  const field = pick(rng, CHECKPOINT_FIELDS);
  switch (int(rng, 0, 5)) {
    case 0:
      delete copy[field];
      break;
    case 1:
      copy[field] = randomJson(rng);
      break;
    case 2:
      copy[field] = pick(rng, [-1, -1e9, 1.5, 1e308, Number.NaN, Number.POSITIVE_INFINITY, "7", null]);
      break;
    case 3:
      copy.guardCounters = { allow: pick(rng, [-3, 1.5, "x", Number.NaN]), wouldBlock: 0, block: 0 };
      break;
    case 4:
      copy.successfulReads = Array.from({ length: 5_000 }, (_value, index) => `/repo/huge/${index}.java`);
      break;
    default:
      copy.mutations = [{ path: 5, toolName: "edit", completedAt: 1 }];
  }
  return copy;
}

function assertStateInvariants(state: ReturnType<typeof restoreStateFromBranch>): void {
  const counts = [
    state.shellRiskCount, state.guardCounters.allow, state.guardCounters.wouldBlock, state.guardCounters.block,
    state.bypassCount, state.postChangeAuditCount, state.postChangeGapCount,
  ];
  for (const count of counts) assert.ok(Number.isSafeInteger(count) && count >= 0, `counter ${String(count)}`);
  assert.ok(state.successfulReads.size <= 300, `successfulReads ${state.successfulReads.size}`);
  assert.ok(state.recentReads.length <= 100, `recentReads ${state.recentReads.length}`);
  assert.ok(state.mutations.length <= 100, `mutations ${state.mutations.length}`);
}

function checkpointEntry(data: unknown): SessionEntryLike {
  return { type: "custom", customType: SPIKE_STATE_ENTRY_TYPE, data } as SessionEntryLike;
}

test("checkpoint restore survives corrupt, hostile and oversized session entries", () => {
  forEachSeed(5_000, 400, (rng) => {
    const entries: SessionEntryLike[] = [];
    let intact = false;
    const count = int(rng, 1, 5);
    for (let index = 0; index < count; index += 1) {
      const kind = int(rng, 0, 4);
      if (kind === 0) {
        entries.push({
          type: pick(rng, ["message", "custom", "label"]),
          customType: randomString(rng, 8),
          data: randomJson(rng),
        } as SessionEntryLike);
      } else if (kind === 1) {
        entries.push(checkpointEntry(randomJson(rng)));
      } else if (kind === 2) {
        entries.push(checkpointEntry(corrupt(rng, validCheckpointData(rng))));
      } else {
        entries.push(checkpointEntry(validCheckpointData(rng)));
        intact = true;
        // A corrupt entry after an intact one must not erase it: restore falls back to the newest valid checkpoint.
        if (chance(rng, 0.5)) entries.push(checkpointEntry({ version: 3, successfulReads: "broken" }));
      }
    }
    const state = restoreStateFromBranch(entries);
    assertStateInvariants(state);
    if (intact) assert.equal(state.restoredFromCheckpoint, true, "an intact checkpoint must always restore");
  });
});

test("checkpoints round-trip through restore without drifting", () => {
  forEachSeed(9_000, 100, (rng) => {
    const first = restoreStateFromBranch([checkpointEntry(validCheckpointData(rng))]);
    const second = restoreStateFromBranch([checkpointEntry(checkpointState(first))]);
    assert.deepEqual([...second.successfulReads], [...first.successfulReads]);
    assert.deepEqual(second.recentReads, first.recentReads);
    assert.deepEqual(second.mutations, first.mutations);
    assert.deepEqual(second.guardCounters, first.guardCounters);
  });
});
