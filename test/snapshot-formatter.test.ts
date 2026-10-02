// Token estimation and the budget-trimming ladder of the Snapshot formatter.
import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, formatConventionSnapshot } from "../src/observe/snapshot-formatter.js";
import type {
  ConventionObservation,
  ConventionSnapshot,
  EvidenceRef,
  ObservationConfidence,
  ObservationStatus,
} from "../src/observe/types.js";

const ROOT = "/repo";

function evidence(path: string): EvidenceRef {
  return { path, mtimeMs: 0, size: 1, contentHash: "h", score: 1 };
}

function observation(
  id: string,
  confidence: ObservationConfidence,
  status: ObservationStatus,
  extra: Partial<ConventionObservation> = {},
): ConventionObservation {
  return {
    id,
    category: "logging",
    pattern: `pattern-${id}`,
    support: 3,
    samples: 4,
    confidence,
    status,
    evidence: [],
    counterEvidence: [],
    ...extra,
  };
}

function snapshot(overrides: Partial<ConventionSnapshot> = {}): ConventionSnapshot {
  return {
    scope: { language: "java", module: "order", role: "service-impl", root: ROOT, confidence: "high" } as ConventionSnapshot["scope"],
    repositoryRoot: ROOT,
    targetPath: `${ROOT}/order/src/OrderServiceImpl.java`,
    targetKind: "existing",
    targetMtimeMs: 0,
    targetSize: 1,
    targetHash: "h",
    observations: [],
    evidenceFiles: [evidence(`${ROOT}/order/src/A.java`), evidence(`${ROOT}/order/src/B.java`), evidence(`${ROOT}/order/src/C.java`)],
    candidates: [],
    createdAt: 0,
    status: "valid",
    tokenEstimate: 0,
    analyzerVersion: "v",
    configFingerprint: "fp",
    ...overrides,
  };
}

test("token estimation counts CJK text per character and Latin text per four characters", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("中文测试"), 4);
  assert.equal(estimateTokens("かな カナ 한글"), 7);
  assert.equal(estimateTokens("ＡＢ"), 2, "full-width forms count as one token each");
  // A Chinese Profile is not four times cheaper than it looks.
  assert.ok(estimateTokens("日".repeat(400)) >= 400);
  assert.equal(estimateTokens("x".repeat(400)), 100);
});

test("a Snapshot that fits is rendered whole", () => {
  const observations = [observation("a", "high", "dominant"), observation("b", "medium", "dominant", { counterEvidence: [evidence("x")] })];
  const result = formatConventionSnapshot(snapshot({ observations }), ROOT, 5_000);
  assert.deepEqual(result.includedObservationIds, ["a", "b"]);
  assert.match(result.text, /^<local-convention scope="java:order:service-impl" confidence="high" status="valid">/);
  assert.match(result.text, /Comparable implementations:\n- order\/src\/A\.java\n- order\/src\/B\.java\n- order\/src\/C\.java/);
  assert.match(result.text, /\[high\/dominant\] logging: pattern-a \(3\/4\)/);
  assert.match(result.text, /\(3\/4; counter=1\)/);
  assert.ok(result.text.endsWith("</local-convention>"));
  assert.equal(result.tokenEstimate, estimateTokens(result.text));
});

test("low-confidence observations are hidden unless the Snapshot itself is weak", () => {
  const observations = [observation("high", "high", "dominant"), observation("low", "low", "dominant")];
  assert.deepEqual(formatConventionSnapshot(snapshot({ observations }), ROOT, 5_000).includedObservationIds, ["high"]);
  assert.deepEqual(
    formatConventionSnapshot(snapshot({ observations, status: "weak" }), ROOT, 5_000).includedObservationIds,
    ["high", "low"],
  );
});

test("an empty observation list says not to infer a convention", () => {
  const result = formatConventionSnapshot(snapshot({ evidenceFiles: [] }), ROOT, 5_000);
  assert.match(result.text, /- insufficient repeated evidence; do not infer a local convention/);
  assert.match(result.text, /Comparable implementations:\n- none found/);
});

