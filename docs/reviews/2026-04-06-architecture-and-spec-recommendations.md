# OpenGolem — Architecture and Spec Recommendations (v0.3-adjusted)

Date: 2026-04-06
Repo: `jmoraga-accenture/OpenGolem`
Commit reviewed: `c9f7494`

## Executive summary

The goal of this rewrite is not to demand a v1.0 system from a v0.3 repository.
It is to say, more precisely:
- what a v0.3 should already have nailed down
- what can reasonably remain implementation backlog
- what must be clarified in the architecture/specs so "philosophy compliance" becomes testable rather than rhetorical

---

## 1) What's really missing for v0.3

These are the recommendations I would treat as appropriate even for the current milestone.

### 1.1 Make broker identity mandatory for dispatch
This should be elevated from aspiration to present invariant.

Recommendation:
- container dispatch must fail closed if broker issuance fails

### 1.2 State enforcement status honestly in the docs
For each major control, the docs should indicate whether it is:
- enforced
- partial
- scaffolded
- planned

At minimum, this should be done for:
- broker scoping
- Call Inspector checks
- Cato inline enforcement
- scheduled audit behavior

### 1.3 Improve the user-facing block contract
Even for v0.3, the block path should move toward:
- structured internal result
- clearer user-safe explanation
- less raw `[Cato] ...` leakage

### 1.4 Clarify what Cato currently is
The docs should explicitly describe current Cato as:
- a real architectural seam
- a narrow deterministic inline stub in this phase
- not yet the full philosophy-complete oversight layer

That is honest and still strong.

---

## 2) What's missing from the implementation

These are the major build items still needed to match the intended architecture.

### 2.1 End-to-end broker-scoped outbound authorization
Needed implementation pieces:
- request identity propagation from container to proxy
- verification against broker-issued identity
- hard enforcement of skill scope
- hard enforcement of memory scope

### 2.2 A fuller Cato model
Needed implementation pieces:
- structured risk codes
- richer inline rule coverage
- cleaner upgrade path to constrained LLM escalation
- cleaner surfacing of audit findings

### 2.3 Formal skill declarations
Needed implementation pieces:
- `.intent.md` schema
- intent validation
- broker issuance constrained by applied skill set

### 2.4 Governance surface
Needed implementation pieces:
- operator/admin review surface for audit trends, reports, and KPIs

### 2.5 Provider abstraction
Needed implementation pieces:
- separate provider config from credential backend
- provider-aware endpoint/capability model
- less Anthropic-specific wiring at the architecture boundary

### 2.6 Strategic memory implementation
Needed implementation pieces:
- strategic memory design
- promotion/write rules
- access-control model
- optional export/sync layer

---

## 3) What's missing from architecture and specs for compliance with the philosophy

This is the most important long-term section.
A lot of the philosophy is good, but it still needs tighter contracts.

### 3.1 Separate current guarantees from target architecture
The specs should clearly mark three levels:
- current guarantee
- partial implementation
- future design target

This would reduce almost all ambiguity in the repo.

### 3.2 Define the Alef/Cato contract precisely
The philosophy needs a first-class spec for:
- Cato's internal decision schema
- Alef's user-facing rendering responsibilities
- canonical logging format
- what evidence must remain internal

### 3.3 Define trust domains precisely
The specs should enumerate:
- components
- permitted communication paths
- authentication basis
- audit location
- whether the boundary is conceptual, IPC, or true trust separation

### 3.4 Define philosophy compliance as a checklist
The project would benefit from a compliance checklist such as:
- broker fail-closed: yes/no
- request identity mandatory: yes/no
- skill scope enforced: yes/no
- memory scope enforced: yes/no
- Cato separate trust domain: yes/no
- Alef-translated `[BLOCKED]` path: yes/no
- admin calibration surface: yes/no

This would make reviews concrete.

### 3.5 Resolve internal documentation contradictions
Most important contradictions to resolve:
- silent protection vs explained protection
- current-state enforcement vs future-state aspiration
- narrow current Cato vs broad philosophical Cato
- Anthropic-specific runtime vs provider-agnostic architectural language

---

## Bottom line

A fair v0.3 recommendation set is:

- **Really missing now:** fail-closed broker dispatch, honest control-status docs, better-defined current Cato/block contract
- **Missing from implementation:** end-to-end broker enforcement, fuller Cato, skill intents, governance surface, provider abstraction, strategic memory
- **Missing from architecture/specs:** clean current-vs-target separation, formal Alef/Cato contract, precise trust-domain map, philosophy compliance checklist, contradiction cleanup

That framing is much more useful than evaluating the repo as though it had claimed to already be v1.0-complete.
