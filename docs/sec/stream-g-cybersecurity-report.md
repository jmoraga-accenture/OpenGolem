# Stream G — Cybersecurity Specialist Report
*Status: Awaiting PM approval | Produced: 2026-04-06*
*Inputs: ARCHITECTURE.md v1.0, SECURITY_STRENGTHENING.md, DECISIONS.md (Decisions 1–30), docs/specs/token-broker-spec.md, docs/specs/orchestrator-spec.md, docs/specs/channel-adapters-spec.md, docs/specs/audit-log-spec.md, docs/specs/cato-spec.md, docs/specs/skill-schema-spec.md, docs/specs/soul-psyche-spec.md, package.json*

---

## Executive Summary

OpenGolem's trust domain model and Unix socket IPC architecture provide a strong structural security foundation: raw credentials are isolated in the Token Broker, containers hold only derivative tokens, Cato is architecturally unreachable from user sessions and containers, and the audit log has append-only write semantics. The system is notably safer by design than a flat single-process assistant.

However, five findings from the Security Strengthening Document remain fully open in the current specifications, and two are only partially addressed. The most critical unresolved gaps are: the Teams Bot Framework inbound HTTP endpoint has no specified authentication or network binding posture (F-1), the credential proxy HTTP surface has no specified binding restriction (F-2), the audit log has no cryptographic tamper-evidence beyond application-layer INSERT-only semantics (F-3), and the npm dependency surface for Phase 1 has no specified audit or lockfile policy (F-10). These four represent the highest-consequence unaddressed risks before v1.0 ships. F-3 and F-10 are independent escalations: the original document rates F-3 as High and F-10 as High; this review confirms both ratings and finds that F-10 is additionally the most likely attack vector to succeed in practice during Phase 1 because it operates below all of OpenGolem's trust domain controls.

The F-9 MCP permission tier gap is confirmed as accepted by Decision 29 but the interim control — admin-only groups for MCP-declaring skills — is not yet written into any behavioral spec. That documentation obligation must be discharged before any MCP-declaring skill is published.

---

## Finding Reviews

---

### F-1 — Inbound Transport Security Is Unspecified

**Original severity:** High
**Confirmed severity:** High

