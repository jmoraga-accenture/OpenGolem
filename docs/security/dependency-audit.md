*Status: Approved | Produced: 2026-04-06*

# OpenGolem — Dependency Audit Report
*Supply-Chain Auditor session | Stream L — Phase 1 | Inputs: package.json, package-lock.json, docs/sec/security-strengthening.md F-10, docs/DECISIONS.md Decisions 28 and 30, docs/ECOSYSTEM.md, docs/ARCHITECTURE.md*

---

## Scope

This report covers the direct runtime dependencies declared in `package.json` (production `dependencies` block only), their immediate transitive children as recorded in `package-lock.json`, and the development dependencies insofar as they present CI-time supply-chain risk. The container-side dependency manifest (`container/agent-runner/package.json`) is noted in context but is audited separately from the host-side manifest; see the container image policy in `supply-chain-policy.md`.

The audit is grounded in finding F-10 of the Security Strengthening Document (`docs/sec/security-strengthening.md`), which identifies the npm transitive dependency tree as an unaddressed systemic risk: a compromised package anywhere in the graph executes within TD-ORCHESTRATOR with full access to the in-memory token store, Unix sockets, and the group filesystem.

The three direct production dependencies are: `better-sqlite3` (11.10.0), `cron-parser` (5.5.0), and `grammy` (^1.39.3, resolved 1.41.1). No Baileys or WhatsApp-specific package is present in the host-side manifest. Decision 30 confirms that WhatsApp via Baileys is an optional skill, not a v1.0 default — this is architecturally correct from a supply-chain perspective and is noted as a positive finding.

---

## Part 1 — Dependency Audit

### 1.1 better-sqlite3 (11.10.0)

**Risk surface:**
- Native C extension (`.node` binary, compiled via node-gyp or downloaded via `prebuild-install`)
- Filesystem access: writes to and reads from the group SQLite databases and the audit log — the highest-privilege persistent write surface in TD-ORCHESTRATOR
- Parsing untrusted input: SQL queries are application-generated (not user-injected in the current codebase), but the library parses binary SQLite file formats from disk

**Privilege level:** TD-ORCHESTRATOR (host process). This is the highest-privilege write surface in the system: better-sqlite3 writes to the audit log, the group `messages.db` databases, and the Tier 2 session/task tables. A compromise of this package could silently corrupt or suppress audit log entries — undermining Cato's governance inputs as identified in F-3 of the Security Strengthening Document.

**Native binding mechanism:** The package uses `prebuild-install` to download a prebuilt `.node` binary from GitHub releases at `npm install` time. If a prebuilt is unavailable for the platform, it falls back to compiling from source via node-gyp. The download URL is derived from `github-from-package` (a transitive dependency), which reads the GitHub repository from `package.json`'s `repository` field. This introduces a dependency on the integrity of the GitHub release asset as well as on the npm registry entry.

**Transitive dependency chain of note:**
`better-sqlite3` → `prebuild-install` → `rc` (reads ini-style config from `~/.npmrc` and environment, a historically misused package), `simple-get` (HTTP downloader, network I/O), `tunnel-agent` (HTTP CONNECT proxy support), `tar-fs` (archive extraction), `minimist` (argument parser, historically subject to prototype-pollution CVEs)

The `rc` package is particularly notable: it reads configuration from multiple sources including `~/.npmrc`, `$HOME/.config/{name}`, and environment variables. While this is benign in the `prebuild-install` context (it reads configuration for the download URL), the package's broad config-reading behavior has been a source of confusion and past security advisories. The `minimist` package (prototype-pollution CVE-2021-44906, patched in 1.2.6) is present in this chain; the lockfile must be verified to confirm a non-vulnerable version is resolved.

**Maintenance signal:** `better-sqlite3` is actively maintained by William Turing / Joshua Wise with regular releases. Version 11.x is the current stable series. No known CVEs at the time of this audit. The package is widely used (millions of weekly downloads) and has a strong maintenance track record. The native binary download model is standard for this category of package.

