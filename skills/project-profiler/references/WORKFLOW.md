# Project Profiler Workflow

## Evidence policy

Every durable conclusion must be traceable to one or more of:

- manifest or workspace configuration;
- project documentation;
- repeated production-source implementations;
- explicit user review.

A single implementation may justify a low-confidence scope override only when the role is structurally explicit, such as `@Controller` versus `@RestController`. It does not justify a broad coding convention.

Never use generated, vendored, test-only, deprecated, build-output, or cross-repository files as primary convention evidence.

## Repository inventory

Inspect in this order:

1. Git root and dirty state. Profiling is read-only except `.convention-sense/profile.candidate.json`.
2. Root manifests and workspace descriptors.
3. Module manifests and source roots.
4. Generated/vendor/test/build-output paths.
5. Framework entry points and architecture boundaries.
6. Representative files for each important base role.
7. Existing Profile and project-local Packs.

Record related repositories as metadata only. Profile them in separate sessions rooted in those repositories.

## Sampling guidance

For each proposed convention:

- prefer 3 or more maintained production samples;
- record counterexamples and mixed patterns;
- omit a rule when the evidence is weak and not explicitly reviewed;
- use selectors narrow enough to explain exceptions;
- prefer an effective-role split over calling incompatible implementations one convention.

For modules, use stable path boundaries. For roles, combine base role with annotations, file names, dependencies, or narrow module paths. Do not use arbitrary scripts.

## Knowledge versus conventions

Project knowledge explains architecture, domain, dependencies, workflow, security, or data boundaries. A convention describes a repeated coding pattern. Executable configuration remains executable and is not copied into convention prose.

Examples:

- “server-ui returns rendered views” → architecture knowledge.
- “controllers use constructor injection” → convention, only with repeated evidence.
- “Checkstyle forbids wildcard imports” → executable rule; reference the config, do not duplicate it as advisory prose.

## Candidate lifecycle

1. Read and fingerprint the active Profile if present.
2. Build `.convention-sense/profile.candidate.json`.
3. Validate the candidate with `profile-tools.mjs validate`.
4. Run semantic diff against the active Profile.
5. Summarize risky changes and uncertainties.
6. Ask for explicit approval.
7. Before promotion, verify the active fingerprint is unchanged.
8. Promote atomically using the agent’s normal file tool; do not use a shell command that can mutate unrelated files.

A refreshed candidate defaults to draft even when the old Profile was reviewed. Explicit review of the displayed diff is required to mark the new version reviewed.

## Mode-specific checks

### Init

- Active Profile must not exist.
- Ask which baseline Packs the user wants before enabling unsupported Packs.
- Empty knowledge/conventions are acceptable.

### Adopt

- Active Profile must not exist.
- Inspect existing code before proposing rules.
- Include exclusions and exceptions discovered during sampling.

### Refresh

- Active Profile must validate.
- Preserve human/imported items unless the diff calls out their removal.
- Re-check changed manifests and paths.
- Increment `profileVersion` deliberately; do not invent semantic-version meaning without project policy.

### Diff

- No writes.
- Highlight review status, Pack versions, module selectors, effective roles, removed human items, and hard/advisory changes.

## Required final report

- mode and repository root;
- active/candidate paths and fingerprints;
- manifests and representative files inspected;
- exclusions used;
- added/removed/changed semantic paths;
- uncertainty and conflicting evidence;
- final review status;
- whether the active Profile changed.
