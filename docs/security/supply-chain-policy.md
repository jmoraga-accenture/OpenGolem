*Status: Approved | Produced: 2026-04-06 | Updated: 2026-04-07 (§3.1 current state corrected; digest and pin compliance confirmed; Parts 1–2 policy summary added)*

# OpenGolem — Supply-Chain Policy
*Supply-Chain Auditor session | Stream L — Phase 1*
*Inputs: container/Dockerfile, container/build.sh, container/agent-runner/package.json, package.json, package-lock.json, docs/ECOSYSTEM.md, docs/DECISIONS.md Decision 7, docs/sec/security-strengthening.md F-10, docs/ARCHITECTURE.md §1.2*

---

## Part 1 — npm Audit CI Enforcement Rule

### 1.1 Zero-High-Severity Gate

**Command:** `npm audit --audit-level=high`

All CI pipelines for the OpenGolem host-side codebase must run this command as a required check on every PR and push to `main`. A result with any `high` or `critical` finding in any production dependency causes a CI failure and blocks merge.

**Production dependency scope:** The gate applies to packages in the `dependencies` block (not `devDependencies`). Development dependencies are audited separately with `npm audit --only=dev --audit-level=critical`: a `critical` devDep finding is a gate failure; a `high` devDep finding is a warning logged but not blocking.

**Nightly sweep:** A separate nightly CI job runs `npm audit --audit-level=moderate` against `main` without a PR gate, catching newly disclosed CVEs between PR cycles. A new `high` or `critical` nightly finding triggers an alert requiring human review within one business day.

**Suppression:** Individual CVEs may be suppressed only via a `.nsprc` entry containing the CVE identifier, suppression date, justification, and responsible approver (Jim). Blanket suppression of audit-level gates is prohibited. Suppressed CVEs are reviewed at the next scheduled audit cycle and must be re-evaluated when a patch becomes available.

**Current status:** `npm audit` is not yet running in CI. This is the highest-priority gap from the Phase 1 audit (Finding SC-1 in `supply-chain-audit-phase1.md`).

---

## Part 2 — package-lock.json Integrity Verification

### 2.1 Lockfile Enforcement

**Install command:** All CI and deployment install steps must use `npm ci`, not `npm install`. `npm ci` installs from `package-lock.json` exactly, failing if `package.json` and `package-lock.json` are out of sync.

**What constitutes a failure mode:** The CI step fails if:
- `package-lock.json` is absent from the repository
- `package-lock.json` and `package.json` are inconsistent (version mismatch)
- Any package's integrity hash in the lockfile does not match the registry-reported hash

**Lockfile commit policy:** `package-lock.json` must be committed to the repository and must not be in `.gitignore`. PRs that modify `package.json` must also update `package-lock.json`; a PR that modifies `package.json` without a corresponding lockfile update is blocked by CI.

**Current status:** `package-lock.json` is committed and not in `.gitignore`. Whether `npm ci` is used in CI has not been confirmed. See Finding SC-2 in `supply-chain-audit-phase1.md`.

### 2.2 Dependency Addition Policy

Any PR that adds a new production dependency must include in the PR description:
1. The functional justification for the new package (what capability it provides that no existing dependency satisfies).
2. A brief transitive graph review: the number of transitive packages added, whether any have `postinstall`/`preinstall` scripts, and whether any are native bindings.
3. Evidence that the package has no current `high` or `critical` CVEs (`npm audit` output or equivalent).
4. Confirmation that the version is pinned exactly in `package.json` (no caret or tilde range for production dependencies).

Jim is the named approver for all new production dependency additions.

### 2.3 Version Update Trigger Classes

**Class A — Security-triggered (mandatory):** CVE at HIGH or CRITICAL severity. Update within 72 hours. PR must include exploitability assessment for the OpenGolem deployment context.