**Threat narrative:**
The Teams adapter receives Bot Framework activity payloads on a locally-bound HTTP endpoint. If this endpoint is exposed beyond localhost — either by misconfiguration, by a reverse proxy that is misconfigured, or by a tunnelling service (ngrok, Cloudflare Tunnel) that exposes it to the internet without credential validation — an adversary can POST arbitrary payloads to it. Because the channel adapter delivers every parseable inbound event to the orchestrator without sender gating (sender allowlist enforcement is the orchestrator's responsibility, downstream of delivery), a crafted payload passes directly into the orchestrator's task queue. From there it receives a Cato check, but Cato's Phase 1 deterministic checks cover path traversal, oversized payload, injection signatures, PII, and credential exposure — they do not check whether the inbound message originated from a legitimately authenticated Teams user. The adversary needs network access to the endpoint and knowledge of the expected JSON schema. The call inspector and Cato checks apply to agent-originated outbound calls, not to inbound message delivery.

The same vector exists for Telegram and WhatsApp in webhook mode (as opposed to long-poll): a webhook endpoint without signature validation accepts arbitrary crafted messages from any source. Long-poll mitigates this for Telegram because the bot SDK polls Telegram's servers rather than accepting connections. However the architecture does not specify which mode is the required posture.

The concrete gain for an adversary: injection of arbitrary task content into the task queue of a running Golem instance, bypassing the intent of the sender allowlist. This is prompt injection delivered at the channel boundary rather than the LLM boundary.

**Spec coverage:** Fully open.

The channel-adapters-spec.md acknowledges that the Teams adapter receives activity payloads via "a locally-bound HTTP endpoint" and declares `network.endpoints` for outbound calls to `smba.trafficmanager.net` and `login.microsoftonline.com`. It says nothing about: how the inbound endpoint is bound, what authentication it requires, whether Bot Framework payload signature verification is mandatory, or what network exposure is permitted. The invariants section does not include an authentication invariant for inbound channel traffic.

ARCHITECTURE.md §4.1 describes the inbound path as "channel-native" and does not specify transport security. No ADR addresses inbound transport.

**ADR recommendation:** New ADR required. See Draft ADR Text section below (ADR-31). The channel-adapters-spec must also gain an invariant: "INV-N: For every adapter that binds an inbound HTTP or TCP endpoint (Teams Bot Framework, Telegram webhook mode), the endpoint must implement channel-provider-issued payload signature verification before delivering the event to the orchestrator. Events that fail signature verification are discarded and logged as `message_signature_invalid`; they are never delivered to the orchestrator."

---

### F-2 — Credential Proxy HTTP Binding Is Unspecified

**Original severity:** High
**Confirmed severity:** High

**Threat narrative:**
The Token Broker binds an HTTP endpoint that agent containers call as their `ANTHROPIC_BASE_URL`. Containers present a derivative token; the broker validates it, runs Call Inspector checks, and proxies the call to the real provider. If the proxy binds to `0.0.0.0` (or any interface reachable by processes outside the Docker bridge network), then any process on the host — including a compromised npm dependency running in the orchestrator process, a lateral-movement attacker who has gained a shell on the host as a different user, or any other container on the Docker host — can present a stolen derivative token and make proxied LLM calls.

The derivative token model is the primary defence, but it does not help if the adversary has a valid token. Token lifetimes are short (default TTL of 300 seconds per the spec), but during that window any process that can reach the HTTP endpoint can impersonate the container. The binding restriction would confine the attack surface to processes running on the Docker bridge network only, which is a smaller set than all processes on the host.

Additionally: the spec describes the Ollama path as forwarding calls over HTTP to a local endpoint with no Authorization header injection. If the proxy itself binds broadly, Ollama calls can be forwarded by any caller without any token (since Ollama requires no auth), making the Call Inspector bypassable for self-hosted model deployments.

**Spec coverage:** Fully open.

The token-broker-spec.md §4.5 describes the container-to-proxy protocol (HTTP, derivative token as bearer) and the Call Inspector chain, but does not specify what interface the HTTP server binds to. The architecture (ARCHITECTURE.md §4.5) states the container "calls TD-BROKER via HTTP (credential proxy)" and "points their `ANTHROPIC_BASE_URL` environment variable at this proxy" — no binding posture is stated. No ADR addresses this.

**ADR recommendation:** New ADR required. See Draft ADR Text section below (ADR-32). The token-broker-spec must gain a behavioral contract clause: "The credential proxy HTTP server must bind to the Docker bridge network interface only (not `0.0.0.0`). The default bind address is `172.17.0.1` (Docker default bridge). The actual interface address is resolved at startup by reading the Docker bridge interface configuration. If the bridge address cannot be determined, the broker fails closed and does not start."

---

### F-3 — Audit Log Has No Cryptographic Integrity Protection

**Original severity:** High
**Confirmed severity:** High (with a note on Phase sequencing)

**Threat narrative:**
The audit log is the ground truth for Cato's dao_score KPIs and hansei reports. If a sufficiently privileged adversary — whether a compromised service account, a rogue administrator, or an attacker who has escalated to the service user on the host — modifies the SQLite file directly (bypassing the application write interface), Cato silently reads falsified data. The attack does not need to bypass any OpenGolem component; it operates at the OS filesystem layer.

The most consequential manipulation is selective deletion: removing `call_blocked` and `call_soft_blocked` events from the audit log would depress `security_failures_per_call`, causing Cato's scheduled audit to report a healthier posture than reality. An adversary who wishes to operate an agent that would otherwise trigger Golem Guard locking can suppress the evidence. Because Cato has no independent data source against which to cross-check (the audit log is the only record), the governance output cannot self-detect falsification.

The `sequence_id` contract (audit-log-spec.md §3.7) provides some gap detection: a deleted row would produce a sequence gap detectable on the next audit. However, sequence IDs reset on process restart (they are not persisted), so a complete log replacement after a restart — or manipulation between scheduled audit runs — would be undetectable.

**Spec coverage:** Partially addressed.

The audit-log-spec.md correctly specifies INSERT-only write paths, a build-time check against UPDATE/DELETE, WAL mode, and per-writer `sequence_id` monotonicity (§3.7) that allows gap detection per-writer per-process-run. These are meaningful software-layer controls. However, the spec explicitly contains no cryptographic integrity mechanism. ARCHITECTURE.md §3.7 notes "append-only semantics: enforced by schema design, supplemented by OS-level file permissions where possible" — the "where possible" hedge is correct but leaves the threat unaddressed at the storage layer. The SECURITY_STRENGTHENING.md recommendation (HMAC chain, signed export, or `chattr +a`) is not reflected in any spec.

The `sequence_id` gap detection is valuable but insufficient: it cannot detect record manipulation that preserves row count (field-level modification), replacement of the database file, or deletion between audits when sequence counters reset.

**ADR recommendation:** The original finding correctly identifies HMAC chaining as the lowest-friction starting point. This should be a Phase 2 commitment (consistent with the SECURITY_STRENGTHENING.md recommendation), but the ADR must be produced now so that the audit log spec and the Cato spec can reserve the fields. See Draft ADR Text section below (ADR-33). The audit-log-spec must also add a note to the `sequence_id` contract section (§3.7): "Sequence ID gap detection is a software-layer integrity signal only. It does not protect against OS-level file replacement or field-level modification. Cryptographic chain integrity (ADR-33) is required before the audit log can be treated as a tamper-evident record."

---

### F-4 — In-Process Adapter Supply-Chain Risk Is Accepted Without Mitigation Controls

**Original severity:** High
**Confirmed severity:** High (partially mitigated by existing controls; mitigation gap remains)

**Threat narrative:**
Channel adapters run in-process with the orchestrator (ADR-6). A compromised adapter — whether delivered via a malicious npm package in Grammy or Baileys, or via a malicious Feature skill applied by the administrator — executes within TD-ORCHESTRATOR with access to all in-process state: the token store reference, the Unix socket file descriptors, the group filesystem, and the in-process audit log write path. The OpenClaw/ClawHub exfiltration incident (referenced in SECURITY_STRENGTHENING.md) demonstrates this vector is active in the agentic assistant ecosystem.

The `.intent.md` schema requires declaration of network endpoints, and the Call Inspector enforces those for calls routed through the credential proxy. However, a malicious in-process adapter can bypass the credential proxy entirely: it has direct access to `process.env` (in Node.js, environment variables are readable by all in-process code unless stripped), can open direct TCP connections that do not go through any inspector, and can read files from the group filesystem directly. The `--permission` flag for Node.js (available from Node 20, which is the minimum runtime per `package.json`) provides OS-level capability restriction at the process level, but it is not currently specified.

**Spec coverage:** Partially addressed.

The channel-adapters-spec.md acknowledges the risk: "the risk of in-process compromise is accepted because a malicious adapter is a supply-chain attack on the administrator's machine, which is outside OpenGolem's security boundary." The `.intent.md` endpoint declaration requirement provides audit accountability for declared outbound connections. `apply_permission: admin` constrains who can apply adapters.

The gap: no spec requires that adapter-to-channel-provider connections not declared in `.intent.md` produce an audit event; no spec mandates use of Node.js `--permission` to restrict filesystem or network access; no spec restricts adapter sourcing to the canonical repository.

**ADR recommendation:** This finding should be addressed in two layers. The first layer is a deployment policy ADR (ADR-34, see Draft ADR Text) specifying: (a) adapter sourcing must be from the canonical repository or administrator-audited sources; (b) Node.js `--permission` flags to restrict network and filesystem access are mandatory for production deployments; and (c) undeclared outbound network connections from the orchestrator process are a violation of the `.intent.md` invariant and should be detectable via audit. The second layer — moving high-privilege adapters out-of-process — should be recorded as a Phase 2 design objective in a future ADR, not required for v1.0.

---

### F-5 — Token Store Crash Leaves Orphaned Containers

**Original severity:** Medium
**Confirmed severity:** Medium

**Threat narrative:**
The Token Broker's in-memory token store does not persist across restarts. A container running when the broker crashes holds a token that is no longer valid. Its next proxied call returns HTTP 403. The container cannot complete its work. It remains alive, consuming CPU and memory, holding filesystem write locks on the group directory, and potentially holding a partially-written `CLAUDE.md` or `messages.db` state, until its TTL fires. Depending on the task TTL (default not specified in the orchestrator spec), this window could be several minutes.

The security concern beyond resource exhaustion: a container that has partially completed a memory write (Tier 1 `CLAUDE.md` mutation that passed a Cato `MEMORY_WRITE` check) but has not written the result yet represents an inconsistent state. If the orchestrator tears down the container before the write completes due to broker loss, the memory state is not corrupted — but if the container has already written to the bind-mounted group directory and the orchestrator does not know this, the audit trail for that write may be incomplete.

A more direct attack: if the broker is crash-looped by an adversary who can cause repeated restarts (e.g. via resource exhaustion of the broker process), active containers are repeatedly stranded. The orchestrator queues new messages but cannot spawn containers — the system is degraded while containers accumulate TTL wait time.

**Spec coverage:** Partially addressed.

The orchestrator-spec.md failure modes table (line 411) covers "Token Broker unreachable during task dispatch" (queue pending messages, notify user, do not spawn). It does not cover mid-task broker loss — what happens to a container that is already running when the broker socket becomes unavailable. No polling mechanism for mid-task broker health is specified. No fast-teardown path for stranded containers is specified.

Decision 6 (Failure Handling) covers broker-unreachable at task start. It does not address mid-task loss.

**ADR recommendation:** This can be closed with a spec addition rather than a new ADR. The orchestrator-spec.md failure modes table must add: "Token Broker socket unavailable for a running task (mid-task broker loss): Orchestrator detects loss on a polling interval of 5 seconds during active tasks. On detected loss: (a) force-teardown all active containers; (b) revoke their tokens (non-enforceable — broker is down, log the revocation obligation as unmet); (c) write `container_teardown` to the audit log with `reason: broker_loss`; (d) queue the interrupted task for retry when the broker recovers." A supervisor restart policy for the broker (systemd `RestartSec=2`) is a DevOps/Stream H concern, not an ADR, but this spec addition is the architectural prerequisite for Stream H to document correctly.

---

### F-6 — No Inbound Message Rate Limiting

**Original severity:** Medium
**Confirmed severity:** Medium (escalated in the LLM-workload context)

**Threat narrative:**
The orchestrator's per-group message queue accepts messages without bound. A user — or a compromised channel adapter relaying injected inbound events — can fill the queue without limit. In a traditional application, queue overflow is a denial-of-service risk. In an LLM application, it is a resource exhaustion and cost amplification risk: each queued message will eventually trigger a container spawn with associated compute, memory, and API credit consumption. A sender who can inject 1,000 messages into the queue has also triggered 1,000 API calls at the operator's expense.

The sender allowlist (Telegram valid users, group allowlists) mitigates this for identifiable bad actors whose identity is known in advance. It does not mitigate a compromised account on the allowlist, a sender who has not yet been identified as malicious, or a compromised adapter that synthesises inbound events with arbitrary sender identities (since the adapter delivers all parseable events without sender gating).

The per-sender rate limit and queue depth maximum are not currently specified anywhere in the orchestrator spec or the architecture.

**Spec coverage:** Fully open.

The orchestrator-spec.md §3.2 (queue management) specifies one-task-per-group concurrency control. No rate limiting, queue depth cap, or back-pressure mechanism is specified. The dao_score KPI set (Decision 5, ARCHITECTURE.md §3.4) does not include an inbound anomaly metric. The SECURITY_STRENGTHENING.md recommendation (per-sender rate limit, queue depth max, audit log event on breach) has no corresponding spec text.

**ADR recommendation:** New ADR required. See Draft ADR Text section below (ADR-35). The orchestrator-spec must gain a behavioral contract section for queue management: configurable per-sender rate limit (default: 10 messages per minute per sender per group), configurable per-group queue depth maximum (default: 100 pending messages), and an audit log event type `queue_depth_exceeded` when the threshold is breached.

---

### F-7 — Self-Hosted Model Deployments: Safety Posture Gap Is Underdocumented

**Original severity:** Medium
**Confirmed severity:** Medium

**Threat narrative:**
An operator who configures Ollama or a `custom` provider receives no in-product signal that their safety posture has changed. In Phase 1, Cato's inline checks are deterministic stubs: path traversal and oversized payload detection. Anthropic's cloud API applies independent content moderation and safety filtering on every call; a self-hosted Ollama instance applies none. The operator's Phase 1 safety envelope with a self-hosted model is therefore: Cato's two deterministic checks, the Call Inspector's five checks (skill whitelist, memory scope, injection signatures, call rate, endpoint scope), and Alef's character-based assertiveness. There is no upstream backstop.

This is not an attack scenario in the traditional sense — it is a responsible AI disclosure gap. The operator who configures Ollama without understanding this is not being attacked; they are making an uninformed configuration decision that reduces their safety coverage. In a system designed for non-expert operators, this gap has real consequences.

The relevant attack path in an adversarial frame: a user who knows the operator is running a local model also knows that the operator's safety envelope is weaker, and may probe for behaviors that Anthropic's model refusal training would block but an unaligned local model might permit.

**Spec coverage:** Partially addressed.

The token-broker-spec.md correctly specifies that Ollama calls receive no injected credential (AC-11) and the ARCHITECTURE.md §3.0 security mode model correctly documents that Cato's inline `allow: false` is unconditional regardless of provider. However, neither the skill-schema-spec, the soul-psyche-spec (PSYCHE.md), nor the deployment documentation contains the explicit warning that SECURITY_STRENGTHENING.md recommends: a surface visible to the operator when enabling a local model, specifying that Cato now constitutes the entire safety envelope with no upstream backstop.

**ADR recommendation:** This finding can be partially closed by spec additions rather than a full new ADR. Three additions are required:
1. The skill-schema-spec behavioral contract must add: "When a skill with `providers.compatible` containing `ollama` or `custom` (not `any`) is applied, the orchestrator emits an administrator-visible warning: 'This skill is configured for a self-hosted provider. Cato's inline checks are the complete safety envelope for this provider — no upstream content moderation applies. Review PSYCHE.md thresholds before enabling this skill in production.'"
2. The soul-psyche-spec (PSYCHE.md schema) must add a required section: `Self-Hosted Provider Posture`, specifying that when a self-hosted provider is active, the PSYCHE.md thresholds warrant review and the scheduled audit interval should be reduced.
3. The deployment documentation must include a "Safety posture by provider" table before any external deployment is made.

A new ADR (ADR-36) should record the architectural decision that the operator-visible warning is the governing mechanism for this disclosure, and that Cato's inline checks are the documented floor for all providers in Phase 1.

---

### F-8 — No Credential Rotation Procedure

**Original severity:** Medium
**Confirmed severity:** Medium

**Threat narrative:**
A long-lived Anthropic API key or OAuth token is a static secret that, if leaked, remains valid until rotated. The Token Broker holds this credential in-process after loading it from the configured backend. If the credential is compromised — via a `.env` file committed to version control, a Bitwarden vault breach, a shoulder-surfing incident, or a memory disclosure from the broker process — the operator needs to rotate it. The current specs provide no guidance on: whether the broker reloads the backend without a restart, what happens to in-flight derivative tokens when the underlying credential changes, or what the emergency procedure is for suspected compromise.

In the worst-case scenario: an operator suspects their Anthropic API key has leaked. They update Bitwarden. The broker continues using the old key from memory. The leaked key remains valid. The operator has no in-product path to trigger an immediate rotation that flushes in-flight tokens and forces a backend re-read without a full service restart. A full restart invalidates all in-flight tokens and interrupts active tasks — which may be acceptable for an emergency, but the operator does not know this is the procedure and may not perform it promptly.

**Spec coverage:** Fully open.

The token-broker-spec.md specifies credential backend resolution at startup (loading the long-lived credential from the configured backend) and derivative token issuance/revocation. It does not specify: credential re-read without restart, emergency rotation method, or `rotateCredential` RPC. DECISIONS.md Decision 8 defines the three backends but does not address rotation. No ADR covers rotation behavior.

**ADR recommendation:** New ADR required. See Draft ADR Text section below (ADR-37). The token-broker-spec must gain: (a) a `rotateCredential` JSON-RPC method on the token lifecycle socket, callable by the orchestrator on administrator request, that triggers immediate backend re-read and optional revocation of all in-flight tokens; (b) a behavioral contract for planned rotation (credential changes take effect within a configurable polling interval, default 5 minutes, without requiring a restart); (c) the deployment documentation and Stream H runbook must include an emergency rotation procedure.

---

### F-9 — MCP Permission Tier Enforcement Is Phase 2 With No Interim Controls

**Original severity:** Medium
**Confirmed severity:** Medium (risk acceptance confirmed; interim control gap confirmed)

**Threat narrative:**
The `.intent.md` schema correctly includes `min_permission_tier` for MCP server declarations. Decision 29 accepts that enforcement is deferred to Phase 2 with the interim control: MCP-declaring skills restricted to administrator-only groups. The attack path in the interim period: a lower-tier group member instructs Alef to perform an action that triggers an MCP call (code commit, project management update, knowledge base write) for which they would not have direct authorisation in the target system. Because the MCP call is made using a credential that Alef's session has access to, and because permission tier enforcement is not implemented, the call succeeds regardless of the user's actual authorisation level.

The bounds of this risk are: the skill must be administrator-applied, so the call must be to an MCP server the administrator has explicitly enabled; and the MCP endpoint is in the Call Inspector's constraint list (registered via `registerSkillScope`). The risk is not unlimited — it is confined to declared, administrator-approved MCP endpoints. The concern is that administrator approval of the skill does not imply authorization for every user in every group.

**Spec coverage: interim control — not implemented in any spec.**

Decision 29 records the PM's risk acceptance and states the interim control: "MCP-declaring skills are restricted to administrator-only groups until Phase 2 permission tier enforcement is implemented. This must be stated as explicit deployment guidance in the documentation, not left implicit."

Checking the relevant specs:
- The skill-schema-spec.md defines `min_permission_tier` as a required field per MCP server entry, but the behavioral contract does not describe how it is enforced (it cannot in Phase 1 — enforcement is deferred). The spec does not contain the interim control statement from Decision 29.
- The channel-adapters-spec.md, orchestrator-spec.md, and soul-psyche-spec.md contain no reference to the MCP permission tier limitation or the admin-only restriction.
- No deployment documentation currently exists that would carry this warning (it is being written as part of the v1.0 stream).

**The interim control documented in Decision 29 is not yet reflected in any behavioral spec.** This is the gap flagged by the task instructions, and it must be closed before any MCP-declaring skill ships.

**ADR recommendation:** Decision 29 is already the governing record. The required action is spec additions, not a new ADR. The skill-schema-spec.md behavioral contract must add: "Phase 1 MCP limitation: `min_permission_tier` is validated as a required field but is not enforced at call time. MCP-declaring skills must not be applied to groups with non-administrator members until Phase 2 permission tier enforcement is implemented (see Decision 29). The orchestrator must surface a warning at skill application time when a skill declares MCP servers: 'This skill declares MCP servers. Permission tier enforcement is not active in Phase 1. Apply this skill only to administrator-only groups.'" This warning is the spec-level implementation of the interim control.

---

### F-10 — External Dependency Surface Is an Unaddressed Systemic Risk

**Original severity:** High
**Confirmed severity:** High (this finding is the most likely practical attack vector in Phase 1)

**Threat narrative:**
This finding covers three distinct surfaces. Each is assessed separately.

**Surface 1: Node.js runtime.**
The orchestrator, Token Broker, and Cato all run in Node.js processes. Any V8 or libuv vulnerability is unconditionally inherited. Node.js has had multiple security-relevant CVEs including prototype pollution vulnerabilities (CVE-2022-21824, CVE-2023-30588), HTTP/2 implementation flaws (Rapid Reset, CVE-2023-44487 affected Node.js), and permission model bypasses. The OpenGolem trust domain model operates above the runtime layer — no application-layer control mitigates a runtime vulnerability. The requirement `"node": ">=20"` in `package.json` is a floor, not a ceiling. Running the latest LTS (Node 22.x) minimises exposure. This is a hygiene concern that the deployment documentation should address; it is not addressable in the application architecture.

**Surface 2: npm direct dependencies (package.json analysis).**

The production dependencies are:

| Package | Version | Risk surface | Assessment |
|---------|---------|--------------|------------|
| `better-sqlite3` | 11.10.0 | Filesystem access; native addon; parsing orchestrator/broker/cato audit data | **High risk surface.** Native C++ addon runs in-process. An exploit in the addon or a malicious version could execute arbitrary native code within any process that opens a database. This package has direct access to `data/audit.db`, `data/memory.db`, and all `messages.db` files. It is a single point of trust for all persistence. The pinned exact version (`11.10.0`) is good hygiene; verify this version has no known CVEs at ship time. Transitive dependencies: sqlite3 source (compiled in); no npm transitive graph of concern, but the native build chain (node-gyp, Python, C++ compiler) is a build-time supply-chain surface. |
| `cron-parser` | 5.5.0 | Parses untrusted configuration (CATO_AUDIT_INTERVAL) | **Low-medium risk.** Parses configuration strings, not user input. The input is operator-supplied configuration, not attacker-controlled in the normal threat model. ReDoS risk in cron expression parsers is known; the version should be verified as not subject to CVE-2021-23369 class issues. Exact pin is good. |
| `grammy` | ^1.39.3 | Network access (Telegram API); parsing untrusted input (Telegram payloads) | **High risk surface.** Receives and parses all inbound Telegram messages before any application-layer validation. A malicious or compromised Telegram payload is processed by Grammy before Cato or the Call Inspector see it. Grammy uses semver caret (`^1.39.3`) — will automatically consume minor and patch updates without a lockfile audit. Grammy's transitive graph includes `@grammyjs/types` (Telegram API type definitions) and an HTTP client. The semver float is a supply-chain risk: a compromised Grammy patch release would be automatically adopted on `npm install`. Grammy runs in-process with the orchestrator and has the same access as a channel adapter. |

The `devDependencies` (eslint, typescript, vitest, prettier, husky, tsx) do not run in production and are lower risk, though they execute during the build pipeline. A compromised build dependency could inject malicious code into the compiled output. `tsx` (TypeScript executor used in `dev` mode and scripts) is notable: it executes TypeScript source directly and runs in production context during development mode (`npm run dev`). The `tsx` semver float (`^4.19.0`) is a minor concern.

**Highest-risk transitive surfaces:**
- Grammy's HTTP client and WebSocket implementation: processes all inbound Telegram data before any OpenGolem validation. A zero-day in Grammy's HTTP client parsing (similar to class of issues that have affected other Node.js HTTP libraries) could be exploited by a malicious Telegram server response.
- `better-sqlite3`'s native addon: any compromise here affects all three host processes simultaneously, since all use the same SQLite database files.
- Baileys (WhatsApp): **notably absent from `package.json`** in the current v0.1 baseline, although the channel-adapters-spec covers WhatsApp. When Baileys is added (Stream F), it will be the largest transitive dependency surface: Baileys has hundreds of transitive dependencies and processes WhatsApp's binary protocol. It is a known supply-chain concern and should receive its own audit review at introduction time.

**Missing items:**
- No `package-lock.json` or `npm-shrinkwrap.json` is referenced in the repository structure (not confirmed present in this review; the git status shows no lockfile changes). If absent, `npm install` does not guarantee reproducible installs.
- No `npm audit` policy is specified.
- No CI integration for dependency scanning is specified.

**Surface 3: Agent container image.**
The container base image (referenced as `ubuntu:25.10` in ECOSYSTEM.md comparator context) and the Claude Agent SDK installed inside it are outside direct OpenGolem control. A compromised base image would affect container code, but the container trust boundary limits the impact: containers hold only derivative tokens, have no access to the audit log, and cannot communicate with the orchestrator beyond the stdout sentinel. This surface is partially mitigated by the container isolation model, but image pinning (using SHA256 digest rather than a mutable tag) is not specified.

**Spec coverage:** Fully open.

No spec in the current set addresses npm audit policy, lockfile requirements, dependency pinning, or container image pinning. The SECURITY_STRENGTHENING.md recommendation (npm audit in CI, locked lockfile, Phase 2 Rust crate minimisation objective) is not reflected in any spec or process document.

**ADR recommendation:** New ADR required. See Draft ADR Text section below (ADR-38). Note: Stream L (Supply-Chain Auditor) is commissioned for the full dependency audit. This ADR establishes the minimum policy gate — it does not replace Stream L.

---

## Prioritised Remediation Sequence

### Must be addressed before v1.0 ships

| Priority | Finding | Reason | Owner |
|---|---|---|---|
| 1 | **F-10 (npm audit policy and lockfile)** | Most likely practical attack vector; mitigations are low-friction; Stream L can only provide a full audit once basic policy infrastructure exists. | Stream L (Supply-Chain Auditor) + Stream G ADR |
| 2 | **F-2 (credential proxy binding)** | Specifying the binding posture is a one-line addition to the token-broker-spec; no implementation complexity; the risk surface is live in Phase 1. | Token Broker spec + ADR-32 |
| 3 | **F-1 (inbound transport security)** | Teams and Telegram webhook modes are active in Phase 1; payload signature verification must be a mandatory spec requirement before any adapter is shipped in webhook mode. | Channel Adapters spec + ADR-31 |
| 4 | **F-9 interim control documentation** | Decision 29 conditions the risk acceptance on documentation being in place before any MCP skill ships. This is not a new decision — it is a documentation obligation that must be discharged. | Skill Schema spec addition |
| 5 | **F-6 (inbound rate limiting)** | Cost amplification via queue flooding is exploitable in Phase 1 without any elevated access; default limits are a simple spec addition. | Orchestrator spec + ADR-35 |
| 6 | **F-5 (mid-task broker loss)** | Spec addition to orchestrator failure modes; enables Stream H to write the correct supervisor restart runbook. | Orchestrator spec addition |
| 7 | **F-8 (credential rotation)** | `rotateCredential` method is a bounded spec addition; the emergency runbook is a Stream H deliverable but requires this spec as input. | Token Broker spec + ADR-37 |
| 8 | **F-7 (self-hosted provider warning)** | Skill-schema-spec and soul-psyche-spec additions; no new ADR needed beyond ADR-36; low implementation cost. | Skill Schema spec + soul-psyche-spec + ADR-36 |

### Phase 2 commitments (scheduled, not deferred indefinitely)

| Finding | Phase 2 deliverable |
|---|---|
| **F-3 (audit log integrity)** | HMAC chain per ADR-33; spec fields reserved in Phase 1 (no data populated). Phase 2 milestone must include this as a named deliverable, not an open item. |
| **F-4 (in-process adapter isolation)** | Node.js `--permission` enforcement in production (ADR-34 Phase 1 policy layer); out-of-process adapters as Phase 2 design objective. |
| **F-10 (Rust crate minimisation objective)** | Phase 2 crate dependency graph acceptance criterion per ADR-38. |

### Already closed

No finding from F-1 through F-10 is fully closed. F-9's risk acceptance is documented (Decision 29) but the corresponding interim control is not yet implemented in any spec — it is conditionally accepted, not closed.

---

## Draft ADR Text

*The following ADR drafts are offered for PM review. Jim's approval is required before any is added to DECISIONS.md. ADR numbers 31–38 are proposed; the PM should verify sequencing against any ADRs produced by other streams.*

---

### Draft ADR-31: Inbound Channel Endpoint Authentication and Transport Binding

**Question:** What authentication and transport binding requirements apply to channel adapter inbound HTTP endpoints (Teams Bot Framework, Telegram webhook mode)?

**Decision:** Every channel adapter that receives inbound messages via an HTTP or WebSocket endpoint (as opposed to long-poll) must:
1. Bind the inbound endpoint to `127.0.0.1` (localhost) only. Exposure beyond localhost requires an explicit reverse-proxy configuration documented in the deployment runbook.
2. Verify the channel provider's payload signature on every inbound request before delivering the event to the orchestrator. For Teams (Bot Framework), this is HMAC-SHA256 verification using the Bot Framework authentication token. For Telegram in webhook mode, this is the optional `X-Telegram-Bot-Api-Secret-Token` header verification against a configured secret. Events that fail signature verification are discarded; a `message_signature_invalid` event is written to the audit log.
3. Return HTTP 401 to the caller on signature verification failure. No partial payload is delivered.

**Recommendation for default mode:** Telegram and WhatsApp adapters should default to long-poll mode (where supported), not webhook mode, to avoid the inbound HTTP surface by default. Webhook mode is an operator-enabled configuration.

**Implications:**
- channel-adapters-spec.md must add INV-N: "Adapters that receive inbound messages via an HTTP endpoint must perform payload signature verification before delivering to the orchestrator."
- Teams adapter `.intent.md` must declare `inbound_endpoint: { bind: "127.0.0.1", auth: "botframework_signature" }` (schema to be defined in the channel-adapters-spec).
- The deployment documentation must specify the reverse-proxy configuration for Teams (nginx or Caddy with TLS termination) before Teams is shipped.

---

### Draft ADR-32: Credential Proxy HTTP Binding Restriction

**Question:** What interface does the Token Broker's credential proxy HTTP server bind to, and what are the constraints on its network exposure?

**Decision:** The credential proxy HTTP server binds to the Docker bridge network interface address (default `172.17.0.1`) only. It does not bind to `0.0.0.0` or any host-external interface under any configuration. The bind address is resolved at startup by inspecting the active Docker bridge interface. If the bridge address cannot be determined (e.g. because Docker is not running or the bridge network is not configured), the broker fails closed — it does not fall back to `0.0.0.0`.

The `CREDENTIAL_PROXY_BIND_ADDRESS` environment variable overrides the resolved bridge address for deployments that use a non-standard Docker network configuration (e.g. a named Docker network, Podman, Apple Container). This is a non-secret config var and belongs in `bootstrap.ts`'s `CONFIG_KEYS` whitelist per Decision 9.

Alternative container runtimes: for Apple Container (`applecontainer run`), the equivalent host-side network interface address must be used. The deployment documentation must specify the correct bind address per supported runtime.

**Implications:**
- token-broker-spec.md must add a behavioral contract: "The credential proxy HTTP server binds to `CREDENTIAL_PROXY_BIND_ADDRESS` if set, otherwise to the resolved Docker bridge address. It never binds to `0.0.0.0`."
- If bridge address resolution fails at startup, the broker writes a fatal log entry and does not start.
- The Tester must verify: the proxy is not reachable from an IP address other than the configured bind address.

---

### Draft ADR-33: Audit Log Cryptographic Integrity — HMAC Chain (Phase 2 Commitment)

**Question:** How should the audit log be protected against OS-level tampering (row deletion, field modification, database file replacement)?

**Decision:** Phase 2 will implement a per-writer HMAC entry chain in the audit log. The implementation details are:
- Each audit log `INSERT` includes an `hmac` field (SHA-256 HMAC over the serialised row content plus the previous entry's HMAC for that writer, using a writer-specific key held in the Token Broker's credential backend).
- The HMAC key per writer is distinct. It is not stored in the audit log or in the group filesystem. It is sourced from the credential backend (same backend as LLM credentials, Decision 8).
- Cato's scheduled audit verifies the HMAC chain for the period under audit. A broken chain entry is reported as a `AUDIT_CHAIN_BREAK` anomaly finding in the hansei report.

Phase 1 reservation: the `events` table schema (audit-log-spec.md §3.1) must add a nullable `hmac TEXT` column to reserve the field before Phase 2. In Phase 1, all writes set `hmac = NULL`. Phase 2 changes the writers to populate this field; the schema is forward-compatible.

**Implications:**
- audit-log-spec.md §3.1 must add `hmac TEXT` as a nullable column to the `events` table schema.
- audit-log-spec.md §3.7 must add: "Cryptographic chain integrity (ADR-33) is required for the audit log to be treated as a tamper-evident record. The `sequence_id` gap detection is a complementary software-layer signal only."
- Cato-spec.md scheduled audit section must note: "Phase 2: verify HMAC chain integrity for the audit period. Report `AUDIT_CHAIN_BREAK` findings."
- The HMAC key provisioning mechanism must be addressed in the Token Broker spec when Phase 2 is planned.

---

### Draft ADR-34: In-Process Adapter Supply-Chain Policy

**Question:** What mitigating controls apply to in-process channel adapters given the accepted supply-chain risk (ADR-6)?

**Decision:** Three mandatory controls for Phase 1; one Phase 2 design objective.

**Phase 1 controls:**
1. **Sourcing requirement:** Channel adapter skills applied to a production deployment must be sourced from the canonical OpenGolem repository or from an administrator-audited source. The deployment documentation must state this requirement. An administrator who applies a third-party adapter skill accepts responsibility for its supply-chain risk.
2. **Node.js `--permission` flags in production:** Production deployments must launch the orchestrator process with Node.js `--permission` flags restricting filesystem access to the declared paths (`groups/`, `data/`, `SOUL.md`, `PSYCHE.md`) and network access to the declared adapter endpoints. The exact flag set is deployment documentation (Stream H). This is mandatory for production; development mode (`npm run dev`) may relax this.
3. **Audit log anomaly for undeclared outbound connections:** The `.intent.md` invariant (Skill Schema spec Invariant 1) already states no undeclared capability. The orchestrator must log a `UNDECLARED_OUTBOUND` anomaly event to the audit log when an outbound network connection from the orchestrator process targets a pattern not declared in any active skill's `.intent.md`. This requires the orchestrator to intercept or observe outbound network activity — implementation via Node.js `--permission` network restriction combined with startup-time allowlist enforcement is the recommended approach.

**Phase 2 design objective:** High-privilege channel adapters (those with `apply_permission: admin` and a large outbound endpoint set) should be candidates for out-of-process isolation with serialized IPC. The Architect should evaluate this at Phase 2 design time. It is a design objective, not a Phase 2 commitment, because the serialization cost and complexity are not yet evaluated.

**Implications:**
- Deployment documentation must include adapter sourcing guidance.
- Stream H must produce the `--permission` flag set for production launch scripts.
- Orchestrator spec must add: a `UNDECLARED_OUTBOUND` event type to the audit log and the behavioral contract for detecting and logging it.

---

### Draft ADR-35: Inbound Message Rate Limiting and Queue Depth Control

**Question:** How does the orchestrator protect against inbound message flooding (per-sender abuse, queue exhaustion, cost amplification)?

**Decision:** The orchestrator enforces two configurable limits:

1. **Per-sender rate limit:** Maximum N messages per sender (by `senderId`) per group per rolling 60-second window. Default: 10. Configurable via `INBOUND_RATE_LIMIT_PER_SENDER` (non-secret config var, Decision 9). Messages exceeding the limit are held in a per-sender cooldown queue (not dropped) for up to a configurable hold period, default 5 minutes. If still held after the hold period, they are dropped and a `message_rate_limited` audit event is written.

2. **Per-group queue depth maximum:** Maximum M pending messages in any single group's queue at any time. Default: 100. Configurable via `INBOUND_QUEUE_MAX_DEPTH` (non-secret config var, Decision 9). When a new message arrives and the group queue is at capacity, the message is dropped immediately. A `queue_depth_exceeded` audit event is written. The user is notified via the channel.

**Both limits produce audit log events** (`message_rate_limited`, `queue_depth_exceeded`) that are detectable by Cato's scheduled audit. A future dao_score KPI extension may derive an inbound anomaly rate from these events.

**No silently dropped messages:** The system must either queue, rate-hold, or explicitly drop (with audit log entry and user notification) every inbound message. Messages are never silently lost.

**Implications:**
- orchestrator-spec.md §3.2 (queue management) must add the rate limit and queue depth behavioral contract.
- audit-log-spec.md event type table must add `message_rate_limited` and `queue_depth_exceeded`.
- `INBOUND_RATE_LIMIT_PER_SENDER` and `INBOUND_QUEUE_MAX_DEPTH` must be added to `bootstrap.ts`'s `CONFIG_KEYS`.

---

### Draft ADR-36: Self-Hosted Provider Safety Posture Disclosure

**Question:** What in-product disclosure is required when an operator configures a self-hosted (Ollama or custom) LLM provider?

**Decision:** When a skill with `providers.compatible` containing `ollama` or `custom` (not `any`, not `anthropic`, not `openrouter`) is applied, the orchestrator emits an administrator-visible acknowledgement prompt: "This skill is configured for a self-hosted provider (`ollama` or `custom`). No upstream content moderation or safety filtering applies. Cato's inline checks are the complete safety envelope for calls made through this provider. Review your PSYCHE.md thresholds before deploying this skill in production. Confirm with [yes/no]." The skill is not applied until the administrator explicitly confirms.

This acknowledgement is a one-time event per skill ID, not per invocation. It is logged to the audit log as a `skill_safety_acknowledged` event with `provider_type` and `skill_id`.

PSYCHE.md must include a section `Self-Hosted Provider Posture` specifying that when a self-hosted provider is the active provider for any group: (a) the scheduled audit interval should be reviewed against the default (6 hours); for high-volume deployments with local models, 1–2 hours is recommended; and (b) Cato's block thresholds should be verified before production use.

**Implications:**
- skill-schema-spec.md must add the acknowledgement flow to the behavioral contract.
- soul-psyche-spec.md must add `Self-Hosted Provider Posture` as a required PSYCHE.md section.
- audit-log-spec.md must add `skill_safety_acknowledged` event type.

---

### Draft ADR-37: Credential Rotation Behavior

**Question:** What does the Token Broker do when a long-lived credential is rotated, and what is the emergency rotation procedure?

**Decision:** Three behaviors are required:

1. **Planned rotation (polling):** The Token Broker re-reads the active credential backend on a configurable interval (default: 5 minutes, configurable via `CREDENTIAL_POLL_INTERVAL`, non-secret config var per Decision 9). If the credential has changed, the broker updates its in-process credential reference. In-flight derivative tokens issued before the rotation remain valid for their declared TTL — they bear the old credential value injected at forward time. New tokens issued after the poll cycle use the new credential. No restart is required for planned rotation.

2. **Emergency rotation (`rotateCredential` RPC):** A new JSON-RPC method `rotateCredential` is defined on the token lifecycle socket (`data/sockets/broker.sock`). The Orchestrator calls this method on administrator request (via the remote-control surface or a CLI command). Parameters: `{ "force_revoke_all": true | false }`. On `force_revoke_all: true`, the broker immediately re-reads the backend and revokes all currently active tokens. Running containers receive HTTP 403 on their next proxied call. The orchestrator detects mid-task token invalidation (via the existing fail-closed posture) and tears down the affected containers, logging `container_teardown` with `reason: emergency_rotation`. On `force_revoke_all: false`, only the backend is re-read; no active tokens are revoked.

3. **Backend re-read failure:** If the broker cannot read the backend during a poll cycle (backend unreachable), it retains the last-known credential and logs a `credential_backend_unreachable` audit event. It does not clear the credential or invalidate tokens. The next poll cycle will retry. This is fail-retain for planned rotation; emergency rotation failures fail-closed (if the backend cannot be read, `rotateCredential` returns an error and no tokens are revoked).

**Implications:**
- token-broker-spec.md must add `rotateCredential` to the external interface and behavioral contract.
- Stream H (DevOps) must produce an emergency rotation runbook that calls this method, with time-to-rotation targets per backend type.
- `CREDENTIAL_POLL_INTERVAL` must be added to `bootstrap.ts`'s `CONFIG_KEYS`.
- audit-log-spec.md must add `credential_backend_unreachable` and `emergency_rotation_executed` event types.

---

### Draft ADR-38: Phase 1 Dependency Audit Policy and Phase 2 Crate Minimisation Objective

**Question:** What is the minimum dependency governance policy for the Phase 1 npm baseline, and what is the Phase 2 Rust crate minimisation requirement?

**Decision:** Two parts.

**Part 1 — Phase 1 npm policy:**
1. A `package-lock.json` must be committed and kept up to date. All installs in CI and production use `npm ci` (not `npm install`) to enforce lockfile reproducibility.
2. `npm audit` must run in CI on every commit. The CI gate policy is: zero high-severity findings. Medium-severity findings produce a warning and must be reviewed within 14 days. Low-severity findings are logged but do not block CI.
3. Before v1.0 ships, Stream L (Supply-Chain Auditor) must produce a dependency audit report (`docs/security/dependency-audit.md`) reviewing every direct production dependency against the risk surface classification in this ADR (F-10).
4. When Baileys (WhatsApp) is added as a dependency (Stream F), it must receive its own Supply-Chain Auditor review before the WhatsApp adapter is enabled in any production deployment.
5. The agent container base image must be pinned by SHA256 digest, not by mutable tag. The pinned digest must be recorded in `container/build.sh` and updated only via an explicit, reviewed commit.

**Part 2 — Phase 2 Rust crate minimisation:**
The Rust rewrite specification must include an explicit dependency minimisation objective as an acceptance criterion alongside functional correctness. Concretely: the target crate graph for each Phase 2 component must be defined before implementation begins, and each direct crate dependency must have a documented justification. The Supply-Chain Auditor (Stream M) must review the target graph before development starts.

The motivation for the Rust rewrite is formally extended to include supply-chain risk reduction, not only performance and auditability (per SECURITY_STRENGTHENING.md F-10 recommendation). DECISIONS.md Decision 7 must be updated to reflect this.

**Implications:**
- A `package-lock.json` must be created and committed before v1.0 ships.
- CI pipeline (not yet defined) must include `npm ci` and `npm audit --audit-level=high`.
- Stream L is the authoritative process for the full audit; this ADR is the minimum gate.
- Phase 2 planning documentation must add crate minimisation as a named acceptance criterion.

---

*End of Stream G — Cybersecurity Specialist Report.*
*Status: Awaiting PM approval. No existing file has been modified. This report is a read-and-recommend artifact — findings become actionable only after Jim's review and approval.*