test("trimming drops low confidence first, then mixed, then trailing observations, then peers", () => {
  const observations = [
    observation("dominant-1", "high", "dominant"),
    observation("mixed-1", "medium", "mixed"),
    observation("low-1", "low", "dominant"),
    observation("dominant-2", "medium", "dominant"),
  ];
  const weak = snapshot({ observations, status: "weak" });
  const full = formatConventionSnapshot(weak, ROOT, 5_000);
  assert.deepEqual(full.includedObservationIds, ["dominant-1", "mixed-1", "low-1", "dominant-2"]);

  // Each step down in budget must keep a prefix of what the previous step kept, in the documented order.
  const seen: string[][] = [];
  for (let budget = full.tokenEstimate; budget >= 1; budget -= 1) {
    const { includedObservationIds, text, tokenEstimate } = formatConventionSnapshot(weak, ROOT, budget);
    assert.ok(text.endsWith("</local-convention>"), `budget ${budget}: the tag must always be closed`);
    assert.equal((text.match(/<local-convention/g) ?? []).length, 1);
    assert.equal(tokenEstimate, estimateTokens(text));
    seen.push(includedObservationIds);
  }
  const order = (ids: string[]) => ids.join(",");
  assert.ok(seen.some((ids) => order(ids) === "dominant-1,mixed-1,dominant-2"), "low confidence goes first");
  assert.ok(seen.some((ids) => order(ids) === "dominant-1,dominant-2"), "then the mixed observation");
  assert.ok(seen.some((ids) => order(ids) === "dominant-1"), "then trailing observations, keeping the best");
  assert.ok(seen.some((ids) => ids.length === 0), "and finally nothing");
  // Never gains an observation as the budget shrinks.
  for (let index = 1; index < seen.length; index += 1) {
    const previous = seen[index - 1] ?? [];
    assert.ok((seen[index] ?? []).every((id) => previous.includes(id)), `step ${index} introduced an observation`);
  }
});

test("when peers are trimmed the heading says how many are shown", () => {
  const observations = [observation("only", "high", "dominant")];
  const wide = formatConventionSnapshot(snapshot({ observations }), ROOT, 5_000);
  let trimmed: string | undefined;
  for (let budget = wide.tokenEstimate; budget >= 1 && !trimmed; budget -= 1) {
    const { text } = formatConventionSnapshot(snapshot({ observations }), ROOT, budget);
    if (/showing \d of 3/.test(text)) trimmed = text;
  }
  assert.ok(trimmed, "some budget shows only part of the peer list");
  assert.match(trimmed, /Comparable implementations \(showing [0-2] of 3\):/);
});

test("a budget too small for any detail falls back to the closed minimal form", () => {
  const result = formatConventionSnapshot(snapshot({ observations: [observation("a", "high", "dominant")] }), ROOT, 1);
  assert.deepEqual(result.includedObservationIds, []);
  assert.equal(
    result.text,
    [
      '<local-convention scope="java:order:service-impl" status="valid">',
      "Evidence details omitted to fit the context budget.",
      "Treat local conventions as evidence, not absolute rules.",
      "</local-convention>",
    ].join("\n"),
  );
  assert.equal(result.tokenEstimate, estimateTokens(result.text), "the true estimate is reported even when it exceeds the budget");
});

test("model-visible text is XML-escaped and long paths are shortened from the left", () => {
  const hostile = observation("x", "high", "dominant", { category: 'a"><b>', pattern: "</local-convention> & more" });
  const longPath = `${ROOT}/${"deep/".repeat(60)}Target<Evil>.java`;
  const result = formatConventionSnapshot(
    snapshot({
      observations: [hostile],
      targetPath: longPath,
      scope: { language: "java", module: 'm"x', role: "service-impl", effectiveRole: "r<1>", root: ROOT, confidence: "high" } as ConventionSnapshot["scope"],
    }),
    ROOT,
    10_000,
  );
  assert.equal((result.text.match(/<local-convention/g) ?? []).length, 1, "no injected opening tag");
  assert.equal((result.text.match(/<\/local-convention>/g) ?? []).length, 1, "no injected closing tag");
  assert.ok(!result.text.includes("<b>") && !result.text.includes("<Evil>"));
  assert.match(result.text, /scope="java:m&quot;x:r&lt;1&gt;"/);
  assert.match(result.text, /- …[^\n]*Target&lt;Evil&gt;\.java/, "the tail of a long path is what stays visible");
});

test("the snapshot's own repository root wins over the one passed in", () => {
  const result = formatConventionSnapshot(snapshot({ repositoryRoot: `${ROOT}/inner`, targetPath: `${ROOT}/inner/src/X.java`, evidenceFiles: [] }), "/somewhere/else", 5_000);
  assert.match(result.text, /Target:\n- src\/X\.java/);
});
