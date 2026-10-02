---
name: project-profiler
description: Create, adopt, refresh, validate, and semantically diff pi-convention-sense Project Profiles. Use when initializing project intelligence, profiling an existing repository, reviewing Profile changes, or updating .convention-sense/profile.json without calling a second LLM.
compatibility: Pi 0.87.1 (validated baseline), Node.js 22.19+, pi-convention-sense Profile schema v1
---

# Project Profiler

Use the current Agent to build a repository-scoped Project Profile. Do not call another model.

## Supported modes

The first argument must be one of:

- `init` — create a minimal Profile candidate for a new or sparsely implemented project.
- `adopt` — inspect an existing repository and create its first Profile candidate.
- `refresh` — re-profile an existing repository and stage a reviewed semantic diff.
- `diff` — compare the active Profile with a candidate; never modify either file.

If no mode was supplied, ask the user to choose one. Do not infer `refresh` when a reviewed Profile exists.

## Non-negotiable safety rules

1. Work only inside the active Git repository. One repository has one Profile.
2. Related frontend/backend repositories may be recorded in `project.relatedProjects`, but never inspect them or use their files as candidate evidence unless the user starts a separate profiling run in that repository.
3. Require a trusted project before reading project-local Profile or Pack files.
4. Never modify source code, `AGENTS.md`, build files, lint config, or test config during profiling.
5. Never turn compiler, lint, formatter, test, or security configuration into subjective convention text. Record executable systems as technology/evidence only.
6. Never promote one Local Snapshot into a project rule. Require repeated evidence or explicit user knowledge.
7. Never overwrite `.convention-sense/profile.json` silently. Stage `.convention-sense/profile.candidate.json`, run `diff`, and ask for approval first.
8. A generated candidate defaults to `review.status = "draft"`. Only set `reviewed` after explicit human approval, with `reviewedAt` and `reviewedBy`.
9. Draft `hard` items remain advisory at runtime. Global Pack items are always advisory.
10. Selectors are declarative only. Never add script, command, regex-execution, or arbitrary code fields.

## Setup

Resolve paths relative to this Skill directory. The helper has no external dependencies:

```bash
node ./scripts/profile-tools.mjs validate <profile-file> <repository-root>
node ./scripts/profile-tools.mjs fingerprint <profile-file>
node ./scripts/profile-tools.mjs diff <current-profile> <candidate-profile>
```

Read [the workflow reference](references/WORKFLOW.md) before `init`, `adopt`, or `refresh`. Read [the schema reference](references/PROFILE-SCHEMA.md) before writing JSON.

## Common discovery sequence

1. Resolve the repository root with Git. If Git is unavailable, use the nearest build/workspace root and state the fallback.
2. Check for `.convention-sense/profile.json` and `.convention-sense/profile.candidate.json`.
3. Inventory manifests, workspace files, module descriptors, generated/vendor paths, and build/test configuration.
4. Inspect representative production files by module and base role. Prefer repeated, maintained implementations; exclude generated, vendored, test-only, deprecated, and unrelated repositories.
5. Separate findings into:
   - technology and module facts;
   - architecture/domain knowledge;
   - coding conventions;
   - executable rules that must remain outside Profile conventions.
6. Attach evidence references to every non-trivial technology, override, knowledge item, and convention.
7. Write only the candidate file, validate it, fingerprint it, and show the semantic diff.
8. Ask the user whether to keep the candidate, adopt it as draft, or explicitly mark it reviewed.

## Mode workflows

### `init`

Use for a new project. Start from `assets/profile.template.json`, then:

- keep only technologies and Packs supported by manifests or explicit user choices;
- define module selectors before adding conventions;
- avoid claiming conventions when implementation evidence does not exist;
- stage and validate the candidate.

If an active Profile already exists, stop and suggest `refresh` or `diff`.

### `adopt`

Use for an existing repository without an active Profile.

- sample multiple files per important module/role;
- distinguish base roles from project-specific effective roles;
- record uncertain findings with low confidence or omit them;
- keep generated-source exclusions consistent with the runtime analyzer;
- stage a draft candidate and run `diff` against `/dev/null` only conceptually—do not use shell tricks that may be platform-specific. Summarize the new sections directly.

If an active Profile exists, stop and ask whether the user intended `refresh`.

### `refresh`

Use for an existing Profile.

- validate the active Profile first;
- preserve human/imported items and review provenance unless evidence disproves them;
- re-check every changed manifest/module/selector;
- do not delete a reviewed hard item without calling it out explicitly;
- increment `profileVersion`, update `generatedAt`, set `generatedBy` accurately, and stage the candidate as draft;
- run semantic `diff`, then request approval before replacing the active Profile.

### `diff`

Validate both files and run the helper. Report:

- old/new fingerprints;
- added, removed, and changed semantic paths;
- review-status changes;
- Pack id/version changes;
- effective-role and selector changes;
- removed human/reviewed items as high-risk changes.

Do not write files in this mode.

## Approval and promotion

After validation and diff, ask one structured question:

1. **Keep candidate (Recommended)** — leave the active Profile unchanged.
2. **Adopt as draft** — replace the active Profile with the validated candidate and retain `draft` status.
3. **Adopt as reviewed** — only when the user explicitly reviewed the diff; set review metadata before promotion.

Before promotion, re-run validation and verify that the active Profile fingerprint has not changed since the diff. If it changed, abort and regenerate the diff.

## Final report

Report the repository root, mode, files inspected, excluded paths, candidate path, old/new fingerprints, semantic changes, unresolved uncertainties, review status, and whether the active Profile changed. Never claim a Profile was reviewed without explicit user approval.
