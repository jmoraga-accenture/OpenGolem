# Supply-Chain Audit — Phase 2 (Rust Rewrite Readiness)
*Produced: 2026-04-07 | Auditor: Claude Code | Stream: M*
*Supersedes: supply-chain-policy.md §4 (expanded here); companion to supply-chain-audit-phase1.md*

---

## Executive Summary

This document operationalises the Phase 2 Rust rewrite supply-chain objectives first stated in `supply-chain-policy.md` Part 4 (AC-SC-1 through AC-SC-6). It provides four concrete artefacts required before and during the Rust rewrite:

1. A **dependency minimisation policy** — the justification framework and approval gate for every crate added to the workspace.
2. A **target crate dependency graph** — the identified minimal crate set for the three host-side components (Orchestrator, Token Broker, Cato), with TypeScript-to-Rust mappings and per-crate evaluations.
3. A **container image pinning and scanning policy** — enforcement mechanism, tooling specification, result retention, and HIGH/CRITICAL response process.
4. An **audit trail requirement** — what constitutes the formal crate graph acceptance criterion at Phase 2 completion and who signs off.

The Phase 2 crate structure is not yet written. This document sets the gate that the written structure must pass, and gives the Supply-Chain Auditor the pre-agreed criteria for the commissioning session described in `supply-chain-policy.md` §4.7.

---

## 1. Dependency Minimisation Policy

### 1.1 Justification Template

Every direct crate dependency in the Phase 2 workspace must have a corresponding entry in `docs/security/crate-rationale.md`. The entry is written before the crate is added to any `Cargo.toml`. A `Cargo.toml` entry without a rationale entry is a CI failure (see §4.2).

Each rationale entry must contain all of the following fields:

```
### <crate-name>

| Field            | Value |
|------------------|-------|
| Version pin      | `=X.Y.Z` (exact SemVer, no ranges) |
| Crate category   | <one of the categories in §1.4> |
| Component(s)     | <which workspace crates declare this dependency> |
| Purpose          | <one sentence: what capability this crate provides to OpenGolem> |
| Use site         | <which module(s) or function(s) call into this crate> |
| Alternatives considered | <at least one alternative evaluated and the reason it was rejected> |
| Maintenance status | Last release: <date> | crates.io recent downloads: <order of magnitude> | RustSec advisories: <count or "none"> |
| build.rs present | <yes/no — if yes, describe what the script does> |
| OpenSSL transitive | <yes/no — if yes, justify why rustls cannot replace it> |
| Approved by      | Jim (Security Reviewer) | <date> |
```

The rationale entry is **updated** when the crate's pinned version changes. The update must include: new version, date, reason for bump (security or feature), and whether any new transitive dependencies were introduced.

### 1.2 Approval Process

**New crate addition** (any crate not currently in `docs/security/crate-rationale.md`):

1. Developer drafts the rationale entry (all fields) in a feature branch.
2. The entry is submitted as part of the same PR that adds the crate to `Cargo.toml`.
3. Jim reviews as named Security Reviewer. The PR is blocked from merge until Jim's approval is recorded as a GitHub PR approval (not just a comment).
4. CI runs the crate-rationale consistency check (§4.2) — confirms every `Cargo.toml` `[dependencies]` entry has a matching rationale entry. The PR fails CI if the check fails.
5. After merge, the Supply-Chain Auditor is notified (via a note in the PR linking this document) if the addition brings the workspace over 30 direct crates — the crate ceiling warning threshold before the hard ceiling of 40 (AC-SC-1).

**Version bump of an existing crate:**

A version bump of an existing crate (patch or minor) follows the same trigger class logic as the npm policy in `supply-chain-policy.md` §2.3 — Class A (security, mandatory within 72 hours) and Class B (patch, on-demand). A bump requires the rationale entry to be updated but does not require full re-approval if no new transitive dependencies are introduced. Jim's explicit approval is required for any bump that introduces new transitive dependencies or changes a crate's `build.rs` behaviour.

**No crate added by automated tooling without human review.** `cargo update` is always a deliberate PR, not an automated commit.

### 1.3 Banned Categories

