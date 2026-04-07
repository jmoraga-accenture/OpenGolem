# OpenGolem — Runtime / Operational Regression Catalog

Date: 2026-04-07
Basis: observed runtime behavior reported after v0.3 update

## Purpose

This document catalogs **runtime regressions** that may not be obvious from repository structure, tags, or architectural docs, but which materially reduce the actual usefulness of the system.

This is separate from:
- philosophy/spec compliance
- implementation backlog
- repo-visible capability comparisons

Because a system can look architecturally richer on paper while still being **operationally worse** in practice.

---

## Executive summary

The regressions described here are serious.

If bots:
- cannot reliably create files in their workspace
- lose state because everything is transient
- fail to compact or summarize context as sessions grow
- reset sessions when context becomes too long instead of degrading gracefully

then that is a **major functional regression**, even if many nominal features still exist in the codebase.

These are not minor bugs. They break foundational assistant behavior.

---

## Severity framework

### P0 / critical
Breaks a core promise of the system and makes normal long-running use unreliable.

### P1 / major
Important user-facing capability still exists in some form, but frequently fails or requires manual recovery.

### P2 / moderate
Usable but degraded; friction is significant.

---

## Catalog of operational regressions

## R-1 — Durable workspace writes are broken or unreliable
**Severity:** P0

### Observed symptom
Bots could not create files in their workspace reliably.

### Why this matters
This breaks one of the most important practical capabilities of an agent system:
- maintaining durable notes
- writing task outputs
- updating plans / scratchpads
- persisting state between turns

### Impact
Without reliable workspace writes, the agent cannot behave like a real working assistant. It becomes closer to a stateless chat responder.

### Category
- durable workspace regression
- persistence regression

---

## R-2 — State is effectively transient
**Severity:** P0

### Observed symptom
Everything was transient.

### Why this matters
An agent with transient state loses:
- continuity across tasks
- continuity across retries
- continuity across resets/restarts
- the ability to accumulate working memory in files

### Impact
This destroys the practical value of long-running assistance, because the agent cannot build on previous work reliably.

### Category
- continuity regression
- persistence regression

---

## R-3 — No context compaction / summarization path
**Severity:** P0

### Observed symptom
The bots were not compacting context when sessions got long.

### Why this matters
Long-session survivability is a core requirement for useful agent systems.
A well-behaved agent should have at least one of these:
- summary handoff
- rolling compression
- state distillation into durable files
- message pruning backed by persistent notes

### Impact
Without compaction, long conversations become fragile by design.
The system eventually fails for normal usage rather than exceptional usage.

### Category
- context-management regression
- long-session survivability regression

---

## R-4 — Reset on context overflow instead of graceful degradation
**Severity:** P0

### Observed symptom
When context got too long, the session reset.

### Why this matters
A reset is the worst possible fallback when the system is supposed to be an ongoing assistant.

Better degradation patterns would be:
- summarize and continue
- checkpoint to files and continue
- preserve task state and reopen with handoff summary
- narrow the active working set while retaining durable context

### Impact
This turns normal usage growth into catastrophic state loss.

### Category
- context-overflow failure
- reliability regression
- graceful-degradation failure

---

## R-5 — Long-running tasks require manual rescue
**Severity:** P1

### Observed symptom
If persistence and compaction fail, the human must step in repeatedly to restore context or restart work.

### Why this matters
This defeats the point of agentic operation.
The operator becomes the continuity layer.

### Impact
The tool may still demonstrate features, but it stops functioning as a trustworthy assistant for ongoing work.

### Category
- autonomy regression
- operator-burden regression

---

## R-6 — The system regresses from “assistant” toward “ephemeral chat session”
**Severity:** P1

### Observed symptom
Capabilities may still exist individually, but the overall experience is that the bot cannot sustain work over time.

### Why this matters
An assistant is not just a bag of features.
It needs:
- durable working memory
- recoverability
- resumability
- continuity across long sessions

If those are broken, many nominal features lose most of their value.

### Category
- product-level regression
- assistant-coherence regression

---

## What these regressions break at the product level

These issues break three foundational promises:

### 1. Persistence
Work should survive.

### 2. Continuity
The agent should keep track of ongoing work over time.

### 3. Graceful degradation
When limits are hit, the system should preserve continuity rather than discard it.

If all three are compromised, that is absolutely a major regression.

---

## Relationship to the earlier repo/tag comparison

The earlier v0.1 → v0.3 capability catalog concluded that there was not a broad loss of **repo-visible** feature surface.

That can still be true **while this document is also true**.

Both statements can coexist:
- the codebase still contains many named features
- the runtime behavior regressed in the practical, user-visible core of persistence and continuity

In fact, that combination is common in systems that become more architecturally ambitious while becoming less operationally stable.

---

## Recommended framing

If this needs to be stated plainly, I would frame it like this:

> v0.3 may not have lost a huge number of named features, but it appears to have suffered a serious regression in the core assistant contract: durable workspace state, continuity across long sessions, and graceful handling of context growth.

That is enough on its own to justify calling the release a major functional regression.

---

## Bottom line

Yes — these are major regressions.

The right labels are:
- **durable workspace regression**
- **continuity regression**
- **context-management regression**
- **graceful-degradation regression**
- **operational reliability regression**

If I had to collapse it to one sentence:

> The system did not merely lose polish; it regressed in the basic mechanics required for an agent to remain useful over time.
