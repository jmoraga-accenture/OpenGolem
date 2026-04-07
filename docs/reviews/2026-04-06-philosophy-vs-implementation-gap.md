# OpenGolem — Philosophy Gap Review (v0.3-adjusted)

Date: 2026-04-06
Repo: `jmoraga-accenture/OpenGolem`
Commit reviewed: `c9f7494`

## Executive summary

OpenGolem's philosophy is strong and coherent. The mistake in my first draft was treating every philosophy-to-code gap as equally damning for a **v0.3** system.

That is too harsh.

A fairer reading is:
- some things are **real mismatches even for v0.3**
- some things are **simply not implemented yet**, which is normal for the milestone
- some things are **not yet specified tightly enough** to make philosophy-compliance testable

This rewrite separates those categories.

---

## 1) What's really missing for v0.3

These are the critiques that still apply even after giving the project full credit for being an early implementation.

### 1.1 Broker-mediated execution is not yet a hard invariant
This is the most important issue.

The docs and decisions describe broker-scoped execution as foundational, but `runContainerAgent()` can continue when token issuance fails.

Why this matters even for v0.3:
- this is not a future nice-to-have
- this is a contradiction in the current stated security model

### 1.2 The documentation overstates what is currently enforced
The repo presents a stronger picture than the code currently supports.

Most important example:
- the Call Inspector is described as a five-check protection layer
- in code, skill whitelist and memory scope are advisory only

For v0.3, the problem is not that these are unfinished.
The problem is that the docs often read as though they are already real enforcement.

### 1.3 Cato exists, but not yet at the strength the philosophy implies
Cato is present as a real seam in the architecture, but its inline enforcement is still very narrow.

Today it mainly blocks:
- path traversal in prompt
- oversized prompt

That means the philosophy's claim that Cato is the unconditional protection floor is only partially realized.

### 1.4 User-facing block behavior is rougher than the philosophy promises
The repo philosophy imagines explained protection and a clean Alef/Cato separation.

Current user-visible strings like:
- `[Cato] Blocked (...)`
- `[Cato] Task blocked (...)`

are workable for an internal build, but they are not yet the philosophy-complete UX.

For v0.3, I would call this a legitimate gap, but a moderate one.

---

## 2) What's missing from the implementation

These are important pieces that are absent or only scaffolded, but they should be read as implementation backlog more than as judgment on v0.3.

### 2.1 True token-scoped outbound authorization
The implementation still lacks the step that would make the broker/inspector story fully real:
- token identity propagated from container to proxy
- hard enforcement of skill scope
- hard enforcement of memory scope

### 2.2 A full Cato enforcement model
The implementation does not yet provide the broader Cato described by the philosophy, such as:
- structured risk codes
- richer inline policy coverage
- clearer distinction between deterministic rules and later LLM escalation

### 2.3 The intended Alef-translated `[BLOCKED]` path
The philosophy implies:
- Cato decides
- Alef explains

The implementation currently jumps closer to:
- Cato decides
- raw Cato string is shown directly

### 2.4 Formal skill declarations (`.intent.md`)
This is not implemented yet.

That matters because the philosophy leans heavily on auditable, declared capability boundaries.

### 2.5 Strategic memory architecture
Not implemented yet:
- semantic graph
- vector-backed strategic memory
- Obsidian sync or equivalent export model

### 2.6 Provider-agnostic runtime model
The code is still Anthropic/Claude-specific in practice.
That is acceptable for a v0.3 build, but it means the broader provider story is still future work.

### 2.7 Governance review surface
The repo has useful plumbing:
- audit log
- dao_score DB
- report files
- `/health`

But it does not yet have the clear admin-facing calibration surface implied by the philosophy.

---

## 3) What's missing from architecture and specs for compliance with the philosophy

This is the category that matters most long-term.
Even when the code catches up, the philosophy still needs tighter contracts.

### 3.1 The specs need a clearer line between current state and target state
The repo needs an explicit distinction between:
- what is already enforced now
- what is partially implemented
- what is future architecture

Without that, readers cannot tell whether a statement is:
- a present guarantee
- a roadmap goal
- a design aspiration

### 3.2 The Alef/Cato contract needs to be formalized, not just described
The philosophy is clear at a high level, but the specs should define:
- what Cato returns internally
- what Alef renders to users
- what gets logged canonically
- what must never be shown verbatim to users

### 3.3 The broker/inspector contract needs a hard invariant section
The specs should state unambiguously:
- whether dispatch is allowed without broker identity
- whether missing request identity is a hard block
- which inspector checks are currently advisory vs enforced

### 3.4 Trust-domain language needs precision
The philosophy talks about IPC boundaries and trust domains, but the docs should distinguish:
- interface seam
- IPC boundary
- separate trust domain

Those are not the same thing.

### 3.5 Philosophy-compliance needs a maturity model
The repo would benefit from a simple matrix such as:
- enforced
- partial
- scaffolded
- planned

applied to core claims like:
- broker scoping
- Cato enforcement
- memory isolation
- skill declaration
- strategic memory
- governance/dashboard

---

## Bottom line

A fair v0.3 reading is:

- **Really missing now:** broker fail-closed behavior, honest enforcement-status docs, stronger Cato/UX alignment
- **Missing from implementation:** token-scoped enforcement, full Cato model, skill intents, strategic memory, provider abstraction, governance surface
- **Missing from architecture/specs:** clearer current-vs-target separation, formal Alef/Cato contract, hard broker invariants, trust-domain precision, philosophy maturity model

That is a much more accurate judgment than saying the whole philosophy-to-code gap is a failure of the current build.