The following categories of crates are prohibited in the Phase 2 host-side workspace without a specific ADR granting an exception. These extend and make precise the list in `supply-chain-policy.md` §4.4:

| Category | Reason |
|----------|--------|
| Any crate that depends on `openssl-sys` when a `rustls`-backed alternative exists | Reintroduces a C extension into the trust boundary; the alternative is a deliberate architectural choice (pure-Rust TLS stack) |
| Any crate that shells out to `npm`, `node`, or `npx` | Reintroduces the npm supply-chain risk class into TD-ORCHESTRATOR, TD-BROKER, or TD-CATO |
| Any crate embedding a JavaScript or Lua runtime (`rusty_v8`, `deno_core`, `rlua`, etc.) | Equivalent to bundling a language runtime; incompatible with AC-SC-4 |
| Any crate with an unpinned `git` dependency in its own `Cargo.toml` | Bypasses registry integrity guarantees |
| Any proc-macro crate beyond those already listed in the rationale document | Each proc-macro executes arbitrary code at compile time; increments the trusted computing base. `serde_derive` and `tokio::macro` are pre-approved (see §2); any additional proc-macro requires explicit rationale |
| Any crate last published more than 24 months before Phase 2 milestone completion | Signals unmaintained state; a deliberate stable-utility exception requires Supply-Chain Auditor written approval in the rationale document |
| Any crate whose primary purpose is wrapping another language's FFI bindings (other than `rusqlite` for SQLite) | FFI surfaces are high-risk; each one requires explicit ADR |

### 1.4 Acceptable Crate Categories

These functional categories are acceptable. The one-crate-per-function preference from `supply-chain-policy.md` §4.3 applies within each category.

| Category | Accepted crate(s) | Notes |
|----------|------------------|-------|
| Async runtime | `tokio` | One runtime only. Mixing `async-std` or `smol` is prohibited. |
| Serialisation | `serde`, `serde_json` | Pre-approved unconditionally; `serde_derive` proc-macro included. |
| Cryptography | `hmac`, `sha2`, `ring`, `rustls` | Prefer RustCrypto suite or `ring`. No `openssl` unless no alternative. |
| Unix socket IPC | (tokio built-in — `tokio::net::UnixListener`) | No additional crate needed for Unix socket primitives. |
| SQLite | `rusqlite` | One SQLite binding. `sqlite-vec` permitted as optional feature. |
| Logging / tracing | `tracing`, `tracing-subscriber` | One structured logging framework. |
| JWT / token signing | `jsonwebtoken` | One crate. Verify RustSec clean history before pinning. |
| HTTP client | `hyper` or `reqwest` | One HTTP client per trust domain. Not both simultaneously. |
| CLI argument parsing | `clap` | One parsing crate. |
| Configuration parsing | `toml` | Reuse `serde_json` for JSON config; `toml` only if TOML config format is adopted. |
| Regex | `regex` | One regex crate. `RegexSet` for Call Inspector signature matching (Decision 2). |
| Channel adapter — Telegram | `teloxide` | Feature-flagged workspace crate only; not compiled into core binary unconditionally. |

### 1.5 Exception Process

A crate that would be rejected by the rules in §1.3 may be admitted via a formal ADR:

1. Developer writes an ADR in `docs/DECISIONS.md` with: the crate name, the policy rule being excepted, the technical justification for why the banned category cannot be avoided, the mitigating controls applied, and the expiry condition (when the exception can be closed, e.g. "when a pure-Rust alternative is stable").
2. Jim approves the ADR.
3. The Supply-Chain Auditor reviews the exception at the next commissioned session.
4. The exception crate's rationale entry must reference the ADR number.

No exception may be granted for crates in the `npm`/`node` shelling category (the Phase 2 objective is elimination of npm from the host side, not its partial retention).

---

## 2. Target Crate Dependency Graph

### 2.1 Scope and Target

Three host-side components are in scope: **Orchestrator** (TD-ORCHESTRATOR), **Token Broker** (TD-BROKER), and **Cato** (TD-CATO). The agent container (TD-CONTAINER) retains its Node.js/npm stack and is out of scope for this crate graph.

