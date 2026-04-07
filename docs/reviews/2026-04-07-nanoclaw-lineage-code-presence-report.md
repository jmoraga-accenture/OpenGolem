# OpenGolem v0.3 — NanoClaw Source Presence Report

Date: 2026-04-07
Author: Kai (coder)
Audience: Development team

## Scope and comparison basis

This report answers a narrow question:

> **Is there any NanoClaw source code still present in OpenGolem `v0.3`?**

Comparison targets:
- **OpenGolem `v0.3`** → tag `v0.3`, commit `c68d655`
- **NanoClaw** → cloned from `https://github.com/qwibitai/nanoclaw` into `/tmp/coder/coder-nanoclaw-P9hfq2/nanoclaw`

OpenGolem `v0.3` tree was materialized from the tag into:
- `/tmp/coder/opengolem-v0.3-src`

This report is about **code presence / lineage**, not legal attribution, not licensing analysis, and not whether retention was intended.

---

## Executive summary

**Yes.** There is still NanoClaw source code present in OpenGolem `v0.3`.

This conclusion is supported by three independent signals:

1. **Exact identical files** remain
2. **Normalized identical files** remain (same code after stripping whitespace/comments)
3. **High-similarity same-path files** remain across important runtime modules

The strongest conclusion the data supports is:

> OpenGolem `v0.3` is **not** a clean-room codebase with respect to NanoClaw. It is a heavily modified descendant/fork with substantial retained source, including exact carryover files and many near-identical runtime modules.

---

## Methodology

I used three comparison passes.

### 1) Exact byte-identical file comparison
Compared SHA-256 hashes of files under:
- `src/`
- `container/`
- `scripts/`

This identifies files whose contents are exactly unchanged.

### 2) Normalized identical comparison
Compared files after normalization:
- strip whitespace
- strip JS/TS comments
- strip shell comments

This catches files that are effectively the same code with cosmetic changes.

### 3) Same-relative-path similarity comparison
For files sharing the same relative path in both repos, computed normalized similarity using `difflib.SequenceMatcher`.

This is conservative:
- it does **not** try to prove authorship
- it does **not** do AST clone detection
- it does **not** catch all renamed/split/reassembled code

So the results below are a **floor**, not a ceiling.

---

## Summary counts

### Exact byte-identical files in `src/`, `container/`, `scripts/`
**Count:** 7

### Normalized-identical files (broader tree)
**Count:** 25

### High-similarity same-path files (normalized similarity ≥ 0.90)
**Count:** 46

These numbers are already enough to answer the question in the affirmative.

---

## A. Exact byte-identical files

These are unchanged at the byte level in the code-focused trees.

### Exact identical code/config/test files
- `container/agent-runner/tsconfig.json`
- `container/skills/agent-browser/SKILL.md`
- `scripts/run-migrations.ts`
- `src/channels/registry.test.ts`
- `src/group-folder.test.ts`
- `src/task-scheduler.test.ts`
- `src/timezone.test.ts`

### Interpretation
Even before looking at "almost identical" files, there is already direct carryover.

The most important runtime-bearing item in this list is:
- **`scripts/run-migrations.ts`**

The rest include tests/config/skill material, which still matter because they show retained repo substance rather than a complete rewrite.

---

## B. Normalized-identical files

These remain identical after removing whitespace/comments.

### Source/config/tooling files
- `.mcp.json`
- `eslint.config.js`
- `scripts/run-migrations.ts`
- `setup/environment.ts`
- `setup/groups.ts`
- `setup/platform.ts`
- `setup/timezone.ts`
- `tsconfig.json`
- `vitest.config.ts`
- `vitest.skills.config.ts`

### Tests / ancillary exact carryover
- `container/agent-runner/tsconfig.json`
- `setup/platform.test.ts`
- `src/channels/registry.test.ts`
- `src/group-folder.test.ts`
- `src/task-scheduler.test.ts`
- `src/timezone.test.ts`

### Interpretation
This is no longer just "some old tests survived." There is direct carryover in:
- setup code
- migration code
- repo/tooling configuration

That is meaningful retained source lineage.

---

## C. High-similarity runtime/source files

These are same-path files with normalized similarity ≥ 0.90, excluding exact normalized matches.

### High-similarity runtime/source files
- `container/agent-runner/src/index.ts` → **0.983**
- `container/agent-runner/src/ipc-mcp-stdio.ts` → **0.978**
- `setup/container.ts` → **0.984**
- `setup/register.ts` → **0.995**
- `setup/status.ts` → **0.975**
- `src/channels/registry.ts` → **0.947**
- `src/env.ts` → **0.943**
- `src/remote-control.ts` → **0.981**
- `src/router.ts` → **0.907**
- `src/task-scheduler.ts` → **0.928**
- `src/types.ts` → **0.992**
- `container/build.sh` → **0.968**

### High-similarity tests / support code
- `src/group-queue.test.ts` → **0.999**
- `src/routing.test.ts` → **0.999**
- `src/ipc-auth.test.ts` → **0.998**
- `src/remote-control.test.ts` → **0.998**
- `setup/environment.test.ts` → **0.997**
- `setup/register.test.ts` → **0.991**
- `src/db.test.ts` → **0.977**
- `src/container-runtime.test.ts` → **0.967**
- `src/container-runner.test.ts` → **0.935**
- `setup/service.test.ts` → **0.946**
- `src/logger.ts` → **0.908**

