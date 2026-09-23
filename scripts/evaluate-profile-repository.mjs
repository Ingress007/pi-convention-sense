#!/usr/bin/env node

import { relative, resolve } from "node:path";
import { ObserveAnalyzer } from "../dist/src/observe/analyzer.js";
import { BUILTIN_CONVENTION_PACKS } from "../dist/src/profile/builtin-packs.js";
import { loadProjectProfile } from "../dist/src/profile/profile-loader.js";
import { loadSpikeConfig } from "../dist/src/runtime/config.js";

function usage() {
  console.error("Usage: node scripts/evaluate-profile-repository.mjs --root <repo> --sample <path> [--sample <path> ...]");
}

const args = process.argv.slice(2);
let root;
const samples = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--root") root = args[++index];
  else if (arg === "--sample") samples.push(args[++index]);
  else {
    usage();
    process.exit(2);
  }
}
if (!root || samples.length === 0 || samples.some((sample) => !sample)) {
  usage();
  process.exit(2);
}

const repositoryRoot = resolve(root);
const config = loadSpikeConfig(repositoryRoot, true).config;
const loadedProfile = loadProjectProfile(repositoryRoot, true);
const analyzer = new ObserveAnalyzer();
const results = [];
let failed = false;

for (const sample of samples) {
  const targetPath = resolve(repositoryRoot, sample);
  const result = analyzer.analyzeTarget(
    targetPath,
    repositoryRoot,
    config,
    loadedProfile.status === "loaded"
      ? { loadedProfile, availablePacks: BUILTIN_CONVENTION_PACKS }
      : {},
  );
  if (!result.snapshot && !["target-excluded", "scope-unknown"].includes(result.reason ?? "")) failed = true;
  results.push({
    target: relative(repositoryRoot, targetPath).replaceAll("\\", "/"),
    reason: result.reason,
    durationMs: result.durationMs,
    indexedFileCount: result.indexedFileCount,
    consideredCandidateCount: result.consideredCandidateCount,
    ...(result.snapshot
      ? {
          analyzerVersion: result.snapshot.analyzerVersion,
          scope: {
            language: result.snapshot.scope.language,
            module: result.snapshot.scope.module,
            baseRole: result.snapshot.scope.role,
            effectiveRole: result.snapshot.scope.effectiveRole,
            confidence: result.snapshot.scope.confidence,
          },
          status: result.snapshot.status,
          tokenEstimate: result.snapshot.tokenEstimate,
          candidateCount: result.snapshot.candidates.length,
          candidates: result.snapshot.candidates.map((candidate) => ({
            path: relative(repositoryRoot, candidate.path).replaceAll("\\", "/"),
            module: candidate.scope.module,
            role: candidate.scope.effectiveRole ?? candidate.scope.role,
            score: candidate.score,
          })),
          observations: result.snapshot.observations.map((observation) => ({
            category: observation.category,
            pattern: observation.pattern,
            support: observation.support,
            samples: observation.samples,
            confidence: observation.confidence,
            status: observation.status,
          })),
          projectContext: result.snapshot.projectContext
            ? {
                fingerprint: result.snapshot.projectContext.profileFingerprint,
                reviewStatus: result.snapshot.projectContext.reviewStatus,
                activePackIds: result.snapshot.projectContext.activePackIds,
                matchedModuleIds: result.snapshot.projectContext.matchedModuleIds,
                effectiveRole: result.snapshot.projectContext.effectiveRole,
                knowledgeIds: result.snapshot.projectContext.knowledge.map((item) => item.item.id),
                conventionIds: result.snapshot.projectContext.conventions.map((item) => item.item.id),
              }
            : undefined,
        }
      : {}),
  });
}

console.log(JSON.stringify({
  repositoryRoot,
  profile: {
    status: loadedProfile.status,
    fingerprint: loadedProfile.fingerprint,
    diagnostics: loadedProfile.diagnostics,
  },
  includeLanguages: config.includeLanguages,
  results,
}, null, 2));

if (failed) process.exitCode = 1;
