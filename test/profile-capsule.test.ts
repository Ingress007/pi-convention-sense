// The bounded Knowledge Capsule built from a resolved Profile context.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { estimateTokens } from "../src/observe/snapshot-formatter.js";
import { formatKnowledgeCapsule } from "../src/profile/capsule-formatter.js";
import type { ProfileRuleStrength, ResolvedProjectContext } from "../src/profile/types.js";

const ROOT = resolve("/repo");

function knowledge(id: string, summary = `summary of ${id}`, strength: ProfileRuleStrength = "advisory"): ResolvedProjectContext["knowledge"][number] {
  return {
    item: { id, category: "architecture", title: `Title ${id}`, summary, strength, source: "human" },
    sourceKind: "project-profile",
    sourceId: id,
    strength,
  };
}

function convention(id: string, statement = `statement of ${id}`, strength: ProfileRuleStrength = "advisory"): ResolvedProjectContext["conventions"][number] {
  return {
    item: { id, category: "style", statement, strength, source: "human" },
    sourceKind: "project-profile",
    sourceId: id,
    strength,
  };
}

function context(overrides: Partial<ResolvedProjectContext> = {}): ResolvedProjectContext {
  return {
    profilePath: join(ROOT, ".convention-sense", "profile.json"),
    profileFingerprint: "fp",
    reviewStatus: "reviewed",
    matchedModuleIds: [],
    activePackIds: [],
    architecture: [],
    tags: [],
    technologies: [],
    knowledge: [],
    conventions: [],
    diagnostics: [],
    ...overrides,
  };
}

test("an empty context still produces a closed, labelled capsule", () => {
  const result = formatKnowledgeCapsule(context(), ROOT);
  assert.match(result.text, /^<project-knowledge profile="\.convention-sense\/profile\.json" review="reviewed">\nMatched modules: repository\n/);
  assert.ok(result.text.endsWith("</project-knowledge>"));
  assert.deepEqual([result.includedKnowledgeIds, result.includedConventionIds, result.truncated], [[], [], false]);
  assert.equal(result.tokenEstimate, estimateTokens(result.text));
  assert.ok(!result.text.includes("Knowledge:") && !result.text.includes("Project conventions:"));
});

test("modules, role, architecture, technology and draft status are all shown", () => {
  const result = formatKnowledgeCapsule(
    context({
      reviewStatus: "draft",
      matchedModuleIds: ["order", "billing"],
      effectiveRole: "service-impl",
      architecture: ["layered", "ddd"],
      technologies: [
        { id: "spring-boot", kind: "framework", version: "3.2", confidence: "high", evidence: [] },
        { id: "mysql", kind: "database", confidence: "medium", evidence: [] },
      ],
      knowledge: [knowledge("k1")],
      conventions: [convention("c1")],
    }),
    ROOT,
  );
  assert.match(result.text, /review="draft"/);
  assert.match(result.text, /Matched modules: order, billing/);
  assert.match(result.text, /Effective role: service-impl/);
  assert.match(result.text, /Architecture: layered, ddd/);
  assert.match(result.text, /Technology: spring-boot@3\.2, mysql\n/);
  assert.match(result.text, /Draft profile: treat all items as advisory until user review\./);
  assert.match(result.text, /Knowledge:\n- \[advisory\/project-profile\] Title k1: summary of k1/);
  assert.match(result.text, /Project conventions:\n- \[advisory\/project-profile\] style: statement of c1/);
  assert.deepEqual(result.includedKnowledgeIds, ["k1"]);
  assert.deepEqual(result.includedConventionIds, ["c1"]);
  assert.equal(result.truncated, false);
});

test("the Profile path is shown relative to the repository, or in full when it lies outside", () => {
  assert.match(formatKnowledgeCapsule(context({ profilePath: resolve("/elsewhere/profile.json") }), ROOT).text, /profile="[^"]*elsewhere\/profile\.json"/);
  assert.match(formatKnowledgeCapsule(context({ profilePath: ROOT }), ROOT).text, /profile="\."/);
});

test("model-visible fields are XML-escaped", () => {
  const result = formatKnowledgeCapsule(
    context({
      matchedModuleIds: ['m"<x>'],
      effectiveRole: "r&r",
      architecture: ["<arch>"],
      technologies: [{ id: "<t>", kind: "framework", version: "1&2", confidence: "high", evidence: [] }],
      knowledge: [knowledge("k", "</project-knowledge> & done")],
      conventions: [convention("c", 'say "hi" <b>')],
    }),
    ROOT,
  );
  assert.equal((result.text.match(/<project-knowledge/g) ?? []).length, 1);
  assert.equal((result.text.match(/<\/project-knowledge>/g) ?? []).length, 1);
  assert.ok(!result.text.includes("<x>") && !result.text.includes("<arch>") && !result.text.includes("<b>"));
  assert.match(result.text, /m&quot;&lt;x&gt;/);
  assert.match(result.text, /Effective role: r&amp;r/);
  assert.match(result.text, /&lt;t&gt;@1&amp;2/);
});

test("the budget skips items that do not fit, keeps smaller later ones, and notes the omission when there is room", () => {
  const huge = "word ".repeat(300);
  const base = context({
    knowledge: [knowledge("big", huge), knowledge("small-1"), knowledge("small-2")],
    conventions: [convention("c-big", huge), convention("c-small")],
  });
  const generous = formatKnowledgeCapsule(base, ROOT, 5_000);
  assert.deepEqual(generous.includedKnowledgeIds, ["big", "small-1", "small-2"]);
  assert.equal(generous.truncated, false);

  const tight = formatKnowledgeCapsule(base, ROOT, 150);
  assert.deepEqual(tight.includedKnowledgeIds, ["small-1", "small-2"]);
  assert.deepEqual(tight.includedConventionIds, ["c-small"]);
  assert.equal(tight.truncated, true);
  assert.ok(tight.tokenEstimate <= 150);
  assert.match(tight.text, /- Additional matched profile items omitted by token budget\./);
});

test("the budget has a floor of 80 tokens and an omission note is dropped when it would not fit", () => {
  const items = context({ knowledge: [knowledge("a", "x ".repeat(120)), knowledge("b", "y ".repeat(120))] });
  const floored = formatKnowledgeCapsule(items, ROOT, 1);
  const explicit = formatKnowledgeCapsule(items, ROOT, 80);
  assert.equal(floored.text, explicit.text, "any budget below 80 behaves as 80");
  assert.ok(floored.truncated);
  assert.deepEqual(floored.includedKnowledgeIds, []);
  assert.ok(!floored.text.includes("Knowledge:"), "no heading without an item");
  assert.ok(floored.text.endsWith("</project-knowledge>"));
});

test("an item is never half included: heading and line fit together or not at all", () => {
  const items = context({ knowledge: [knowledge("only", "z ".repeat(200))] });
  for (let budget = 80; budget <= 400; budget += 20) {
    const result = formatKnowledgeCapsule(items, ROOT, budget);
    const hasHeading = result.text.includes("Knowledge:");
    assert.equal(hasHeading, result.includedKnowledgeIds.length > 0, `budget ${budget}`);
    if (result.includedKnowledgeIds.length > 0) assert.ok(result.tokenEstimate <= Math.max(80, budget));
  }
});
