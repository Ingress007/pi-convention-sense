// Selection, ordering and budgeting of the Engineering Practice capsule and the one-shot review message.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { estimateTokens } from "../src/observe/snapshot-formatter.js";
import { formatOneShotPracticeReview, formatPracticeCapsule } from "../src/practice/capsule-formatter.js";
import type { PracticeAnalysisResult, PracticeCategory, PracticeConfidence, PracticeSignal } from "../src/practice/types.js";

const ROOT = resolve("/repo");

function signal(
  category: PracticeCategory,
  target: string,
  confidence: PracticeConfidence = "medium",
  extra: Partial<PracticeSignal> = {},
): PracticeSignal {
  return {
    id: `practice.${category}`,
    category,
    targetPath: join(ROOT, target),
    repositoryRoot: ROOT,
    language: "java",
    confidence,
    facts: [{ name: "markers", count: 2 }],
    reviewQuestion: `Question about ${category}?`,
    source: "deterministic-source-structure",
    analyzerVersion: "test",
    ...extra,
  };
}

function analysis(...signals: PracticeSignal[]): PracticeAnalysisResult {
  return { targetPath: signals[0]?.targetPath ?? join(ROOT, "x"), basis: "snapshot", signals, durationMs: 0 };
}

const ALL_CATEGORIES: PracticeCategory[] = [
  "transaction-side-effect", "responsibility-boundary", "state-persistence", "failure-path", "compatibility-intent", "variation-axis",
];

test("nothing to say yields no capsule", () => {
  assert.equal(formatPracticeCapsule([], 1_000), undefined);
  assert.equal(formatPracticeCapsule([analysis()], 1_000), undefined);
  assert.equal(formatPracticeCapsule([analysis(signal("failure-path", "A.java", "low"))], 1_000), undefined, "low-confidence signals are never shown");
  assert.equal(formatPracticeCapsule([analysis(signal("failure-path", "A.java"))], 0), undefined);
  assert.equal(formatPracticeCapsule([analysis(signal("failure-path", "A.java"))], -5), undefined);
  assert.equal(formatPracticeCapsule([analysis(signal("failure-path", "A.java"))], 20), undefined, "the fixed frame alone does not fit");
});

test("signals are ordered by confidence, then target path, then id, and de-duplicated", () => {
  const capsule = formatPracticeCapsule(
    [
      analysis(
        signal("state-persistence", "b/Zed.java", "medium"),
        signal("failure-path", "b/Zed.java", "medium"),
        signal("failure-path", "a/Alpha.java", "medium"),
        signal("transaction-side-effect", "z/Last.java", "high"),
      ),
      analysis(signal("failure-path", "a/Alpha.java", "medium")),
    ],
    5_000,
  );
  assert.ok(capsule);
  assert.deepEqual(capsule.includedSignalIds, [
    "practice.transaction-side-effect",
    "practice.failure-path",
    "practice.failure-path",
    "practice.state-persistence",
  ]);
  const order = [...capsule.text.matchAll(/^- \[(\w+)\/([\w-]+)\] (\S+)/gm)].map((match) => `${match[1]}:${match[3]}`);
  assert.deepEqual(order, ["high:z/Last.java", "medium:a/Alpha.java", "medium:b/Zed.java", "medium:b/Zed.java"]);
  assert.match(capsule.text, /^<engineering-practice status="advisory">/);
  assert.ok(capsule.text.endsWith("</engineering-practice>"));
  assert.equal(capsule.tokenEstimate, estimateTokens(capsule.text));
});

test("the same signal for a different repository root is a different signal", () => {
  const other = resolve("/other");
  const capsule = formatPracticeCapsule(
    [analysis(signal("failure-path", "A.java"), signal("failure-path", "A.java", "medium", { repositoryRoot: other, targetPath: join(other, "A.java") }))],
    5_000,
  );
  assert.equal(capsule?.includedSignalIds.length, 2);
});