**Target:** ≤8 direct crate dependencies per component. Shared workspace crates (e.g. a common `opengolem-types` crate for IPC message types) count as internal workspace crates, not external crate dependencies.

### 2.2 TypeScript-to-Rust Dependency Mapping

The following table maps every current TypeScript production dependency and key Node.js built-in usage to its Rust equivalent or justifies elimination.

| TypeScript Dependency / Node.js Built-in | Current Use in OpenGolem | Rust Equivalent | Disposition |
|------------------------------------------|--------------------------|-----------------|-------------|
| `better-sqlite3` | SQLite for audit log, group databases, memory tiers (Tier 2 episodic, Tier 3 strategic) | `rusqlite` | **Replace with `rusqlite`**. Pure-Rust binding to libsqlite3. Mature, widely used, WAL-mode support. Alternative considered: `sqlx` with SQLite feature. `sqlx` provides async queries but adds `tokio` runtime coupling at the query layer and proc-macro overhead (`sqlx::query!`). `rusqlite` is synchronous and wrapped in `spawn_blocking` inside Tokio; this is architecturally cleaner for a write-ahead-log SQLite pattern. |
| `cron-parser` | Parse cron expressions in `task-scheduler.ts` | `cron` (crates.io) or `croner` | **Replace with `croner`**. The `croner` crate is actively maintained, supports standard cron syntax, and has no transitive dependencies. Alternative: `tokio-cron-scheduler` — this adds a full scheduler abstraction on top, which is more than needed if the orchestrator manages its own task loop. Prefer the parser primitive over a full scheduler crate. |
| `grammy` (Telegram Bot API adapter) | Telegram channel adapter in TD-ORCHESTRATOR | `teloxide` | **Replace with `teloxide`** in a feature-flagged channel workspace crate (`opengolem-channel-telegram`). Not compiled into core binary unless the Telegram feature flag is enabled. `teloxide` is the most actively maintained Telegram Bot API crate for Rust; MicroClaw uses it as a comparator. Note: `teloxide` transitively pulls in `reqwest` — this is the HTTP client for the Telegram channel; acceptable when the channel feature is enabled. |
| `node:crypto` (HMAC, SHA-256) | Token signing in Token Broker; audit log HMAC chain (F-3) | `hmac` + `sha2` (RustCrypto suite) | **Replace with `hmac` + `sha2`**. Both are from the RustCrypto project — audited, pure Rust, no C dependencies, used in production by major Rust projects. Alternative: `ring` for a single-crate cryptography dependency. `ring` is an option if a single crate is preferred over two small RustCrypto crates; both are acceptable under §1.4. |
| `node:net` / Unix domain sockets | IPC between Orchestrator, Token Broker, and Cato | `tokio::net::UnixListener` / `tokio::net::UnixStream` | **No additional crate required.** Tokio provides Unix socket primitives in its standard distribution. This eliminates a dependency that would exist in npm (where `net` is Node.js built-in but the async framing requires libraries). |
| JSON-RPC 2.0 framing (hand-rolled in `src/broker/index.ts`) | Token Broker JSON-RPC 2.0 protocol over Unix socket | Hand-rolled over `serde_json` | **Retain hand-rolled implementation.** The JSON-RPC surface is small (four methods: `issueToken`, `revokeToken`, `proxyCall`, `catoEscalate`). A dedicated `jsonrpc-core` crate adds ~6 transitive dependencies for a protocol that fits in ~200 lines. `serde_json` is already justified; the JSON-RPC framing is built on top of it with no additional crate. |
| `node:http` (credential proxy HTTP server) | Token Broker HTTP server accepting calls from TD-CONTAINER | `hyper` (server mode) | **Replace with `hyper`**. The credential proxy is a minimal HTTP/1.1 server on the Docker bridge interface. `hyper` is the lowest-level production HTTP crate in the Rust ecosystem and has no TLS requirement for the internal proxy (plaintext on the Docker bridge, consistent with current architecture). Alternative: `axum` — this is a higher-level framework wrapping `hyper`, adding routing and middleware. `axum` is appropriate if the proxy surface grows; for the current four-endpoint proxy, raw `hyper` is preferred to minimise the crate graph. |
| `node:fs`, `node:path` | Filesystem operations (group config, audit log, mounts) | Rust stdlib (`std::fs`, `std::path`) | **No additional crate required.** Rust's standard library covers all current filesystem operations. |
| `node:process`, `node:os` | Process management, signal handling | Rust stdlib + `tokio::signal` | **No additional crate required for signals.** `tokio::signal` (part of the tokio crate already counted) handles SIGTERM/SIGHUP. |
| `node:child_process` (container spawn in `container-runner.ts`) | Spawning Docker container processes | Rust stdlib `std::process::Command` wrapped in `tokio::process` | **No additional crate required.** `tokio::process::Command` (part of the tokio crate) replaces `child_process.spawn`. |
| Structured logging (`console.log` + pino-style JSON in current impl) | Audit log entries, operator logs | `tracing` + `tracing-subscriber` | **Replace with `tracing` + `tracing-subscriber`**. The de facto standard for structured async Rust logging. `tracing-subscriber` provides JSON formatting natively. |
| TypeScript type system | Type safety, schema validation (Zod is container-side only) | Rust type system + `serde` | **Rust type system replaces runtime validation for host-side types.** No additional validation crate needed for IPC message types — `serde` deserialization with `#[serde(deny_unknown_fields)]` replaces Zod for the broker and orchestrator protocol types. |