### Interpretation
The strongest evidence lives here.

Files like:
- `container/agent-runner/src/index.ts`
- `src/remote-control.ts`
- `src/task-scheduler.ts`
- `src/router.ts`
- `src/types.ts`

are central runtime modules, not incidental scaffolding.

At 0.90–0.99 normalized similarity, these are best described as:
- retained source
- lightly/moderately edited descendants
- not independently reimplemented from scratch

---

## D. Direct textual references to NanoClaw remain in the repository

A direct source reference remains in:
- `src/broker/credentials/onecli.ts`
  - line 6 mentions NanoClaw's security model

There are also many NanoClaw references in docs, attribution, and skill files. Those are not the core of this report, but they matter because they show the repo itself still openly carries NanoClaw lineage context.

The most important documentation contradiction is this:
- `ATTRIBUTION.md` states OpenGolem was progressively rewritten and that **"No NanoClaw source remains"**

The code comparison in this report does **not** support that claim.

---

## Strongest evidence against the claim "no NanoClaw source remains"

If the team needs the shortest possible receipt list, use these:

### Exact identical
- `scripts/run-migrations.ts`

### Near-identical runtime modules
- `container/agent-runner/src/index.ts` → 0.983
- `container/agent-runner/src/ipc-mcp-stdio.ts` → 0.978
- `src/remote-control.ts` → 0.981
- `src/task-scheduler.ts` → 0.928
- `src/router.ts` → 0.907
- `src/types.ts` → 0.992
- `setup/register.ts` → 0.995
- `setup/status.ts` → 0.975

This alone is enough to reject the proposition that `v0.3` contains no NanoClaw source.

---

## What this report does **not** claim

This report does **not** claim:
- that OpenGolem is identical to NanoClaw
- that no meaningful original work has been added
- that the retained files were copied recently
- that all retained code is improper or undisclosed

It only claims what the receipts support:
- there is still substantial NanoClaw-derived source in `v0.3`

---

## Limitations

This analysis is conservative.

It likely **understates** retained lineage because it does not yet do:
- AST clone detection
- function-level subfile clone detection
- renamed-file semantic matching across unrelated paths
- token n-gram or suffix-array clone analysis

So the report should be read as:
- **minimum confirmed carryover**, not maximum

---

## Conclusion

With receipts:

> **Yes — OpenGolem `v0.3` still contains NanoClaw source code.**

More precisely:
- some files are **exactly identical**
- more are **normalized-identical**
- many core runtime modules are **highly similar descendants**

Therefore the statement that OpenGolem `v0.3` has **no NanoClaw source remaining** is not supported by the current codebase.

A more accurate characterization is:

> OpenGolem `v0.3` is a substantially modified descendant of NanoClaw, not a clean-room source break.

---

## Appendix A — Exact byte-identical file list

- `container/agent-runner/tsconfig.json`
- `container/skills/agent-browser/SKILL.md`
- `scripts/run-migrations.ts`
- `src/channels/registry.test.ts`
- `src/group-folder.test.ts`
- `src/task-scheduler.test.ts`
- `src/timezone.test.ts`

## Appendix B — Normalized-identical file list

- `.mcp.json`
- `container/agent-runner/tsconfig.json`
- `container/skills/agent-browser/SKILL.md`
- `docs/config-examples/mount-allowlist.json`
- `eslint.config.js`
- `scripts/run-migrations.ts`
- `setup/environment.ts`
- `setup/groups.ts`
- `setup/platform.test.ts`
- `setup/platform.ts`
- `setup/timezone.ts`
- `src/channels/registry.test.ts`
- `src/group-folder.test.ts`
- `src/task-scheduler.test.ts`
- `src/timezone.test.ts`
- `tsconfig.json`
- `vitest.config.ts`
- `vitest.skills.config.ts`

## Appendix C — High-similarity same-path files (≥ 0.90)

### Runtime / source
- `container/agent-runner/src/index.ts` → 0.983
- `container/agent-runner/src/ipc-mcp-stdio.ts` → 0.978
- `container/build.sh` → 0.968
- `setup/container.ts` → 0.984
- `setup/register.ts` → 0.995
- `setup/status.ts` → 0.975
- `src/channels/registry.ts` → 0.947
- `src/env.ts` → 0.943
- `src/logger.ts` → 0.908
- `src/remote-control.ts` → 0.981
- `src/router.ts` → 0.907
- `src/task-scheduler.ts` → 0.928
- `src/types.ts` → 0.992

### Tests / support
- `src/group-queue.test.ts` → 0.999
- `src/routing.test.ts` → 0.999
- `src/ipc-auth.test.ts` → 0.998
- `src/remote-control.test.ts` → 0.998
- `setup/environment.test.ts` → 0.997
- `setup/register.test.ts` → 0.991
- `src/db.test.ts` → 0.977
- `src/container-runtime.test.ts` → 0.967
- `src/container-runner.test.ts` → 0.935
- `setup/service.test.ts` → 0.946
