# OpenGolem — Security Issues Review (v0.3-adjusted)

Date: 2026-04-06
Repo: `jmoraga-accenture/OpenGolem`
Commit reviewed: `c9f7494`

## Executive summary

This version separates:
1. security issues that genuinely apply to the current v0.3 build
2. security properties that are simply not implemented yet
3. spec/architecture gaps that prevent strong security claims from being fully justified

That distinction matters. A v0.3 should be allowed to be incomplete. It should not be allowed to be internally contradictory.

---

## 1) What's really missing for v0.3

### 1.1 Broker fail-open behavior
This remains the highest-priority issue.

If broker token issuance fails, container dispatch can still continue.

Why this really matters now:
- current docs and decisions describe broker-scoped execution as a present security property
- the code permits a degraded mode that weakens that claim

This is not just "not built yet." It is a broken current invariant.

### 1.2 Enforcement-status ambiguity in the Call Inspector
Two checks are advisory-only in code:
- skill whitelist
- memory scope

That is acceptable in a transitional build **only if the docs say so clearly**.

So the issue for v0.3 is not merely missing implementation; it is that the current security story is stronger than the actual enforcement.

### 1.3 User-facing raw Cato block strings
Strings like:
- `[Cato] Blocked (...)`
- `[Cato] Task blocked (...)`

are not catastrophic, but they expose a rough internal contract directly to users.
For v0.3, I would treat this as a real but moderate issue.

### 1.4 OneCLI configuration inconsistency
The documentation and code disagree on the relevant token variable name.

That is a small issue compared with broker fail-open, but it is still a real security/configuration defect because it affects a credential backend.

---

## 2) What's missing from the implementation

These are security properties the philosophy wants, but which are not fully built yet.

### 2.1 Mandatory request identity on proxied outbound calls
The implementation is missing the step that would let the proxy/inspector authenticate the calling container's broker identity on every request.

Without that, the most important broker-scoped guarantees remain incomplete.

### 2.2 Hard enforcement of skill scope and memory scope
The current design gestures toward this, but it is not implemented end-to-end.

### 2.3 Richer Cato inline coverage
The current inline gate is very narrow.
Missing categories include, for example:
- credential exposure patterns
- obvious PII-in-plaintext cases
- cross-context access shapes
- stronger high-confidence risky-action classes

### 2.4 A fully separated oversight trust domain
The current Cato seam is useful, but it is not yet a strong independent production trust boundary.

### 2.5 A user-safe explanation path for blocks
The implementation still lacks the designed flow where:
- enforcement stays internal/structured
- user explanation is rendered safely and intentionally

---

## 3) What's missing from architecture and specs for compliance with the philosophy

### 3.1 A hard security invariant section
The specs should say explicitly:
- no dispatch without broker identity
- no outbound proxy call without verifiable request identity
- which controls are mandatory vs advisory

### 3.2 A control-maturity matrix
Security docs should mark each control as one of:
- enforced
- partial
- scaffolded
- planned

This would prevent the repo from accidentally overstating what is already true.

### 3.3 A formal Cato result schema
The philosophy needs a defined internal block contract, e.g.:
- `allow`
- `code`
- optional internal `reason`

instead of relying on ad hoc raw strings.

### 3.4 A clearer definition of trust domains
The specs should separate:
- internal module boundaries
- IPC boundaries
- true separate trust domains

This is necessary if the security story is going to rest on protocol boundaries.

### 3.5 A consistent explanation policy
The philosophy says protection should educate, but the docs elsewhere still imply silent or opaque block behavior in some places.
That needs resolution.

---

## Bottom line

For v0.3, the strongest security critiques are:
- **broker fail-open**
- **overstated enforcement story**
- **rough/raw block UX**
- **credential-backend config inconsistency**

The rest should mostly be read as important missing implementation and missing spec hardening, not as proof that the early architecture is unsound.