### 2.3 Per-Component Crate Lists

The following lists represent the *target* direct crate dependencies per component, to be validated against the actual `Cargo.toml` files when the Rust workspace is initialised.

#### Orchestrator (`opengolem-orchestrator`)

| Crate | Version Constraint | Purpose | Maintenance (as of 2026-04) | Alternative Considered |
|-------|--------------------|---------|------------------------------|------------------------|
| `tokio` | `=1.x` (latest stable 1.x at pin time) | Async runtime, Unix socket client/listener, process spawn, signal handling | Active; Tokio team; >10M weekly downloads | `async-std` — rejected; one runtime rule |
| `serde` + `serde_json` | exact | IPC message serialisation/deserialisation, config file parsing | Active; Yserde team; >50M weekly downloads | None; pre-approved |
| `tracing` + `tracing-subscriber` | exact | Structured operator logging with JSON output | Active; Tokio team; >5M weekly downloads | `log` crate — rejected; less structured |
| `rusqlite` | exact | Audit log and group database writes | Active; maintained, >300K weekly downloads; no RustSec advisories | `sqlx` — considered; rejected (see §2.2) |
| `regex` | exact | Call Inspector prompt-injection signature matching (`RegexSet`) — orchestrator hosts the inspector relay | Active; regex-automata backend; >10M weekly downloads | `fancy-regex` — rejected; adds backtracking, wider surface |

**Component total: 7 direct crates** (counting `serde` and `serde_json` as one entry; `tracing` and `tracing-subscriber` as one entry). Within the ≤8 target.

#### Token Broker (`opengolem-broker`)

| Crate | Version Constraint | Purpose | Maintenance (as of 2026-04) | Alternative Considered |
|-------|--------------------|---------|------------------------------|------------------------|
| `tokio` | `=1.x` | Async runtime, Unix socket server (IPC with orchestrator), HTTP server task scheduling | Active; see above | — |
| `serde` + `serde_json` | exact | JSON-RPC 2.0 message framing, token claim serialisation | Active; see above | — |
| `hyper` | `=1.x` (latest stable 1.x) | HTTP/1.1 server for credential proxy (Docker bridge interface) | Active; hyper team; >5M weekly downloads | `axum` — considered; rejected (see §2.2) |
| `hmac` + `sha2` | exact (RustCrypto) | Token HMAC signing and audit log integrity chain (F-3) | Active; RustCrypto org; >2M weekly downloads each; no RustSec advisories | `ring` — viable alternative; `ring` is a single crate but is larger; RustCrypto primitives preferred for auditability |
| `tracing` + `tracing-subscriber` | exact | Structured logging for token events and call decisions | Active; see above | — |
| `rusqlite` | exact | Audit log writes (broker-side token events) | Active; see above | — |
| `jsonwebtoken` | exact | Signed derivative token issuance and validation | Active; Keats; >1M weekly downloads; RustSec — check at pin time | `biscuit-auth` — richer capability model but adds significant complexity; JWT is sufficient for the current token claims |

