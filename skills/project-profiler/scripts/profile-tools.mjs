#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const SELECTOR_KEYS = new Set([
  "paths",
  "excludePaths",
  "languages",
  "modules",
  "baseRoles",
  "fileNames",
  "annotationsAny",
  "dependenciesAny",
]);
const REQUIRED_ARRAYS = [
  "technologies",
  "packs",
  "modules",
  "scopeOverrides",
  "knowledge",
  "conventions",
];

function usage() {
  console.error([
    "Usage:",
    "  profile-tools.mjs validate <profile-file> [repository-root]",
    "  profile-tools.mjs fingerprint <profile-file>",
    "  profile-tools.mjs diff <current-profile> <candidate-profile>",
  ].join("\n"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(",")}}`;
}

function fingerprint(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex").slice(0, 16);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item));
}

function safeRepositoryPath(value) {
  if (!nonEmptyString(value) || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.split("/").includes("..");
}

function isWithinRoot(repositoryRoot, filePath) {
  const relativePath = relative(repositoryRoot, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function validateSelector(selector, location, diagnostics) {
  if (!isRecord(selector)) {
    diagnostics.push(`${location} must be an object`);
    return;
  }
  for (const key of Object.keys(selector)) {
    if (!SELECTOR_KEYS.has(key)) diagnostics.push(`${location}.${key} is not an allowed selector field`);
  }
  for (const key of SELECTOR_KEYS) {
    if (selector[key] !== undefined && !stringArray(selector[key])) {
      diagnostics.push(`${location}.${key} must be a non-empty string array`);
    }
  }
  for (const key of ["paths", "excludePaths"]) {
    if (Array.isArray(selector[key])) {
      selector[key].forEach((pattern, index) => {
        if (!safeRepositoryPath(pattern)) diagnostics.push(`${location}.${key}[${index}] escapes the repository`);
      });
    }
  }
}

function validateEvidence(evidence, location, diagnostics) {
  if (!Array.isArray(evidence)) {
    diagnostics.push(`${location} must be an array`);
    return;
  }
  evidence.forEach((item, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!isRecord(item)) {
      diagnostics.push(`${itemLocation} must be an object`);
      return;
    }
    if (!["manifest", "config", "source", "documentation", "user-review"].includes(item.kind)) {
      diagnostics.push(`${itemLocation}.kind is invalid`);
    }
    if (!nonEmptyString(item.detail)) diagnostics.push(`${itemLocation}.detail must be a non-empty string`);
    if (item.path !== undefined && !safeRepositoryPath(item.path)) {
      diagnostics.push(`${itemLocation}.path must be repository-relative`);
    }
    if (item.line !== undefined && (!Number.isInteger(item.line) || item.line < 1)) {
      diagnostics.push(`${itemLocation}.line must be a positive integer`);
    }
  });
}

function validateIds(items, location, diagnostics) {
  const seen = new Set();
  items.forEach((item, index) => {
    const itemLocation = `${location}[${index}]`;
    if (!isRecord(item) || !nonEmptyString(item.id)) {
      diagnostics.push(`${itemLocation}.id must be a non-empty string`);
      return;
    }
    if (seen.has(item.id)) diagnostics.push(`${location} contains duplicate id ${item.id}`);
    seen.add(item.id);
  });
}

function validateProfile(profile) {
  const diagnostics = [];
  const warnings = [];
  if (!isRecord(profile)) return { diagnostics: ["Profile root must be an object"], warnings };

  if (profile.schemaVersion !== 1) diagnostics.push(`Unsupported schemaVersion: ${String(profile.schemaVersion)}`);
  if (!nonEmptyString(profile.profileVersion)) diagnostics.push("profileVersion must be a non-empty string");
  if (!isRecord(profile.project) || !nonEmptyString(profile.project.name) || profile.project.repositoryRoot !== ".") {
    diagnostics.push('project must contain a name and repositoryRoot must be "."');
  }
  if (!nonEmptyString(profile.generatedAt) || Number.isNaN(Date.parse(profile.generatedAt))) {
    diagnostics.push("generatedAt must be an ISO-compatible timestamp");
  }
  if (!["agent", "human", "imported"].includes(profile.generatedBy)) diagnostics.push("generatedBy is invalid");
  if (!isRecord(profile.review) || !["draft", "reviewed"].includes(profile.review.status)) {
    diagnostics.push("review.status must be draft or reviewed");
  } else if (profile.review.status === "reviewed" &&
    (!nonEmptyString(profile.review.reviewedAt) || !nonEmptyString(profile.review.reviewedBy))) {
    warnings.push("reviewed Profile should include reviewedAt and reviewedBy");
  }

  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(profile[key])) diagnostics.push(`${key} must be an array`);
  }
  if (diagnostics.some((message) => /must be an array$/.test(message))) return { diagnostics, warnings };

  for (const key of ["technologies", "modules", "scopeOverrides", "knowledge", "conventions"]) {
    validateIds(profile[key], key, diagnostics);
  }

  profile.technologies.forEach((item, index) => {
    const location = `technologies[${index}]`;
    if (!isRecord(item)) return;
    if (!nonEmptyString(item.kind)) diagnostics.push(`${location}.kind is required`);
    if (!["high", "medium", "low"].includes(item.confidence)) diagnostics.push(`${location}.confidence is invalid`);
    validateEvidence(item.evidence, `${location}.evidence`, diagnostics);
  });

  profile.packs.forEach((item, index) => {
    const location = `packs[${index}]`;
    if (!isRecord(item) || !nonEmptyString(item.id)) diagnostics.push(`${location}.id is required`);
    if (!isRecord(item) || typeof item.enabled !== "boolean") diagnostics.push(`${location}.enabled must be boolean`);
    if (!isRecord(item) || !["builtin", "project"].includes(item.source)) diagnostics.push(`${location}.source is invalid`);
  });

  profile.modules.forEach((item, index) => {
    const location = `modules[${index}]`;
    if (!isRecord(item)) return;
    if (!nonEmptyString(item.title)) diagnostics.push(`${location}.title is required`);
    validateSelector(item.selector, `${location}.selector`, diagnostics);
  });

  profile.scopeOverrides.forEach((item, index) => {
    const location = `scopeOverrides[${index}]`;
    if (!isRecord(item)) return;
    validateSelector(item.selector, `${location}.selector`, diagnostics);
    if (!["high", "medium", "low"].includes(item.confidence)) diagnostics.push(`${location}.confidence is invalid`);
    validateEvidence(item.evidence, `${location}.evidence`, diagnostics);
  });

  for (const key of ["knowledge", "conventions"]) {
    profile[key].forEach((item, index) => {
      const location = `${key}[${index}]`;
      if (!isRecord(item)) return;
      if (!["hard", "advisory"].includes(item.strength)) diagnostics.push(`${location}.strength is invalid`);
      if (!["agent-draft", "human", "imported"].includes(item.source)) diagnostics.push(`${location}.source is invalid`);
      if (item.selector !== undefined) validateSelector(item.selector, `${location}.selector`, diagnostics);
      if (item.evidence !== undefined) validateEvidence(item.evidence, `${location}.evidence`, diagnostics);
      if (item.detailPath !== undefined && !safeRepositoryPath(item.detailPath)) {
        diagnostics.push(`${location}.detailPath must be repository-relative`);
      }
    });
  }

  return { diagnostics, warnings };
}

function arraysHaveIds(value) {
  return value.length > 0 && value.every((item) => isRecord(item) && nonEmptyString(item.id));
}

function collectChanges(before, after, path, changes) {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (arraysHaveIds(before) && arraysHaveIds(after)) {
      const beforeById = new Map(before.map((item) => [item.id, item]));
      const afterById = new Map(after.map((item) => [item.id, item]));
      for (const id of [...beforeById.keys()].sort()) {
        if (!afterById.has(id)) changes.push({ type: "removed", path: `${path}[id=${id}]` });
      }
      for (const id of [...afterById.keys()].sort()) {
        if (!beforeById.has(id)) changes.push({ type: "added", path: `${path}[id=${id}]` });
        else collectChanges(beforeById.get(id), afterById.get(id), `${path}[id=${id}]`, changes);
      }
      return;
    }
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
      if (index >= before.length) changes.push({ type: "added", path: `${path}[${index}]` });
      else if (index >= after.length) changes.push({ type: "removed", path: `${path}[${index}]` });
      else collectChanges(before[index], after[index], `${path}[${index}]`, changes);
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPath = path === "$" ? `$.${key}` : `${path}.${key}`;
      if (!(key in before)) changes.push({ type: "added", path: childPath });
      else if (!(key in after)) changes.push({ type: "removed", path: childPath });
      else collectChanges(before[key], after[key], childPath, changes);
    }
    return;
  }
  changes.push({ type: "changed", path });
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "validate") {
    if (args.length < 1 || args.length > 2) throw new Error("validate expects <profile-file> [repository-root]");
    const profilePath = resolve(args[0]);
    const repositoryRoot = resolve(args[1] ?? process.cwd());
    const profile = readJson(profilePath);
    const result = validateProfile(profile);
    if (!isWithinRoot(repositoryRoot, profilePath)) {
      result.diagnostics.push("Profile file is outside the active repository root");
    }
    const output = {
      ok: result.diagnostics.length === 0,
      profilePath,
      repositoryRoot,
      fingerprint: fingerprint(profile),
      diagnostics: result.diagnostics,
      warnings: result.warnings,
    };
    print(output);
    if (!output.ok) process.exitCode = 1;
  } else if (command === "fingerprint") {
    if (args.length !== 1) throw new Error("fingerprint expects <profile-file>");
    print({ profilePath: resolve(args[0]), fingerprint: fingerprint(readJson(resolve(args[0]))) });
  } else if (command === "diff") {
    if (args.length !== 2) throw new Error("diff expects <current-profile> <candidate-profile>");
    const currentPath = resolve(args[0]);
    const candidatePath = resolve(args[1]);
    const current = readJson(currentPath);
    const candidate = readJson(candidatePath);
    const currentValidation = validateProfile(current);
    const candidateValidation = validateProfile(candidate);
    if (currentValidation.diagnostics.length > 0 || candidateValidation.diagnostics.length > 0) {
      print({
        ok: false,
        currentDiagnostics: currentValidation.diagnostics,
        candidateDiagnostics: candidateValidation.diagnostics,
      });
      process.exitCode = 1;
    } else {
      const changes = [];
      collectChanges(current, candidate, "$", changes);
      print({
        ok: true,
        currentPath,
        candidatePath,
        currentFingerprint: fingerprint(current),
        candidateFingerprint: fingerprint(candidate),
        reviewTransition: `${current.review.status} -> ${candidate.review.status}`,
        summary: {
          added: changes.filter((item) => item.type === "added").length,
          removed: changes.filter((item) => item.type === "removed").length,
          changed: changes.filter((item) => item.type === "changed").length,
        },
        changes,
      });
    }
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
