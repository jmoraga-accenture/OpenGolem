# OpenGolem — Strict Code-Only Regression Catalog (`v0.1.0` vs `v0.3`)

Date: 2026-04-07
Author: Kai (coder)

## Comparison basis

This document compares **only shipped code** between the tagged releases:
- **`v0.1.0`** → commit `c5cdc28`
- **`v0.3`** → commit `c68d655`

Out of scope for this document:
- future v1.0 targets
- architecture aspirations
- milestone plans
- "missing by design" judgments
- whether a change was intended

The question here is only:

> **What capabilities or behaviors present in `v0.1.0` code are absent, narrower, or weaker in `v0.3` code?**

---

## Method

I compared the actual code trees under:
- `src/`
- `container/`
- `scripts/`
- build/runtime files such as `package.json`

### Top-level code diff receipt
`git diff --stat v0.1.0..v0.3 -- src container scripts package.json tsconfig.json vitest.config.ts`

Result:
- **42 files changed**
- **16,985 insertions**
- **237 deletions**
- **0 deleted source files** under `src/`, `container/`, or `scripts/`

That top-level result already suggests a codebase that mostly **adds** capability rather than removing it.

---

## Executive summary

After a strict code-only comparison, I do **not** find evidence of broad capability loss from `v0.1.0` to `v0.3`.

The real regressions / narrowed capabilities I can support from code receipts are:

1. **Container access to the host group filesystem is narrower in v0.3**
2. **Non-main groups lose broad read access to `groups/global/` in v0.3**
3. **Attachments become read-only in v0.3**
4. **User-visible diagnostic detail is reduced in some failure/block paths in v0.3**

And I can also support several important **non-regressions**:
- writable workspace still exists
- persistent sessions still exist
- compaction hook still exists
- oversized-session clearing existed already in `v0.1.0` and is actually less aggressive in `v0.3`

So the disciplined conclusion is:

> There are some real code-level behavior tightenings and visibility reductions in `v0.3`, but not a broad removal of core runtime capabilities.

---

## Confirmed regressions / narrowed capabilities

## R1 — Container no longer sees the full group directory
**Verdict:** Confirmed narrowing of capability

### v0.1.0 receipts
`src/container-runner.ts`:
- lines `230-239` mount the entire `groupDir` to `/workspace/group`
- `readonly: false`

```ts
mounts.push({
  hostPath: groupDir,
  containerPath: '/workspace/group',
  readonly: false,
});
```

### v0.3 receipts
`src/container-runner.ts`:
- lines `208-263` introduce `mountGroupFiles()`
- base mount is now `groups/{name}/workspace/ -> /workspace/group`
- `CLAUDE.md`, `logs/`, `attachments/` are overlaid explicitly
- `messages.db` is explicitly excluded

```ts
const workspaceDir = path.join(groupDir, 'workspace');
mounts.push({
  hostPath: workspaceDir,
  containerPath: '/workspace/group',
  readonly: false,
});
```

### Functional impact
In `v0.1.0`, anything placed flat in `groups/{name}/` was visible to the container.
In `v0.3`, the container sees a narrower filesystem contract:
- writable scratch area
- `CLAUDE.md`
- `logs/`
- `attachments/`

This means operators or workflows that relied on arbitrary top-level files appearing automatically inside `/workspace/group` will no longer work the same way.

### Classification
This is a **real capability narrowing**.
It is not total loss of workspace writes, but it is reduced filesystem surface.

---

## R2 — Non-main groups lose broad access to `groups/global/`
**Verdict:** Confirmed narrowing of capability

### v0.1.0 receipts
`src/container-runner.ts`:
- lines `241-247` mount the entire `globalDir` read-only to `/workspace/global`

```ts
mounts.push({
  hostPath: globalDir,
  containerPath: '/workspace/global',
  readonly: true,
});
```

### v0.3 receipts
`src/container-runner.ts`:
- lines `291-301` mount only `groups/global/CLAUDE.md`
- no whole-directory mount remains

```ts
const globalClaudeMd = path.join(globalDir, 'CLAUDE.md');
mounts.push({
  hostPath: globalClaudeMd,
  containerPath: '/workspace/global/CLAUDE.md',
  readonly: true,
});
```

### Functional impact
In `v0.1.0`, non-main groups could read arbitrary shared files placed in `groups/global/`.
In `v0.3`, they only receive `global/CLAUDE.md`.

So if `groups/global/` previously carried shared prompts, templates, reference notes, or shared operator files beyond `CLAUDE.md`, that capability is gone.

### Classification
This is a **real code-level loss of shared global file visibility**.

---

## R3 — Attachments are no longer writable by the agent
**Verdict:** Confirmed narrowing of capability