**Component total: 8 direct crates** (with same counting as above). At the ≤8 target.

#### Cato (`opengolem-cato`)

| Crate | Version Constraint | Purpose | Maintenance (as of 2026-04) | Alternative Considered |
|-------|--------------------|---------|------------------------------|------------------------|
| `tokio` | `=1.x` | Async runtime, Unix socket server (IPC with orchestrator), scheduled audit timer | Active; see above | — |
| `serde` + `serde_json` | exact | Inline check request/response serialisation | Active; see above | — |
| `tracing` + `tracing-subscriber` | exact | Structured logging for check decisions and scheduled audit events | Active; see above | — |
| `rusqlite` | exact | Read-only access to audit log (scheduled deep audit); writes to dao_score database | Active; see above | — |
| `regex` | exact | Deterministic symbolic checks (path traversal patterns, payload signatures) | Active; see above | — |

**Component total: 6 direct crates.** Well within the ≤8 target.

### 2.4 Workspace Total

With shared crates (`tokio`, `serde`/`serde_json`, `tracing`/`tracing-subscriber`, `rusqlite`, `regex`) counted once at the workspace level:

| Crate | Used by |
|-------|---------|
| `tokio` | Orchestrator, Broker, Cato |
| `serde` | Orchestrator, Broker, Cato |
| `serde_json` | Orchestrator, Broker, Cato |
| `tracing` | Orchestrator, Broker, Cato |
| `tracing-subscriber` | Orchestrator, Broker, Cato |
| `rusqlite` | Orchestrator, Broker, Cato |
| `hyper` | Broker only |
| `hmac` | Broker only |
| `sha2` | Broker only |
| `jsonwebtoken` | Broker only |
| `regex` | Orchestrator, Cato |
| `croner` | Orchestrator (task scheduler) |
| `teloxide` | Channel crate — feature-flagged, not in core workspace total |

**Total direct workspace crates (core binary, excluding channel adapters): 12.**

This is well within the AC-SC-1 ceiling of 40. The channel adapter crates (`teloxide` and any future adapters) are conditionally compiled via feature flags and are counted separately when each channel is enabled.

### 2.5 Crates Explicitly Not Added

The following crates were considered and rejected for the target graph:

| Crate | Reason for Rejection |
|-------|---------------------|
| `sqlx` | Async query proc-macros add compile-time complexity; `rusqlite` + `spawn_blocking` is sufficient and simpler |
| `axum` | Higher-level abstraction than needed for a four-endpoint internal proxy |
| `reqwest` | HTTP client functionality needed only in the Telegram channel adapter (via `teloxide`); not needed in core binary |
| `ring` | RustCrypto primitives (`hmac` + `sha2`) preferred for smaller surface and easier per-crate auditability |
| `jsonrpc-core` | JSON-RPC protocol surface is small enough to hand-roll over `serde_json` |
| `clap` | No CLI interface on the long-lived host processes (they are daemon processes); no need for argument parsing |
| `openssl` | Pure-Rust alternatives exist for all required cryptographic operations |
| `tokio-cron-scheduler` | Full scheduler abstraction over-engineered for cron expression parsing; `croner` provides the primitive |

---

## 3. Container Image Pinning and Scanning Policy

This section consolidates and extends the container policy in `supply-chain-policy.md` §§3.2–3.4 with enforcement mechanisms, tooling specification, result retention, and HIGH/CRITICAL response process.

### 3.1 Base Image Pinning — Enforcement Mechanism

**Requirement:** The Dockerfile `FROM` line must reference the base image by SHA-256 digest. Tag-only references are rejected.

**CI enforcement:** A lint step runs on every PR and push to `main` that touches `container/`:

```bash
grep -E '^FROM\s+\S+@sha256:[a-f0-9]{64}' container/Dockerfile \
  || { echo "ERROR: Dockerfile FROM must include @sha256: digest pin"; exit 1; }
```

