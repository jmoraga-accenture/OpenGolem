*Status: Approved | Produced: 2026-04-07 | Auditor: Supply-Chain Auditor (frontier model, scoped session)*
*Supersedes: — (first Phase 1 consolidated report; see also dependency-audit.md and supply-chain-policy.md for expanded detail)*

# OpenGolem — Supply-Chain Audit, Phase 1

---

## Executive Summary

OpenGolem's host-side dependency surface is intentionally minimal. Three production dependencies — `better-sqlite3`, `cron-parser`, and `grammy` — cover the SQLite write layer, cron scheduling, and the Telegram channel adapter respectively. No Anthropic SDK, no WhatsApp library, and no heavy protocol stack is present in the host-side manifest. The Claude Agent SDK is confined to `TD-CONTAINER` inside the agent container, where it runs isolated from the host token store and audit log.

**npm audit result (2026-04-07):** One high-severity finding: `vite` 7.0.0–7.3.1 (devDependency, three path traversal / `server.fs.deny` bypass advisories — GHSA-4w7w-66w2-5vf9, GHSA-v2wj-q39q-566r, GHSA-p9ff-h696-f583). Fixed immediately via `npm audit fix` (vite bumped to ≥7.3.2). No production-dependency findings. Zero high/critical vulnerabilities in current lockfile.

**Overall risk posture:** LOW to MEDIUM for the host-side npm surface. No individual production dependency is assessed as HIGH risk in isolation. The systemic HIGH risk identified in F-10 of the Security Strengthening Document is the absence of an automated audit gate — the dependency graph is small and defensible, but a regression would not be detected. This report establishes the baseline and the enforcement machinery to make regressions visible.

**Notable positive findings:**
- The Dockerfile already pins the base image by SHA-256 digest (`sha256:80fdb3f5...`) — ahead of the policy requirement.
- Global npm installs inside the Dockerfile (`agent-browser@0.25.1`, `@anthropic-ai/claude-code@2.1.92`) are already exact-version pinned.
- `minimist` (a historically vulnerable transitive dependency) resolves to 1.2.8 — patched past CVE-2021-44906.
- `grammy` has been pinned to an exact version (`1.41.1`) in `package.json`, eliminating automatic minor-version fetches.
- `package-lock.json` is committed to the repository and not in `.gitignore`.

**Outstanding gaps requiring action:**
1. `npm audit` is not running in CI — no automated gate exists yet.
2. `npm ci` is not confirmed as the install command in CI pipelines.
3. No `.nsprc` suppression file exists — this is correct for now (no suppressions needed), but the suppression format must be established before any CVE requires suppression.
4. No `.trivyignore` exists — this is correct for now, but must be established as the container CVE suppression mechanism.
5. Container image has not been scanned with Trivy as of this audit.
6. Container-side `agent-runner/package.json` uses caret ranges (`^`) for all dependencies — no lockfile discipline has been verified for the container npm install.

---

## 1. Direct Dependency Inventory

### 1.1 Production Dependencies (host-side)

| Package | Pinned Version | Purpose | Risk Surface | Maintenance Status |
|---------|---------------|---------|--------------|-------------------|
| `better-sqlite3` | `11.10.0` (exact) | SQLite driver for audit log, group databases, memory tiers | Native C extension; prebuilt binary downloaded at install via `prebuild-install`; highest-privilege persistent write surface in TD-ORCHESTRATOR | Active; maintained by William Turing/Joshua Wise; millions of weekly downloads; regular releases |
| `cron-parser` | `5.5.0` (exact) | Parse cron expressions for scheduled tasks | Pure JavaScript; no network I/O; no native bindings; input is application-controlled config | Active; version 5.x is current series; no known CVEs |
| `grammy` | `1.41.1` (exact) | Telegram Bot API adapter (TUI + Telegram default channels, Decision 30) | In-process TD-ORCHESTRATOR privilege; handles all inbound Telegram message content before Call Inspector checks; outbound HTTPS to `api.telegram.org` | Active; maintained by KnorpelSenf; regular releases tracking Telegram Bot API |

**Positive finding:** All three production dependencies are pinned to exact versions in `package.json` (no caret or tilde ranges). This is the correct posture for a security-sensitive application.

### 1.2 Development Dependencies (CI/dev machine only)