**Class B — Patch-version update (on-demand):** New patch release, no CVE trigger. Permitted but not automatic. Quarterly review cadence for `cron-parser`; on-demand only for `grammy` and `better-sqlite3`.

**Class C — Minor or major version bump:** Requires Jim sign-off as named approver. PR must document transitive graph changes, any new install scripts, and (for `better-sqlite3`) whether the binary download mechanism changed.

**72-hour quarantine:** No production dependency is updated to a version published within the previous 72 hours, absent a confirmed CVE in the current version.

**`better-sqlite3` binary verification:** Any `better-sqlite3` version bump requires manual SHA-256 verification of the downloaded prebuilt `.node` binary against the hash published on the GitHub releases page, documented in the PR. See Finding SC-3 in `supply-chain-audit-phase1.md`.

---

## Part 3 — Container Base Image Policy

### 3.1 Current State

*Updated 2026-04-07: The Dockerfile has been verified against the current source. The digest-pinning and global-install-pinning requirements described in §3.2 are already implemented. The original §3.1 described a floating-tag state; that description reflected the policy intent at time of writing. The actual Dockerfile is compliant.*

The agent container is built from:

```
FROM node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea
```

This is a digest-pinned reference — **compliant with §3.2**. The digest resolves deterministically to the same image bytes regardless of any tag overwrite on Docker Hub.

The global npm installs are also exact-version pinned:

```
RUN npm install -g agent-browser@0.25.1 @anthropic-ai/claude-code@2.1.92
```

Both pins are **compliant with §3.2**.

The remaining gap is that a CI enforcement check (to prevent a future PR from removing the digest) and Trivy scanning are not yet implemented. These are addressed by Findings SC-5 and SC-7 in `supply-chain-audit-phase1.md`.

### 3.2 Base Image Pinning Policy

**Requirement:** The Dockerfile `FROM` line must reference the base image by digest, not by tag alone.

**Required format:**
```
FROM node:22-slim@sha256:<64-character-hex-digest>
```

The `node:22-slim` tag may be retained as a human-readable label alongside the digest, but the digest is the authoritative reference that Docker resolves. A Dockerfile that references a tag without a digest must be rejected by CI.

**CI enforcement:** A lint step must verify the presence of a `@sha256:` digest reference in the `FROM` line:
```bash
grep -E '^FROM.*@sha256:[a-f0-9]{64}' container/Dockerfile || \
  (echo "ERROR: Dockerfile FROM must include digest pin" && exit 1)
```
This step runs on every PR and push to `main`.

**How to obtain the current digest:**
```bash
docker pull node:22-slim
docker inspect node:22-slim --format='{{index .RepoDigests 0}}'
```

Or without pulling:
```bash
docker buildx imagetools inspect node:22-slim --format '{{json .Manifest}}' | jq -r '.digest'
```

**Digest update procedure:** The digest is updated deliberately, following the scanning gate described in §3.3. The update constitutes a code change (Dockerfile modification), is committed to the repository, and undergoes the standard PR review and merge process. No automated digest bump is permitted without a human review step.

**npm global installs inside the Dockerfile:** Global installs must use exact version pins, as currently implemented:
```
RUN npm install -g agent-browser@<exact-version> @anthropic-ai/claude-code@<exact-version>
```

Exact versions are determined at pin time, verified against the npm registry, and updated via the same deliberate review process as the base image digest.

### 3.3 Image Scanning Policy