This single-line check requires no additional tooling. It runs before the build step and fails fast.

**Pre-commit hook (defence in depth):** The same grep is added to the pre-commit hook managed by `husky`. This catches the regression before a PR is created.

**How to update the pin:**
```bash
# Get the current digest without pulling:
docker buildx imagetools inspect node:22-slim \
  --format '{{json .Manifest}}' | jq -r '.digest'

# Verify the retrieved digest resolves to the expected image:
docker pull node:22-slim@sha256:<digest>
docker inspect node:22-slim@sha256:<digest> --format '{{.Os}}/{{.Architecture}}'
```

The digest update is a deliberate PR. It must pass the Trivy scan gate (§3.3) before merge.

**Scope of the pinning requirement:** The `FROM` line is the only point where the base image is specified. All subsequent `RUN apt-get install` and `RUN npm install -g` steps use exact version pins as already implemented (see `supply-chain-audit-phase1.md` §3.1).

### 3.2 Scan Trigger

Trivy scanning runs on the following events:

| Trigger | Scope | Blocking |
|---------|-------|---------|
| PR modifying any file under `container/` | Full image scan of the built image | Yes — PR cannot merge on CRITICAL or HIGH |
| Every execution of `./container/build.sh` | Full image scan of the built image | Yes — build script exits non-zero on CRITICAL or HIGH |
| Nightly CI job against the deployed image tag | Full image scan | No (informational) — but HIGH or CRITICAL finding creates a GitHub issue with `security` label, assigned to Jim, due within 72 hours |
| Deliberate base image digest update PR | Full image scan | Yes — the PR is the upgrade gate |

**Integration into `./container/build.sh`:** The build script is extended to run Trivy immediately after `docker build` completes:

```bash
docker build -t opengolem-agent:latest .
trivy image \
  --exit-code 1 \
  --severity CRITICAL,HIGH \
  --ignorefile .trivyignore \
  --format table \
  opengolem-agent:latest
```

A non-zero exit from `trivy image` causes the build script to exit non-zero. The container image is produced but must not be used until the finding is resolved or suppressed.

### 3.3 Scanning Tool and Threshold