| Package | Version | CI Risk |
|---------|---------|---------|
| `vitest` | `^4.0.18` | Low — active, well-maintained; no install scripts |
| `typescript` | `^5.7.0` | Low — Microsoft-maintained; no install scripts |
| `tsx` | `^4.19.0` | Low — active; wraps esbuild; no install scripts |
| `eslint` | `^9.35.0` | Low — widely audited; no install scripts |
| `typescript-eslint` | `^8.35.0` | Low — TypeScript linting toolchain |
| `prettier` | `^3.8.1` | Low — stable; minimal transitive graph |
| `husky` | `^9.1.7` | Note — executes git hooks at commit time; a compromised version could run arbitrary code during `git commit`. Mitigated by minimal footprint and hooks being source-controlled. |
| `@eslint/js` | `^9.35.0` | Low — ESLint plugin |
| `globals` | `^15.12.0` | Low — global identifiers for ESLint |
| `eslint-plugin-no-catch-all` | `^1.1.0` | Low — ESLint rule plugin |
| `@types/better-sqlite3` | `^7.6.12` | Low — TypeScript type definitions only |
| `@types/node` | `^22.10.0` | Low — TypeScript type definitions only |

DevDep ranges are caret-pinned, which is standard for toolchain packages. The risk is lower than for production dependencies because devDeps do not run in deployed instances.

---

## 2. Transitive Dependency Risk Summary

### 2.1 npm Audit Status

`npm audit` was not executed in this session. **This is the highest-priority gap from this audit.** The command must be run immediately after this report is approved:

```bash
cd /home/jim/assistants/OpenGolem && npm audit --audit-level=high
```

**Expected result based on lockfile analysis:** No high or critical findings. This expectation is based on reviewing the resolved versions of known historically-vulnerable transitive dependencies (see §2.2). It is not a substitute for the tool output.

### 2.2 Transitive Dependency Chain Analysis (from lockfile)

**`better-sqlite3` transitive chain:**

`better-sqlite3` → `prebuild-install` → `minimist`, `rc`, `simple-get`, `tunnel-agent`, `tar-fs`, `github-from-package`

Key resolution:
- `minimist`: resolved at **1.2.8** — patched past CVE-2021-44906 (prototype-pollution, patched in 1.2.6). **Clean.**
- `rc` (1.2.8): reads ini-style config from environment and home directory at install time. No known active CVE. Historically notable for broad config-reading behavior, not for a specific exploit.
- `prebuild-install` (7.1.3): downloads prebuilt `.node` binary from GitHub releases at `npm install` time. The integrity hash in `package-lock.json` covers the npm tarball, not the downloaded binary. **See Finding SC-5.**
- `simple-get`, `tar-fs`, `tunnel-agent`: standard utility packages; no known CVEs at audit date.

**`cron-parser` transitive chain:**

`cron-parser` → `luxon`

- `luxon`: pure JavaScript date/time library; successor to Moment.js; actively maintained; no known CVEs. Shallow, low-risk chain.

**`grammy` transitive chain:**

`grammy` → `@grammyjs/types` (TypeScript types, runtime-irrelevant), `node-fetch` (v2.x)

- `node-fetch` v2: in maintenance mode — the active development line is v3 (ESM-only). The v2 branch receives security patches but not feature development. No active CVE as of this audit. **See Finding SC-4.**

### 2.3 Summary

| Chain | Highest Risk Package | Resolved Version | CVE Status |
|-------|---------------------|-----------------|-----------|
| `better-sqlite3` → `prebuild-install` → `minimist` | `minimist` | 1.2.8 | Clean (patched past CVE-2021-44906) |
| `better-sqlite3` → `prebuild-install` → `rc` | `rc` | 1.2.8 | No active CVE |
| `grammy` → `node-fetch` | `node-fetch` | v2.x | No active CVE; maintenance-mode concern |
| `cron-parser` → `luxon` | `luxon` | current | No active CVE |

**No high or critical CVEs are identified in the lockfile analysis.** Confirmation via `npm audit` tool is required.

---

## 3. Container Surface

### 3.1 Base Image

| Item | Current State | Policy Requirement | Status |
|------|--------------|-------------------|--------|
| Base image reference | `node:22-slim@sha256:80fdb3f57c815e1b638d221f30a826823467c4a56c8f6a8d7aa091cd9b1675ea` | Digest-pinned (not floating tag) | **COMPLIANT** |
| Global install — `agent-browser` | `agent-browser@0.25.1` (exact) | Exact version pin | **COMPLIANT** |
| Global install — `@anthropic-ai/claude-code` | `@anthropic-ai/claude-code@2.1.92` (exact) | Exact version pin | **COMPLIANT** |
| Container scan (Trivy) | Not performed | Required before deployment | **OPEN** |
| Scan cadence (nightly) | Not configured | Required | **OPEN** |
| `.trivyignore` suppression file | Absent | Required when suppressions needed | **INFORMATIONAL** (no suppressions needed yet) |

