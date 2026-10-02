# Project Profile Schema v1

The runtime authority is `src/profile/types.ts` and `src/profile/profile-loader.ts`. This reference summarizes the authoring contract.

## Required root fields

```json
{
  "schemaVersion": 1,
  "profileVersion": "0.1.0",
  "project": { "name": "project", "repositoryRoot": "." },
  "generatedAt": "ISO-8601 timestamp",
  "generatedBy": "agent",
  "review": { "status": "draft" },
  "technologies": [],
  "packs": [],
  "modules": [],
  "scopeOverrides": [],
  "knowledge": [],
  "conventions": []
}
```

`generatedBy` is `agent`, `human`, or `imported`. `review.status` is `draft` or `reviewed`. A reviewed Profile should include `reviewedAt` and `reviewedBy`.

`project.repositoryRoot` must be exactly `.`. Related repositories use metadata entries with `name`, `path`, and relationship `frontend`, `backend`, `service`, `library`, or `documentation`.

## Declarative selectors

Only these fields are allowed:

- `paths`
- `excludePaths`
- `languages`
- `modules`
- `baseRoles`
- `fileNames`
- `annotationsAny`
- `dependenciesAny`

Every field is an array of strings. Selectors must not contain scripts, commands, executable regular expressions, or unknown fields. Paths are repository-relative globs and must not escape the repository.

## Evidence

Evidence entries contain:

- `kind`: `manifest`, `config`, `source`, `documentation`, or `user-review`;
- optional repository-relative `path` and `line`;
- concise `detail`.

Do not embed source contents. Evidence paths must not point into another repository.

## Technologies and Packs

Technology kinds include language, framework, architecture, persistence, transport, build, database, and infrastructure. Each technology needs confidence and evidence.

Pack references contain id, optional version, enabled flag, and source `builtin` or `project`. Enabling a nonexistent Pack is diagnostic and does not become a hard rule.

## Modules and overrides

Modules define path-scoped project boundaries, optional technologies, architecture tags, and knowledge/convention references.

Scope overrides refine a base role into an effective role. Use narrow selectors and evidence. Example:

```json
{
  "id": "rest-controller",
  "priority": 50,
  "selector": {
    "paths": ["server-web/**"],
    "baseRoles": ["controller"],
    "annotationsAny": ["RestController"]
  },
  "effectiveRole": "rest-controller",
  "architecture": ["spring-rest"],
  "tags": ["json-api"],
  "confidence": "high",
  "evidence": [
    { "kind": "source", "path": "server-web/JobController.java", "detail": "Uses @RestController" }
  ]
}
```

Higher priority wins. Avoid overlapping selectors with equal priority and incompatible roles.

## Knowledge and conventions

Knowledge categories are architecture, domain, dependency, workflow, security, or data. Convention categories are project-defined strings.

Strength is `hard` or `advisory`, but:

- draft hard items are downgraded to advisory at runtime;
- Global Pack hard items are always advisory;
- Guard does not block merely because code differs from these items.

Project item source is `agent-draft`, `human`, or `imported`. Every hard item should have explicit evidence and review provenance.

## Validation rules

`node ./scripts/profile-tools.mjs validate` and the runtime loader enforce the same rules (a differential test fails when they disagree). A Profile that breaks any of them is `invalid` at runtime and is ignored (fail-open to Local Evidence):

- `profileVersion` and `project.name` are non-empty strings; `generatedAt` parses as a date;
- every item in `technologies`, `modules`, `scopeOverrides`, `knowledge`, and `conventions` has a non-empty `id`, unique within its own list;
- `priority`, when present, is a finite number; `version` and `effectiveRole`, when present, are strings; `architecture`, `tags`, `knowledgeRefs`, and `conventionRefs`, when present, are string arrays;
- technology `kind` is one of the kinds listed above, and `confidence` is `high`, `medium`, or `low`; every technology and override carries an `evidence` array;
- knowledge items require `category` (one of the six above), `title`, and `summary`; convention items require `category` and `statement`; both require `strength` and `source`;
- every path (`paths`, `excludePaths`, evidence `path`, `detailPath`) is non-empty, repository-relative, not absolute, has no drive letter, and has no `..` segment;
- `project.relatedProjects` entries need a `name`, a `path`, and a valid relationship.

Path selectors are matched as globs with minimatch. For safety the runtime refuses very long or very complex patterns (more than 512 characters, more than 5 `*` runs in one path segment, or more than 3 extglob groups in one segment): they never match. Keep selectors simple; the validator does not flag such patterns.

## Version and review rules

- New Agent-generated Profiles start as draft.
- Refresh updates `generatedAt` and profileVersion.
- Do not preserve reviewed status automatically after material changes.
- Never claim human review without explicit approval.