**Verdict:** **MEDIUM risk.** The native C extension and prebuilt binary download model are the primary concerns — not the library itself, which is well-maintained, but the installation-time network fetch from GitHub. The highest-privilege write surface position (audit log and group databases) means any compromise would be high-consequence. Mitigated in part by the exact version pin (`11.10.0`, not a range) in `package.json`. The `minimist` transitive dependency warrants version confirmation.

**Recommended action:** Verify `minimist` is resolved at >=1.2.6 in `package-lock.json`. Consider adding a Subresource Integrity check or hash verification step for the prebuilt binary download in the CI pipeline. The exact pin (`11.10.0`) is correct and must be maintained — do not relax to a range.

---

### 1.2 cron-parser (5.5.0)

**Risk surface:**
- Parsing untrusted input: cron expression strings (sourced from application configuration, not direct user input in the current codebase)
- No network I/O, no filesystem access, no native bindings

**Privilege level:** TD-ORCHESTRATOR (host process). Used by the task scheduler to parse cron expressions from group configuration.

**Transitive dependency chain:** `cron-parser` → `luxon` (date/time library, pure JavaScript, no native bindings, widely used and maintained). Transitive graph is shallow (one level) and low-risk.

**Maintenance signal:** `cron-parser` is actively maintained. Version 5.x is current. No known CVEs. `luxon` is a well-maintained successor to Moment.js, authored by Isaac Cambron, with consistent releases and no known security issues.

**Verdict:** **LOW risk.** Pure JavaScript, shallow transitive graph, no elevated-privilege surfaces. Cron expression parsing from application-controlled config is not a meaningful attack surface.

---

### 1.3 grammy (^1.39.3, resolved 1.41.1)

**Risk surface:**
- Network I/O: makes outbound HTTPS calls to the Telegram Bot API (polling and webhook delivery)
- Parsing untrusted input: Telegram API responses are JSON from an external provider — partially untrusted (the provider is trusted, but the content of messages is user-controlled)
- No native bindings, no filesystem access

**Privilege level:** TD-ORCHESTRATOR (host process, in-process channel adapter). Per F-4 of the Security Strengthening Document, an in-process channel adapter with orchestrator-level access is the primary supply-chain risk surface. Grammy runs inside TD-ORCHESTRATOR and has access to the same memory space as the token store and Unix sockets.

**Transitive dependency chain:**
`grammy` → `@grammyjs/types` (pure TypeScript type definitions, no runtime risk), `abort-controller` (web standard polyfill, minimal), `debug` (logging utility, widely used), `node-fetch` (^2.7.0, HTTP client)

`node-fetch` v2 is a well-known package but is in maintenance mode — the active development line is v3 (ESM-only). The v2 branch receives security patches but not feature development. This is not immediately alarming but is a maintenance-signal concern: a project that depends on a maintenance-mode HTTP client library is one release cycle away from unpatched CVEs if the maintainers deprioritise v2.

**Maintenance signal:** Grammy itself is actively maintained by KnorpelSenf and contributors, with regular releases tracking Telegram Bot API updates. Version 1.41.1 (resolved) is current as of the audit date. The project has a healthy release cadence and active community. No known CVEs at the time of audit.

The `^1.39.3` range (not an exact pin) means CI will resolve the latest 1.x release. This is lower-risk for grammy than for a native-binding package because grammy has no install-time scripts and no binary fetching, but a compromised grammy release would be fetched automatically on the next `npm install`.

**Version range concern:** The caret range (`^1.39.3`) is appropriate for a pure-JavaScript package with a healthy maintenance record, but Decision 30 establishes Telegram as one of only two default channels. The channel adapter has TD-ORCHESTRATOR-level privilege and directly handles all user-submitted message content before any Call Inspector checks can be applied. The supply-chain risk of a compromised grammy release is therefore material.