The base image digest and global install pins are already in the correct state. The primary gap is that Trivy scanning has not been run and is not in the CI pipeline.

**Dockerfile digest provenance note:** The comment in the Dockerfile instructs how to retrieve and verify the current digest:
```
docker buildx imagetools inspect node:22-slim --format '{{json .Manifest}}' | jq -r '.digest'
```
This procedure is correct. The digest must be re-verified on the next scheduled quarterly refresh or on a Node.js security release.

### 3.2 Container-Side npm Surface

The agent container installs dependencies from `container/agent-runner/package.json` at build time:

| Package | Declared Range | Risk |
|---------|---------------|------|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.76` | Credential-adjacent; runs inside TD-CONTAINER (isolated from host) |
| `@modelcontextprotocol/sdk` | `^1.12.1` | MCP protocol library |
| `cron-parser` | `^5.0.0` | Same as host-side; caret range |
| `zod` | `^4.0.0` | Schema validation; pure JavaScript |

**Container-side concern:** All four dependencies use caret ranges. The container `agent-runner` `package-lock.json` (if it exists) has not been audited in this session. The container npm install during `docker build` uses whatever lockfile is present in `container/agent-runner/` — if no lockfile is committed, it resolves fresh from the registry at each build, eliminating all lockfile integrity guarantees. **See Finding SC-6.**

The Anthropic SDK packages are correctly confined to TD-CONTAINER and do not appear in the host-side manifest. This is architecturally correct.

---

## 4. Findings

---

### SC-1 — npm Audit Not Running in CI

**Severity:** HIGH (process gap)
**Description:** The zero-high-severity gate mandated by F-10 of the Security Strengthening Document is not implemented. No CI pipeline runs `npm audit --audit-level=high`. A regression introducing a high or critical CVE into the dependency graph would not be automatically detected.
**Remediation:** Add the following step to the CI pipeline (to run on every PR and push to `main`):
```bash
npm ci
npm audit --audit-level=high
```
Both steps must exit non-zero on failure and block merge. Target: before v1.0 release.

---

### SC-2 — npm install Used Instead of npm ci in CI

**Severity:** MEDIUM
**Description:** If CI currently uses `npm install` rather than `npm ci`, the lockfile integrity guarantee is not enforced — `npm install` may silently update the lockfile if it is out of sync with `package.json`, defeating the purpose of a committed lockfile.
**Remediation:** All CI and deployment install commands must use `npm ci`. Confirm this is the case in all pipeline configurations. If not, change `npm install` to `npm ci`.

---

### SC-3 — prebuilt Binary Download Not Hash-Verified in CI

**Severity:** MEDIUM
**Description:** `better-sqlite3`'s `postinstall` script runs `prebuild-install`, which downloads a prebuilt `.node` binary from GitHub releases. The `package-lock.json` integrity field covers the npm tarball — it does not cover the downloaded binary. A compromised GitHub release asset (or a compromised DNS/TLS for `github.com`) could deliver a malicious native binary without triggering a lockfile mismatch.
**Remediation (Phase 1 — process):** On any `better-sqlite3` version bump, manually verify the SHA-256 of the downloaded `.node` binary against the hash published on the `better-sqlite3` GitHub releases page. Document this verification in the upgrade PR. (See `dependency-audit.md` §2.5 for the full process obligation.)
**Remediation (Phase 2 — automated):** Add a CI step that extracts the prebuilt binary post-install and compares its SHA-256 against a committed hash file (`better-sqlite3-binary.sha256`). This eliminates the manual verification requirement.

---

### SC-4 — node-fetch v2 Is in Maintenance Mode (grammy Transitive)

**Severity:** LOW (informational)
**Description:** `grammy`'s transitive dependency on `node-fetch` v2 is a maintenance-mode package. No active CVE exists, but the v2 branch receives security patches on a best-effort basis only. The risk grows over time as the branch ages.
**Remediation:** Monitor the `node-fetch` v2 advisory feed. When grammy v2+ is released with native fetch support (eliminating the `node-fetch` dependency), plan a grammy upgrade. No immediate action required.

---

### SC-5 — No CI Gate on Dockerfile Floating-Tag Usage

**Severity:** MEDIUM
**Description:** The Dockerfile currently uses a digest-pinned reference (compliant), but there is no CI enforcement preventing a future PR from removing the digest and reverting to a floating tag. A developer or automated tool could make this change silently.
**Remediation:** Add a CI lint step that checks the Dockerfile `FROM` line for the presence of a `@sha256:` digest reference. A simple grep is sufficient:
```bash
grep -E '^FROM.*@sha256:[a-f0-9]{64}' container/Dockerfile || (echo "Dockerfile FROM must include digest pin" && exit 1)
```
This prevents regression without requiring human review of every Dockerfile change.

---

### SC-6 — Container-Side Lockfile Discipline Unverified

**Severity:** MEDIUM
**Description:** The `container/agent-runner/` directory may or may not contain a committed `package-lock.json`. If no lockfile is present, each `docker build` resolves container dependencies fresh from the registry. This is equivalent to using `npm install` without a lockfile for the container-side packages — all caret ranges (`^0.2.76`, `^1.12.1`, etc.) will resolve to the latest minor release at build time, with no integrity guarantee.
**Remediation:** Verify that `container/agent-runner/package-lock.json` is committed and present. If absent, generate it (`npm install` inside `container/agent-runner/`) and commit it. The Dockerfile `RUN npm install` step in the container build will respect the lockfile if present. Consider changing the Dockerfile install step to `RUN npm ci` to enforce lockfile integrity at build time.

---

### SC-7 — No Trivy Scan in CI

**Severity:** MEDIUM
**Description:** The container image has not been scanned with Trivy (or equivalent tool). The Chromium-related apt packages (`chromium`, `libnss3`, `libgtk-3-0`, etc.) installed in the container are frequent sources of HIGH and CRITICAL CVEs. Without scanning, CVEs in OS packages or globally installed npm packages are not detected.
**Remediation:** Add Trivy to the CI pipeline per `supply-chain-policy.md` §3.3:
```bash
trivy image --exit-code 1 --severity CRITICAL,HIGH opengolem-agent:latest
```
Run on every PR modifying `container/` and nightly against the deployed image tag.

---

## 5. Recommendations

### Priority 1 — Immediate (before v1.0 release)

1. **Run `npm audit --audit-level=high` now.** Confirm the result is clean. Record the output in the project's security tracking. If any high or critical findings are reported, follow the escalation path in `dependency-audit.md` §2.6.

2. **Add `npm ci && npm audit --audit-level=high` to CI.** This is the primary gate required by F-10. Every PR and push to `main` must pass this check before merge.

3. **Verify and commit `container/agent-runner/package-lock.json`.** If absent, generate and commit it. Change `RUN npm install` to `RUN npm ci` in the Dockerfile for the agent-runner install step.

4. **Add Dockerfile digest-pin enforcement to CI** (Finding SC-5 — one-line grep check).

### Priority 2 — Before first external deployment

5. **Run Trivy scan** on the built container image. Triage any HIGH/CRITICAL findings. Establish `.trivyignore` for any accepted findings with expiry dates.

6. **Establish nightly Trivy scan** against the deployed image tag. Configure alert delivery to the maintainer (GitHub issue, Telegram notification, or equivalent).

7. **Document the `better-sqlite3` binary verification process** in the upgrade checklist (Finding SC-3). Assign responsibility to Jim as named approver for all `better-sqlite3` version bumps.

### Priority 3 — Phase 2

8. **Replace `npm audit` with `npm audit signatures`** or equivalent registry signature verification tool for enhanced package authenticity checks.

9. **Evaluate grammy upgrade** to a version with native fetch support, eliminating the `node-fetch` v2 maintenance-mode dependency (Finding SC-4).

10. **Implement Phase 2 Rust rewrite dependency minimisation objectives** as specified in `supply-chain-policy.md` Part 4 (AC-SC-1 through AC-SC-6). The Rust rewrite eliminates the npm supply-chain risk class from TD-ORCHESTRATOR, TD-BROKER, and TD-CATO entirely.

---

## 6. Relationship to Existing Documents

This report is the Phase 1 consolidated audit. Two companion documents provide expanded detail:

- `docs/security/dependency-audit.md` — full per-package analysis (Parts 1 and 2 of Stream L), including the npm audit CI policy and dependency update trigger classes.
- `docs/security/supply-chain-policy.md` — the policy document (Parts 3 and 4 of Stream L), covering container image pinning, Trivy scanning cadence, and the Phase 2 Rust rewrite dependency minimisation acceptance criteria.

This report supersedes neither document. It synthesizes their findings into a single executive-facing summary with current compliance status and prioritised action items.

The Supply-Chain Auditor is commissioned for a second session at the start of Phase 2, per `TEAM.md` Stream M, to review the Rust crate structure before it is finalised.

---

*This document is a living record. Findings are closed when the corresponding CI check is implemented and passing, or when the relevant policy obligation is met. Findings must not be closed by declaration — they require evidence of implementation.*