**Required tool:** [Trivy](https://github.com/aquasecurity/trivy) (open source, widely used in CI, covers OS packages and language-layer vulnerabilities).

**Scan target:** The fully built `opengolem-agent:latest` image (after all layers including `npm install -g` and the agent-runner `npm install`). Scanning the base image alone is insufficient — vulnerabilities introduced by the npm install layers must also be detected.

**Gate:** The CI build step that produces the agent container image must run:
```bash
trivy image --exit-code 1 --severity CRITICAL,HIGH opengolem-agent:latest
```

A scan result with any `CRITICAL` or `HIGH` severity finding causes a CI failure and blocks deployment of the image. The gate applies to all severity sources: OS packages (apt-installed via the Dockerfile), npm packages installed globally, and the agent-runner npm dependencies.

**Findings triage:** A HIGH or CRITICAL finding in the base OS layer (Debian/Ubuntu packages installed by `apt-get`) is expected to appear over time as CVEs are disclosed against packages like `chromium`, `libnss3`, and the other Chromium dependencies. These findings follow the same escalation path as npm CVEs (§2.5 of `dependency-audit.md`): triage within 24 hours, interim mitigation decision, suppression with expiry if risk-accepted.

**Suppression format for container CVEs:** Trivy supports `--ignorefile .trivyignore`. Any suppressed CVE must be recorded in `.trivyignore` with a comment line immediately preceding the CVE ID containing: the suppression date, the justification, and the expiry date. The `.trivyignore` file is committed to the repository and reviewed as part of the periodic audit cycle.

**Scan cadence:** The Trivy scan runs:
- On every PR that modifies the `container/` directory
- Nightly against the currently deployed image tag (catching newly disclosed CVEs against an image already in use)
- On every deliberate base image digest update (as a gate before the digest update PR is merged)

### 3.4 Refresh Cadence

**Base image digest refresh:** The `node:22-slim` digest is refreshed on the following triggers:
1. **Node.js security release:** Whenever the Node.js project publishes a security patch release for the 22.x line. The Node.js project publishes release notes at `https://nodejs.org/en/blog/release/`. Security releases are labeled as such and typically include CVE identifiers.
2. **Nightly scan finding:** If the nightly Trivy scan reports a new HIGH or CRITICAL CVE that is fixed by a base image update, the refresh is mandatory within 72 hours of the finding.
3. **Scheduled quarterly review:** Even absent a security trigger, the base image digest is reviewed and updated (if a newer patch-level image is available) on a quarterly schedule (approximately every 90 days). This prevents the image from drifting too far behind the current patch state.

**`@anthropic-ai/claude-code` pin refresh:** The Claude Code global install pin is reviewed and updated whenever Anthropic publishes a new release. Given that this package is frequently updated, the practical cadence is monthly or on-demand when a new capability is required.

**Chromium dependency note:** The Dockerfile installs `chromium` via `apt-get`. Chromium is a frequent source of HIGH and CRITICAL CVEs. The `node:22-slim` base image does not include a Chromium security patching SLA; Chromium is pulled from the Debian/Ubuntu package repository at build time. The practical implication: the container image must be rebuilt regularly (following the digest refresh cadence above) to pick up Chromium security patches. A stale image with an unpatched Chromium is a known-bad state. Consider whether browser automation (the `agent-browser` skill) can be disabled or sandboxed further; the current design runs Chromium as the `node` user (non-root) inside the container, which provides partial isolation but does not eliminate the risk.

---

## Part 4 — Phase 2 Rust Rewrite Dependency Minimisation Objective

### 4.1 Context

Decision 7 (DECISIONS.md) commits to a Phase 2 Rust rewrite, replacing TypeScript components crate-by-crate at the Unix socket boundary. ECOSYSTEM.md cites MicroClaw (Rust workspace, small crate graph) and PicoClaw (Go, zero runtime dependencies) as comparators. F-10 of the Security Strengthening Document identifies the npm transitive dependency tree as a systemic risk, and notes that the Rust rewrite is currently motivated by performance and auditability — not by supply-chain risk reduction as a named objective.

This section makes the dependency minimisation objective explicit, concrete, and enforceable as an acceptance criterion for Phase 2.

### 4.2 Dependency Minimisation Acceptance Criterion

**AC-SC-1: Crate count ceiling**

The core binary — comprising the orchestrator, Token Broker, and Cato components — must have no more than **40 direct crate dependencies** in the workspace `Cargo.toml` files across all crates, at Phase 2 milestone completion. "Direct" means declared in a crate's `[dependencies]` section; transitive dependencies are not counted but are subject to AC-SC-3.

The ceiling of 40 is derived from MicroClaw's crate structure (six workspace crates, each with a small direct dependency set) and is calibrated to be achievable while permitting the justified use of foundational crates (async runtime, cryptography, serialisation, IPC). It is not a minimum — the goal is to come in below the ceiling, not to reach it.

**AC-SC-2: Dependency rationale document**

Each direct crate dependency must be individually justified in a dependency rationale document (`docs/security/crate-rationale.md`), maintained as source code alongside `Cargo.toml`. The document records, for each crate: the crate name and version pin, the functional category (see §4.3), the specific use case within OpenGolem, and the justification for why no existing dependency satisfies the same need. Jim approves the rationale document before Phase 2 development begins, and it is updated with each new crate addition.

A crate that appears in `Cargo.toml` without a corresponding rationale entry is a CI failure.

**AC-SC-3: Transitive dependency review**

The full transitive dependency tree is reviewed by the Supply-Chain Auditor at Phase 2 milestone completion. The review uses `cargo tree --duplicates` to identify crate version conflicts, and `cargo audit` against the RustSec advisory database to identify known CVEs. No HIGH or CRITICAL RustSec advisory is permitted in any transitive dependency at release. The transitive tree size is reported (not gated) as an informational metric.

**AC-SC-4: No npm, no Node.js**

The Phase 2 core binary has zero dependency on the Node.js runtime and zero npm packages. The host-side process surface is entirely Rust compiled binaries. This eliminates the npm supply-chain risk class from TD-ORCHESTRATOR, TD-BROKER, and TD-CATO.

**AC-SC-5: Exact version pins in Cargo.lock**

`Cargo.lock` is committed to the repository and pinned exactly (this is the Rust default for binaries). No `Cargo.lock` entry may be `*` or an unbounded range. `cargo install` is not used for dependency management. `cargo update` is a deliberate, reviewed operation, not an automated step.

**AC-SC-6: No `build.rs` scripts without review**

Crates with `build.rs` scripts execute arbitrary Rust code at compile time. Each such crate in the dependency tree must be explicitly listed in the rationale document with a note on what the build script does. A new transitive crate with a `build.rs` that is not in the rationale document is a CI warning requiring human review before the dependency is merged.

### 4.3 Acceptable Crate Categories

The following functional categories of crates are acceptable in the Phase 2 core binary. Each category is subject to the one-crate-per-function preference stated below.

| Category | Acceptable crates (examples) | Notes |
|----------|------------------------------|-------|
| Async runtime | `tokio` | One runtime only. Mixing runtimes is not permitted. |
| Serialisation | `serde`, `serde_json` | `serde` is the de facto standard; justified unconditionally. |
| Cryptography | `hmac`, `sha2`, `ring`, or `rustls` | Prefer audited crates from the `RustCrypto` or `ring` ecosystems. |
| Unix socket IPC | `tokio::net::UnixListener` (stdlib path) | Prefer stdlib/tokio primitives over additional crates. |
| SQLite | `rusqlite` | One SQLite binding only. `sqlite-vec` is an optional feature-flag addition for semantic memory. |
| Logging / tracing | `tracing`, `tracing-subscriber` | One structured logging framework. |
| JWT / token signing | `jsonwebtoken` or equivalent | One crate. Prefer a crate with a RustSec clean history. |
| HTTP client (outbound LLM proxy) | `hyper` or `reqwest` | One HTTP client crate per trust domain. `reqwest` wraps `hyper`; both are acceptable but not simultaneously. |
| CLI argument parsing | `clap` | One argument parsing crate. |
| Configuration parsing | `serde_json` (already counted) or `toml` | Configuration parsing reuses the serialisation crate where possible. |
| Regex | `regex` | One regex crate. The `RegexSet` optimisation for Call Inspector signatures is a named Phase 2 objective (Decision 2). |

### 4.4 Crates That Must Be Avoided

The following categories of crates are explicitly prohibited in the Phase 2 core binary, absent a specific ADR granting an exception:

- **Any crate that shells out to `npm`, `node`, or `npx`:** Reintroduces the npm supply-chain risk class.
- **Any crate that embeds a JavaScript runtime** (e.g., `deno_core`, `rusty_v8`): Equivalent to bundling Node.js inside the binary.
- **`openssl` system binding without a justified alternative unavailability**: Prefer `rustls` (pure Rust TLS) to avoid a C extension. If `openssl` is required by a transitive dependency, document why the dependency cannot be replaced with a `rustls`-backed alternative.
- **Any crate with an unpinned `git` dependency** in its `Cargo.toml`: Git dependencies bypass the crate registry's integrity guarantees. Exception: internal workspace crates.
- **Any crate that was last published more than 24 months before Phase 2 milestone completion**, unless it is a deliberately stable utility crate with no known CVEs and the Supply-Chain Auditor explicitly approves it in the rationale document.
- **Macro-heavy proc-macro crates with large compile-time surfaces** beyond those already justified (primarily `serde_derive`): Each proc-macro crate executes arbitrary code at compile time and increases the trusted computing base. New proc-macro dependencies require explicit rationale.

### 4.5 Channel Adapter Crates (Telegram, WhatsApp, Teams)

Channel adapter crates present the highest supply-chain risk in the Rust rewrite, mirroring F-4 of the Security Strengthening Document. Decision 30 reduces this risk by limiting the default channel set to TUI and Telegram. The following requirements apply to the Phase 2 channel crates:

**Telegram (teloxide or equivalent):** One Telegram Bot API crate. MicroClaw uses `teloxide`; this is a reasonable starting point. The crate must be verified against the RustSec advisory database at integration time. The channel adapter is compiled as a workspace crate (`opengolem-channel-telegram`) with a feature flag, not compiled into the core binary unconditionally.

**WhatsApp and Teams (optional skills):** Channel adapter crates for WhatsApp and Teams are compiled only when the corresponding feature flag is enabled. They are not in the default build target. This mirrors the Phase 1 decision to exclude Baileys from the default host manifest (Decision 30) and extends it to Phase 2. A WhatsApp Rust crate that depends on reverse-engineered protocol handling inherits the same maintenance and ToS risk as Baileys; the optional-feature-flag architecture ensures this risk is not present in the default binary.

### 4.6 Container-Side Crate Policy

The agent container in Phase 2 continues to run the Claude Agent SDK (JavaScript/TypeScript, inside the container). The container-side dependency surface is not subject to the Phase 2 Rust crate ceiling — it is governed by the container image policy (Part 3) and the container-side npm audit process. The Phase 2 objective is to eliminate the npm supply-chain risk from the **host-side** processes (TD-ORCHESTRATOR, TD-BROKER, TD-CATO), not from TD-CONTAINER.

If a future phase replaces the Claude Agent SDK with a Rust agent runner, that binary is subject to a separate dependency rationale document at that time.

### 4.7 Supply-Chain Auditor Involvement in Phase 2

The Supply-Chain Auditor is commissioned a second time at the start of Phase 2, before the Rust crate structure is finalised, as specified in TEAM.md (Stream M). The inputs for that session are: the Phase 2 crate structure draft, the dependency rationale document (`docs/security/crate-rationale.md`), and this policy document. The session produces an updated audit covering the Rust crate graph and any revisions to the policies in §4.3 and §4.4 required by the specific crates chosen. Jim approves the Phase 2 audit before the Rust crate structure is finalised.

---

*This document covers Parts 3 and 4 of the Supply-Chain Audit (Stream L). Parts 1 and 2 are in `docs/security/dependency-audit.md`.*