**Verdict:** **MEDIUM risk.** Well-maintained library with a clean transitive graph. The primary concerns are: (1) in-process TD-ORCHESTRATOR privilege per F-4; (2) the `^` version range means auto-update on install with no human review gate; (3) `node-fetch` v2 maintenance-mode dependency. Risk is bounded by the fact that Telegram only carries inbound message content (not credentials) and that grammy has a strong maintenance track record.

**Recommended action:** ~~Consider pinning grammy to an exact version~~ **Done — `package.json` pinned to `1.41.1` (exact).** Monitor `node-fetch` v2 for security advisories and evaluate migration to grammy's native fetch support when upgrading (grammy v2+ supports Node.js native fetch, eliminating the `node-fetch` dependency). Future grammy updates follow Class B/C trigger policy (§2.5).

---

### 1.4 Notable Absences

**Baileys / @whiskeysockets/baileys:** Not present in the host-side `package.json` or `package-lock.json`. Decision 30 correctly relegates WhatsApp to an optional skill. This is the correct supply-chain posture: Baileys is poorly maintained relative to its complexity (reverse-engineered WhatsApp protocol, large transitive graph, account-suspension risk under Meta ToS), and its exclusion from the default host-side dependency tree is a meaningful risk reduction.

**@anthropic-ai/claude-code, @anthropic-ai/sdk, @anthropic-ai/claude-agent-sdk:** Not present in the host-side `package.json`. These credential-adjacent packages are confined to TD-CONTAINER (the agent container image, `container/agent-runner/package.json`). This is architecturally correct: the host process never imports the Claude SDK directly and therefore has no npm-level exposure to Anthropic SDK supply-chain risk. The credential proxy model means the host never holds raw API credentials in a form that a compromised npm package could extract by reading `process.env` at module load time.

---

### 1.5 Development Dependencies — CI Risk Assessment

Development dependencies run in CI pipelines and on developer machines. They do not run in production. The risk profile is lower but not zero — a compromised devDep with a `postinstall` script runs at `npm install` time.

| Package | Version | CI Risk |
|---------|---------|---------|
| `vitest` | ^4.0.18 | Low. Active, well-maintained. Transitively pulls `@vitest/*` and `vite`. No install scripts. |
| `typescript` | ^5.7.0 | Low. Microsoft-maintained, no install scripts. |
| `tsx` | ^4.19.0 | Low. Active project. Wraps esbuild; no install scripts. |
| `eslint` | ^9.35.0 | Low. Widely audited. |
| `prettier` | ^3.8.1 | Low. Stable, minimal transitive graph. |
| `husky` | ^9.1.7 | **Note.** Runs git hooks at commit time. A compromised husky or its git hook scripts could execute arbitrary code on developer machines during `git commit`. Mitigated by husky's own minimal footprint and the fact that git hooks are checked into the repository (visible to review). |
| `typescript-eslint` | ^8.35.0 | Low. |
| `@types/*` | various | Low. Type definitions only. |

**Overall devDep verdict:** LOW risk. The devDep graph is a standard TypeScript project toolchain. `husky` is the only package with execution at a security-sensitive moment (commit time), but the risk is bounded and the package is well-maintained.

---

### 1.6 Summary Table