**Scanning tool:** [Trivy](https://github.com/aquasecurity/trivy) (Aqua Security, open source, Apache 2.0).

Rationale for Trivy over alternatives:
- **vs. `grype`:** Both tools are capable. Trivy is chosen because it was established as the tool in `supply-chain-policy.md` §3.3, creating consistency. Trivy covers OS packages, language-layer packages (npm, pip, Go modules, Rust crates), and IaC files in a single scan.
- **vs. `docker scout`:** Docker Scout requires Docker Hub account integration; Trivy is fully offline-capable with a local vulnerability database. Offline capability is preferred for a self-hosted deployment.
- **vs. Snyk CLI:** Snyk is a SaaS product requiring network access for scanning. Trivy's offline mode is preferred.

**Minimum threshold:** `CRITICAL` and `HIGH` findings cause CI failure (exit code 1). `MEDIUM` findings are logged but not blocking. `LOW` and `INFORMATIONAL` findings are not reported by default (use `--severity CRITICAL,HIGH,MEDIUM` for audit sessions).

**Vulnerability database:** Trivy downloads the vulnerability database on first run and caches it. CI must run `trivy image --download-db-only` as a preparatory step (cached between runs) to ensure the database is current before each scan.

**Rust-layer scanning:** Once the Phase 2 Rust binary is compiled into the container (if applicable), Trivy's `--scanners vuln` mode covers Cargo.lock via the OSV/RustSec database. This supplements `cargo audit` (§4.1) rather than replacing it.

### 3.4 Scan Result Retention

Scan results are stored in `docs/security/container-scans/`. The directory is committed to the repository.

**File naming convention:**
```
docs/security/container-scans/<ISO8601-date>-<trigger>-<image-digest-prefix>.txt
```
Examples:
```
docs/security/container-scans/2026-04-07-build-80fdb3f5.txt
docs/security/container-scans/2026-04-07-nightly-80fdb3f5.txt
```

**Format:** Plain text Trivy table output (`--format table`). JSON output is additionally stored as `<same-stem>.json` for machine-readable archive.

**Retention period:** All scan result files are retained indefinitely in the repository. There is no automated deletion. Results constitute part of the audit trail required by §4.

**`.gitignore` exclusion:** `docs/security/container-scans/` must not be in `.gitignore`.

### 3.5 HIGH/CRITICAL Finding Response Process

When a HIGH or CRITICAL finding is reported by Trivy (at any trigger — build, PR, or nightly):

**Step 1 — Triage (within 24 hours of discovery):**
- Identify the affected package, the CVE identifier, and the fix availability.
- Determine the exposure: is the vulnerable package reachable from the attack surface (i.e., is it a code path exercised by the container at runtime)?
- Record the triage decision in a GitHub issue tagged `security` and `trivy`.

**Step 2 — Remediation options (in priority order):**

a. **Patch available in base image:** Update the base image digest to a version that includes the fix. Run the full scan gate on the updated digest. Merge when clean.

b. **Patch available as `apt` package but not in base image:** Add a `RUN apt-get install --only-upgrade <package>=<fixed-version>` step to the Dockerfile. This is a temporary measure; the base image digest update is still required.

c. **No patch available — risk acceptance:** If no fix exists and the CVE is not exploitable in the OpenGolem deployment context (e.g., a Chromium CVE that requires renderer sandbox escape, and the container does not run an interactive renderer session), the finding may be suppressed via `.trivyignore`. The suppression entry must include:
   ```
   # CVE-YYYY-NNNNN | Suppressed: <ISO date> | Expires: <ISO date, max 90 days>
   # Justification: <why this CVE is not exploitable in this deployment context>
   # Approver: Jim
   CVE-YYYY-NNNNN
   ```
   Suppressions expire after 90 days maximum. At expiry, the CVE is re-evaluated — either a patch is available, or the suppression is renewed with an updated justification.

**Step 3 — Block deployment:**
No container image with an unresolved CRITICAL or HIGH finding is deployed or used for agent task execution. The orchestrator must not be started with a container image that has not passed the Trivy gate in its most recent build. If a nightly scan finds a new finding against an already-deployed image, the image is considered unsafe and must be rebuilt (triggering the remediation steps above) before the next container spawn.

---

## 4. Audit Trail Requirement

### 4.1 What "Crate Graph at Completion" Means

The Phase 2 Rust rewrite is not complete until all three of the following artefacts exist, are current, and are consistent with each other:

**A. `Cargo.lock` (lock file)**
The committed `Cargo.lock` at the Phase 2 completion commit records the exact resolved version of every direct and transitive crate dependency. This is the ground truth of what was compiled. It must:
- Be committed to the repository (not in `.gitignore`).
- Reflect the state of the workspace at the completion commit — no stale entries.
- Contain no `*` version resolutions or `git` source entries (except internal workspace crates).

**B. `docs/security/crate-rationale.md` (rationale document)**
The rationale document records the human justification for every direct crate dependency. It must:
- Have one entry per direct crate in the workspace `Cargo.toml` files (across all workspace members).
- Be consistent with `Cargo.lock` — every crate in the rationale document must appear in the lock file, and every direct crate in the lock file must appear in the rationale document.
- Have Jim's approval recorded (field: `Approved by`) for each entry.

**C. Phase 2 Supply-Chain Audit Report**
The Supply-Chain Auditor (as specified in `supply-chain-policy.md` §4.7) produces a formal audit report at Phase 2 milestone completion. The report:
- Runs `cargo audit` against the RustSec advisory database and records the output.
- Runs `cargo tree --duplicates` and documents any version conflicts.
- Confirms that every direct crate passes the crate category and banned-category rules in §1.3 and §1.4.
- Confirms that the workspace crate count is within the AC-SC-1 ceiling.
- Confirms that all `build.rs`-bearing crates are documented in the rationale document.
- Records the final scan result from `./container/build.sh` (Trivy output, §3.4).
- Issues a formal sign-off statement (see §4.3).

The Phase 2 completion commit is not considered accepted until all three artefacts are present and consistent.

### 4.2 CI Consistency Check

A CI step enforces the rationale-document/lock-file consistency requirement automatically:

```bash
# Pseudo-code for the crate-rationale consistency check:
# 1. Extract all [dependencies] entries from workspace Cargo.toml files.
# 2. Extract all crate names from docs/security/crate-rationale.md (## headings).
# 3. Fail if any Cargo.toml [dependencies] entry has no matching heading.
# 4. Fail if any rationale heading has no matching Cargo.toml [dependencies] entry.
```

The implementation may be a short Rust or shell script committed to `scripts/check-crate-rationale.sh`. It runs on every PR that modifies any `Cargo.toml` or `docs/security/crate-rationale.md`.

### 4.3 Sign-Off (Security Reviewer Role)

The **Security Reviewer** for the Phase 2 crate graph acceptance is **Jim**.

Sign-off is a formal statement recorded in the Phase 2 Supply-Chain Audit Report:

```
I, Jim, as Security Reviewer, confirm that:
1. The committed Cargo.lock reflects the workspace state at Phase 2 completion.
2. Every direct crate dependency has an approved entry in docs/security/crate-rationale.md.
3. The Supply-Chain Auditor's Phase 2 report has been reviewed and its findings addressed.
4. No HIGH or CRITICAL RustSec advisories are present in any transitive dependency at this date.
5. The container image in use has passed the Trivy scan gate with no unresolved HIGH or CRITICAL findings.

Sign-off date: <ISO date>
Cargo.lock SHA-256: <hash of Cargo.lock at completion commit>
```

The sign-off statement is embedded in the Phase 2 Supply-Chain Audit Report, not in a separate file.

### 4.4 Storage Location

The Phase 2 crate graph artefacts are stored as follows:

| Artefact | Location | Committed |
|----------|----------|-----------|
| `Cargo.lock` | Repository root or workspace root | Yes |
| `docs/security/crate-rationale.md` | `docs/security/` | Yes |
| Phase 2 Supply-Chain Audit Report | `docs/security/supply-chain-audit-phase2-completion.md` | Yes |
| Container scan results at completion | `docs/security/container-scans/<date>-phase2-completion*.txt` | Yes |

The Phase 2 completion audit report is a separate document from this one. This document (`supply-chain-audit-phase2.md`) defines the requirements; the completion report records the evidence that those requirements were met.

---

## 5. Relationship to Existing Documents

| Document | Relationship |
|----------|-------------|
| `supply-chain-audit-phase1.md` | Phase 1 baseline; findings SC-1 through SC-7 are the npm and container findings from the current TypeScript stack. This document does not reopen or modify those findings. |
| `supply-chain-policy.md` §4 | This document operationalises §4. The acceptance criteria AC-SC-1 through AC-SC-6 remain the normative reference; §1 and §2 of this document add the justification template, approval process, and target crate graph that §4 specifies should exist. |
| `supply-chain-policy.md` §3 | This document extends §3 with the trigger table, response process, and retention format. §3 remains the normative container policy; this document is the procedural detail. |
| `docs/security/crate-rationale.md` | Does not yet exist. Created at Phase 2 workspace initialisation. This document defines its required structure. |
| `docs/DECISIONS.md` Decision 7 | The ADR committing to the Phase 2 Rust rewrite. This document's policies are scoped to that decision's delivery. |
| `docs/DECISIONS.md` AC-SC-1 through AC-SC-6 | The acceptance criteria in `supply-chain-policy.md` §4.2. This document provides the procedural implementation of those criteria. |
| `docs/PM_BRIEF.md` Stream M | M33 is this document. The Supply-Chain Auditor commissioning session for Phase 2 is Stream M milestone M33. |

---

*This document governs the supply-chain requirements for the Phase 2 Rust rewrite. It becomes active when the Phase 2 Rust workspace is initialised. Policies in §1–§4 must be satisfied before the Phase 2 milestone is accepted. The container image policies in §3 apply immediately to the current Phase 1 container, not only at Phase 2.*

*Findings are closed when the corresponding CI check is implemented and passing, or when the corresponding rationale document entry is approved. Findings must not be closed by declaration.*