### v0.1.0 receipts
Because `v0.1.0` mounted the entire `groupDir` read-write at `/workspace/group`, the container had write access to:
- `/workspace/group/attachments/...`

### v0.3 receipts
`src/container-runner.ts`:
- lines `255-262` explicitly mount `attachments/` read-only

```ts
mounts.push({
  hostPath: attachDir,
  containerPath: '/workspace/group/attachments',
  readonly: true,
});
```

### Functional impact
In `v0.1.0`, an agent could modify, replace, rename, or delete files under `attachments/`.
In `v0.3`, it can only read them.

That is a genuine capability reduction for workflows like:
- in-place cleanup of uploaded files
- overwriting an attachment with a transformed version
- editing an attachment in place

The replacement workflow now has to write somewhere else (scratch/workspace), not back into `attachments/`.

### Classification
This is a **real, explicit loss of in-place attachment mutation capability**.

---

## R4 — User-visible diagnostic transparency is reduced
**Verdict:** Confirmed behavior reduction

### v0.1.0 receipts
`src/index.ts` sent Cato blocks to the user as:

```ts
`[Cato] Blocked (${cato.reason ?? 'policy'}).`
```

That exposed the block reason directly.

### v0.3 receipts
`src/index.ts` now sends a generic message:

```ts
"[BLOCKED] I can't help with that request. If you think this is a mistake, please try rephrasing."
```

Credential/auth-related raw container errors are also sanitized into a generic admin-needed message.

### Functional impact
From a strict code-only perspective, the user/operator loses some immediate diagnostic specificity in-channel.

### Classification
This is a **real reduction in direct diagnostic transparency**, even if it may be a deliberate safety/UX choice.

---

## Important non-regressions (claims not supported as losses)

## N1 — Writable workspace did not disappear
**Verdict:** Not a regression

### v0.1.0
- `groupDir -> /workspace/group` read-write

### v0.3
- `groups/{name}/workspace -> /workspace/group` read-write
- `CLAUDE.md` and `logs/` remain writable overlays

### Conclusion
The writable workspace contract changed shape, but did not disappear.

---

## N2 — Session persistence did not disappear
**Verdict:** Not a regression

### v0.1.0 receipts
- `prepareSessionLayout()` uses `DATA_DIR/sessions/<group>/...`
- `src/db.ts` persists session IDs via `setSession()` / `getAllSessions()`

### v0.3 receipts
- same host-backed session layout exists
- same session persistence in SQLite exists

### Conclusion
Persistent session state remains present in both releases.

---

## N3 — Context compaction did not disappear
**Verdict:** Not a regression

### v0.1.0 receipts
- `container/agent-runner/src/index.ts` defines `createPreCompactHook()`
- `PreCompact` hook registered with the SDK

### v0.3 receipts
- same hook and registration remain present

### Conclusion
Compaction support exists in both releases.

---

## N4 — Oversized-session clearing is not new in v0.3
**Verdict:** Not a regression; threshold improved in v0.3

### v0.1.0 receipts
`src/index.ts`:
- `MAX_SESSION_BYTES = 300_000`
- oversized session clears stored session mapping before spawn

### v0.3 receipts
`src/index.ts`:
- `MAX_SESSION_BYTES = 10_000_000`
- same behavior, but threshold is much higher

### Conclusion
The behavior existed already in `v0.1.0`; `v0.3` is actually less aggressive.

---

## Consolidated verdict table

| Item | v0.1.0 | v0.3 | Verdict |
|---|---|---|---|
| Writable workspace | present | present (via `workspace/` mount) | Not a regression |
| Persistent sessions | present | present | Not a regression |
| PreCompact hook | present | present | Not a regression |
| Oversized-session clear | present @ 300 KB | present @ 10 MB | Improved in v0.3 |
| Full `groupDir` visibility inside container | present | narrowed | **Regression / narrowing** |
| Full `groups/global/` visibility for non-main groups | present | narrowed to `CLAUDE.md` only | **Regression / narrowing** |
| Attachment write access | present | removed (read-only) | **Regression / narrowing** |
| User-visible raw diagnostic detail | higher | lower | **Regression / narrowing** |

---

## Bottom line

A strict code-only comparison does **not** support the claim that `v0.3` broadly lost core runtime capability relative to `v0.1.0`.

What it **does** support is a narrower statement:

1. `v0.3` significantly **tightens container filesystem exposure**
2. `v0.3` removes **broad shared-global file visibility** for non-main groups
3. `v0.3` removes **in-place attachment mutation** capability
4. `v0.3` reduces **in-channel diagnostic transparency**

Those are real code-level behavior changes.

But the larger operational claims about total loss of workspace writing, persistence, or compaction are **not** supported by the code comparison.