| Package | Risk Level | Primary Concern | Trust Domain |
|---------|-----------|-----------------|--------------|
| `better-sqlite3` | MEDIUM | Native binary download; highest-privilege write surface (audit log) | TD-ORCHESTRATOR |
| `cron-parser` | LOW | None significant | TD-ORCHESTRATOR |
| `grammy` | MEDIUM | In-process TD-ORCHESTRATOR privilege; `node-fetch` v2 (exact pin applied — §2.5) | TD-ORCHESTRATOR |
| Baileys | N/A | **Absent from host manifest** — correctly relegated to optional skill | — |
| @anthropic-ai/* | N/A | **Absent from host manifest** — correctly confined to TD-CONTAINER | — |

No direct dependency is assessed as HIGH risk in isolation. The HIGH risk finding from F-10 applies to the systemic property of the npm ecosystem and the absence of an auditing process — not to any individual package.

---

## Part 2 — npm Audit Policy for CI

### 2.1 Policy Statement

All CI pipelines for the OpenGolem host-side codebase must enforce the following npm audit controls. These controls implement the Phase 1 component of F-10's recommended action. They do not eliminate supply-chain risk but make regressions detectable before they reach a deployed instance.

### 2.2 Zero-High-Severity Gate

**Command:** `npm audit --audit-level=high`

**What triggers a build failure:** Any vulnerability with severity `high` or `critical` in any package reachable from the production dependency graph (i.e., non-`dev` packages). The CI step must exit non-zero and block merge when `npm audit --audit-level=high` reports one or more findings.

**Scope:** The gate applies to production dependencies only by default. Development dependencies are audited separately with `npm audit --only=dev --audit-level=critical` — a critical severity in a devDep is a build failure; a high severity in a devDep is a warning logged but not a gate failure. This asymmetry reflects the reduced production exposure of devDeps.

**Suppression mechanism:** Individual CVEs may be suppressed only via an entry in `.nsprc` (or equivalent `npm audit` ignore mechanism) with: the CVE identifier, the date of suppression decision, a justification, and the responsible approver (Jim). Blanket suppression of audit-level gates is not permitted. Suppressed CVEs are reviewed at the next scheduled audit cycle and must be re-evaluated if a patch becomes available.

### 2.3 Lockfile Integrity Verification

**Command:** `npm ci` (not `npm install`)

**Mechanism:** `npm ci` installs from `package-lock.json` exactly, failing if `package.json` and `package-lock.json` are out of sync. This prevents silent lockfile updates in CI environments.

**What constitutes a failure mode:** The CI step fails if:
- `package-lock.json` is absent from the repository
- `package-lock.json` and `package.json` are inconsistent (version mismatch)
- Any package's integrity hash in the lockfile does not match the registry-reported hash

**Lockfile commit policy:** `package-lock.json` must be committed to the repository and must never be in `.gitignore`. PRs that modify `package.json` must also update `package-lock.json`; a PR that modifies `package.json` without updating the lockfile is blocked by a pre-commit hook or CI check.

**Lockfile hash verification (recommended for Phase 2):** For Phase 2, consider adding `npm audit signatures` to verify the registry signatures of installed packages, or adopting a tool such as `better-npm-audit` that performs additional cross-referencing against the GitHub Advisory Database. For Phase 1, `npm ci` + `npm audit` is the minimum viable gate.

### 2.4 Audit Cadence

**On every PR:** `npm ci` + `npm audit --audit-level=high` run as required CI checks. A PR cannot be merged if either check fails. This is the primary gate.

**Nightly scheduled run:** A separate nightly CI job runs `npm audit --audit-level=moderate` (broader sweep, moderate and above) against the current `main` branch without a PR gate. This catches newly disclosed CVEs between PR cycles. Results are posted as a GitHub issue or Slack/Telegram notification to the maintainer. A new `high` or `critical` finding in the nightly run triggers an alert requiring human review within one business day.

**Manual audit on dependency addition or upgrade:** Any PR that adds or upgrades a production dependency must include evidence of a manual review of the new package's transitive graph (a brief comment in the PR description is sufficient for a single-developer project). This is not automated — it is a process obligation documented here.

### 2.5 Dependency Update Trigger Policy

Not all updates are equal. Updating too eagerly introduces supply-chain risk (a compromised minor release fetched automatically); updating too conservatively accumulates CVE exposure. The policy below distinguishes three update classes and applies different triggers and review requirements to each.

**Class A — Security-triggered (mandatory):** A known CVE at HIGH or CRITICAL severity affecting OpenGolem's usage of a production dependency. Mandatory update within 72 hours of disclosure. The PR must pass `npm audit --audit-level=high` and include a comment assessing exploitability in the OpenGolem deployment context.

**Class B — Patch-version update (on-demand, not scheduled):** A new patch release of a pinned dependency with no CVE trigger. Permitted but not automatic.
- `cron-parser`: quarterly review cadence is sufficient.
- `grammy`: on-demand only. Because grammy runs in TD-ORCHESTRATOR and handles all user message content before any Call Inspector filtering, a compromised minor release would be fetched at the next lockfile regeneration. No automatic patch updates.
- `better-sqlite3`: on-demand only, see binary verification requirement below.

**Class C — Minor or major version bump (named-approver sign-off required):** Any update that moves a major or minor version number. Requires Jim sign-off as named approver. The PR description must document: what changed in the transitive graph, any new `postinstall`/`preinstall` scripts, and for `better-sqlite3`, whether the binary download mechanism changed.

**72-hour minimum release age:** No production dependency is updated to a version published within the previous 72 hours, absent a confirmed CVE in the current version. This quarantine window gives the npm community time to detect and report compromised releases before they are adopted. The September 2025 "Shai-Hulud" npm supply-chain attack (19 packages, 2.6B weekly downloads) would have been prevented by this control combined with lockfile pinning.

**`better-sqlite3` binary verification step:** Any version bump of `better-sqlite3` requires a manual check that the prebuilt binary SHA-256 published on the GitHub releases page matches what `prebuild-install` fetches during `npm ci`. The `better-sqlite3` lockfile entry's integrity hash covers the npm package tarball — it does not cover the prebuilt `.node` binary downloaded by the `postinstall` script. This binary verification is a process obligation logged in the PR. Until an automated hash-verification step is added to CI, this is a human gate on every `better-sqlite3` upgrade.

### 2.6 Escalation Path for Unupgradeable High-Severity CVEs

A high-severity CVE that cannot be immediately patched (because no fixed version of the dependency exists, or because upgrading introduces a breaking change) follows this escalation path:

1. **Triage (within 24 hours of disclosure):** The maintainer confirms the finding, assesses exploitability in the OpenGolem context (attack vector, privileges required, interaction required), and records the assessment in a GitHub issue labeled `security/cve`.

2. **Interim mitigation decision:** If the CVE is exploitable in the OpenGolem deployment context, one of the following interim controls must be applied:
   - **Workaround at the application layer** (e.g., sanitise inputs that the vulnerable code path processes)
   - **Replace the dependency** with an alternative package (even if this requires refactoring)
   - **Temporary lockfile pin** to a known-good version if a regression was introduced by a recent update
   - **Deployment advisory** if the CVE is exploitable only in configurations not used by OpenGolem (e.g., a CVE in a code path that OpenGolem does not invoke)

3. **Suppression entry:** If an interim decision is made to accept the risk temporarily, a suppression entry is added to `.nsprc` with the CVE ID, date, justification, and expiry date (maximum 90 days). The suppression is reviewed at expiry.

4. **Upstream escalation:** If the vulnerable package has no maintained alternative and the CVE is high-consequence, the finding is escalated to Jim for a risk-acceptance decision. A risk-accepted CVE must be documented in `DECISIONS.md` as an explicit ADR. This is not a permanent suppression — it is a time-bounded decision with a review trigger (the upstream package releasing a fix, or a Phase 2 replacement being implemented).

5. **Phase 2 dependency elimination:** For any CVE in a package that is on the Phase 2 elimination list (i.e., a package that will be replaced by a Rust equivalent), the risk-acceptance period is bounded by the Phase 2 milestone at which the package is retired.

Note: the 72-hour response window for HIGH/CRITICAL CVEs (Class A updates per §2.5) is the same window used for mandatory container base image refreshes on security findings (supply-chain-policy.md §3.4). Both are calibrated to the same threat cadence.

---

*This document covers Parts 1 and 2 of the Supply-Chain Audit (Stream L). Parts 3 and 4 are in `docs/security/supply-chain-policy.md`.*