test("at most six signals are listed and the omission is announced when it fits", () => {
  const signals = ALL_CATEGORIES.flatMap((category) => ["One.java", "Two.java"].map((file) => signal(category, file)));
  const capsule = formatPracticeCapsule([analysis(...signals)], 10_000);
  assert.ok(capsule);
  assert.equal(capsule.includedSignalIds.length, 6);
  assert.match(capsule.text, /- Additional low-priority practice signals omitted by token budget\./);
});

test("a small budget keeps what fits, skips what does not, and drops the omission note if it would not fit", () => {
  const long = signal("failure-path", "A.java", "high", { reviewQuestion: "x ".repeat(400) });
  const short = signal("state-persistence", "B.java", "medium");
  const generous = formatPracticeCapsule([analysis(long, short)], 5_000);
  assert.deepEqual(generous?.includedSignalIds, ["practice.failure-path", "practice.state-persistence"]);

  const shortOnly = formatPracticeCapsule([analysis(short)], 5_000);
  assert.ok(shortOnly);
  // A budget that fits the short signal but not the long one: the long one is skipped, the short one survives.
  const budget = shortOnly.tokenEstimate + 12;
  const tight = formatPracticeCapsule([analysis(long, short)], budget);
  assert.ok(tight);
  assert.deepEqual(tight.includedSignalIds, ["practice.state-persistence"]);
  assert.ok(tight.tokenEstimate <= budget);
  assert.ok(!tight.text.includes("omitted by token budget"), "no room for the note, so none is added");

  // With room for the note it is added.
  const roomy = formatPracticeCapsule([analysis(long, short)], shortOnly.tokenEstimate + 40);
  assert.match(roomy?.text ?? "", /omitted by token budget/);
  assert.equal(formatPracticeCapsule([analysis(long)], shortOnly.tokenEstimate), undefined, "nothing fits, so nothing is emitted");
});

test("targets are shown relative to their repository, and escaped", () => {
  const nested = signal("failure-path", join("src", "main", "A<&>.java"), "medium", { facts: [{ name: 'a"b', count: 1 }], reviewQuestion: "Is <this> ok & safe?" });
  const outside = signal("state-persistence", "B.java", "medium", { targetPath: resolve("/elsewhere/Out.java") });
  const root = signal("compatibility-intent", ".", "medium", { targetPath: ROOT });
  const text = formatPracticeCapsule([analysis(nested, outside, root)], 5_000)?.text ?? "";
  assert.match(text, /src\/main\/A&lt;&amp;&gt;\.java/);
  assert.match(text, /\(a&quot;b=1\)/);
  assert.match(text, /Question: Is &lt;this&gt; ok &amp; safe\?/);
  assert.match(text, /\[medium\/state-persistence\] [^\n]*elsewhere\/Out\.java/, "outside the repository: the full path, with forward slashes");
  assert.match(text, /\[medium\/compatibility-intent\] \. /, "the repository root itself is shown as a dot");
  assert.ok(!text.includes("<this>") && !text.includes("A<&>"));
});

test("the one-shot review wraps the capsule in its instruction and respects the whole budget", () => {
  const input = [analysis(signal("failure-path", "A.java", "high"))];
  const capsule = formatPracticeCapsule(input, 5_000);
  const review = formatOneShotPracticeReview(input, 5_000);
  assert.ok(capsule && review);
  assert.match(review.text, /^<engineering-practice-review status="one-shot">/);
  assert.ok(review.text.includes(capsule.text));
  assert.deepEqual(review.includedSignalIds, capsule.includedSignalIds);
  assert.equal(review.tokenEstimate, estimateTokens(review.text));

  assert.equal(formatOneShotPracticeReview([], 5_000), undefined);
  assert.equal(formatOneShotPracticeReview(input, review.tokenEstimate - 1), undefined, "one token too few for the instruction plus capsule");
  // The instruction and the capsule are budgeted separately, so rounding may cost one token at the very edge.
  assert.ok(formatOneShotPracticeReview(input, review.tokenEstimate + 1));
  assert.equal(formatOneShotPracticeReview(input, 30), undefined, "the instruction alone exceeds the budget");
});
