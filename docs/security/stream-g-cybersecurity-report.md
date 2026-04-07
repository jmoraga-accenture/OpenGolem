# Stream G — Cybersecurity Specialist Report (v2)
*Status: Approved | Produced: 2026-04-06 | Supersedes: v1 (four-channel scope)*
*Inputs: ARCHITECTURE.md v1.0, SECURITY_STRENGTHENING.md, DECISIONS.md (Decisions 1–30), docs/specs/token-broker-spec.md, docs/specs/orchestrator-spec.md, docs/specs/channel-adapters-spec.md, docs/specs/audit-log-spec.md, docs/specs/cato-spec.md, docs/specs/skill-schema-spec.md, docs/specs/soul-psyche-spec.md, package.json*

---

## Scope Note

The v1 report (2026-04-06, same date) was written against a four-channel scope: TUI, Telegram, Teams, and WhatsApp. Decision 30 (recorded in DECISIONS.md) subsequently confirmed that v1.0 ships with TUI and Telegram only; Teams and WhatsApp are deferred to optional add-on skills. This materially changes the inbound attack surface: the Teams Bot Framework inbound HTTP endpoint (the primary subject of F-1 in the v1 report) does not exist in v1.0, and the WhatsApp Baileys WebSocket and its substantial transitive dependency graph (the largest npm surface noted in F-10) are also absent from the v1.0 host process. This report re-assesses all ten findings against the current v1.0 scope. Where scope reduction closes or downgrades a finding, this is stated explicitly. The v1 report is superseded in full; all findings should be tracked against this document going forward.

---

## Executive Summary

OpenGolem's trust domain model, Unix socket IPC, derivative token architecture, and Cato oversight layer provide a structurally sound security foundation that is meaningfully stronger than a conventional single-process assistant. The scope reduction to TUI and Telegram only is also a meaningful security improvement: it removes the Teams inbound HTTP endpoint (the single largest inbound network attack surface in v1) and eliminates the Baileys transitive dependency graph (the largest supply-chain surface in v1).

Five findings remain fully open in the current specifications; three are partially addressed; two are effectively closed or materially reduced by scope change. The highest-consequence unresolved gaps before v1.0 ships are: the credential proxy HTTP binding is unspecified (F-2), there is no inbound message rate limiting (F-6), the F-9 interim control from Decision 29 is not written into any behavioral spec, and the npm dependency surface has no specified audit or lockfile policy (F-10). The audit log has no cryptographic integrity protection (F-3), which is the most consequential long-term governance gap; it is correctly sequenced for Phase 2 but an ADR and schema reservation are needed now.

The removal of Teams reduces F-1 from High to Low for the default long-poll deployment mode, and removes the Baileys supply-chain risk from F-10 as an immediate concern. These are genuine security improvements, not just scope reductions.

---

## Finding Reviews

---

### F-1 — Inbound Transport Security Is Unspecified

**Original severity:** High
**Confirmed severity:** Low (long-poll mode) / Medium (webhook mode)
**Scope change impact:** Significant. The v1 finding was primarily about the Teams Bot Framework inbound HTTP endpoint, which is a mandatory TCP listener that must be exposed to the internet for Teams to function. That endpoint does not exist in v1.0. The remaining inbound surface is Telegram only, and Telegram's official SDK (Grammy) defaults to long-poll (`getUpdates`), which involves no inbound TCP listener at all. Webhook mode is an operator-opted deployment variant. This reduces F-1 from a mandatory High-severity gap to a conditional Medium that only materialises when the operator enables webhook mode.

**Threat narrative:**

*Long-poll mode (Grammy default):* The Telegram adapter polls `api.telegram.org` for updates. There is no inbound TCP listener on the host. No adversary can inject messages into the system by sending packets to the host — there is no port to target. The only inbound surface is the TUI adapter, which reads from stdin on the local terminal. This surface is not reachable by network adversaries. In long-poll mode, F-1 is effectively closed by the absence of an inbound endpoint.

*Webhook mode (operator-enabled variant):* If the operator configures Grammy in webhook mode, the adapter binds an inbound HTTPS endpoint (typically via a reverse proxy) to receive Telegram `Update` objects pushed by Telegram's servers. Without `X-Telegram-Bot-Api-Secret-Token` header verification, any party with knowledge of the webhook URL can POST crafted `Update` objects to the host. The Telegram adapter's current behavioral spec (channel-adapters-spec.md) does not require signature verification before delivering the event to the orchestrator. A crafted payload would pass directly into the inbound message queue. The sender allowlist provides a downstream gate, but it does not prevent the inbound event from consuming queue capacity and triggering orchestrator processing before the allowlist check fires.

**Spec coverage:** Partially addressed for long-poll; fully open for webhook.

The channel-adapters-spec.md correctly documents Telegram as using "long-poll `getUpdates` or webhook; adapter choice is a deployment configuration." It provides the Telegram `.intent.md` template declaring only `https://api.telegram.org/*` as an outbound endpoint — consistent with long-poll. No spec text requires or recommends long-poll as the default posture. No spec text requires `X-Telegram-Bot-Api-Secret-Token` verification for webhook mode. ARCHITECTURE.md §4.1 notes the inbound path is "channel-native" with no transport security requirements stated.

**ADR recommendation:** This finding can be substantially closed with a spec addition rather than a full new ADR. The channel-adapters-spec.md must add:

1. A behavioral contract clause: "The Telegram adapter default deployment mode is long-poll (`getUpdates`). Webhook mode is an operator-enabled variant that requires additional configuration."
2. An invariant: "INV-10: When a channel adapter is configured in webhook mode (receives inbound push from the channel provider), it must verify the channel provider's payload signature on every inbound request before delivering the event to the orchestrator. For Telegram webhook mode, this is `X-Telegram-Bot-Api-Secret-Token` header verification. Events that fail signature verification are discarded; a `message_signature_invalid` event is written to the audit log. The adapter returns HTTP 401 to the caller on verification failure."

A new ADR (Draft ADR-31, below) is still recommended to record the architectural decision that long-poll is the secure default posture and that webhook mode requires explicit operator opt-in with signature verification enabled. This closes the finding for the v1.0 scope and provides the correct foundation when Teams and WhatsApp are added as optional skills.

---

### F-2 — Credential Proxy HTTP Binding Is Unspecified

**Original severity:** High
**Confirmed severity:** High
**Scope change impact:** None. The credential proxy binding issue is independent of channel scope. All containers make outbound LLM calls through the proxy regardless of which channels are enabled.

**Threat narrative:**
The Token Broker binds an HTTP endpoint that agent containers call as their `ANTHROPIC_BASE_URL`. If this proxy binds to `0.0.0.0` — or any host-external interface — then any process on the host with network access to that port can present a derivative token and make proxied LLM calls. This includes: a compromised npm package running in the orchestrator process, another container on the same Docker host sharing the bridge network, or a lateral-movement attacker who has obtained a shell on the host as a different user.

The derivative token model is the primary defence, but token theft is not required if the proxy is reachable from processes that already hold tokens by design (e.g. a compromised orchestrator process that can read in-process token references). Binding to the Docker bridge interface only confines the surface to the containers the orchestrator has spawned, which is the intended threat model: only OpenGolem containers should be able to reach the proxy.

An additional concern applies to the Ollama path: the token-broker-spec correctly notes that Ollama calls receive no injected credential (the call is forwarded with no Authorization header substitution). If the proxy binds broadly, a caller with no valid token at all can potentially route Ollama calls through the proxy, bypassing the Call Inspector on the Ollama path — because Ollama itself requires no auth, the only gate is the proxy's token validation. Restricting the binding closes this gap at the network layer.

**Spec coverage:** Fully open.

The token-broker-spec.md §4.5 describes the container-to-proxy protocol (HTTP, derivative token as bearer) and the five Call Inspector checks, but does not specify what interface the HTTP server binds to. ARCHITECTURE.md §4.5 states containers "call TD-BROKER via HTTP (credential proxy)" with no binding posture stated. No ADR addresses this.

**ADR recommendation:** New ADR required (Draft ADR-32, below). The token-broker-spec must gain a behavioral contract clause specifying the proxy binds to the Docker bridge interface only and fails closed if the bridge address cannot be determined.

---

### F-3 — Audit Log Has No Cryptographic Integrity Protection

**Original severity:** High
**Confirmed severity:** High (Phase 2 commitment required now; schema reservation required before Phase 1 ships)
**Scope change impact:** None. The audit log integrity concern is independent of channel scope.

**Threat narrative:**
The audit log is Cato's sole data source for dao_score KPIs and hansei reports. An adversary with access to the SQLite file on the host filesystem — whether via a compromised service account, a rogue administrator, or a process that has escalated to the service user — can modify records directly, bypassing the application-layer INSERT-only semantics entirely. The most consequential manipulation is selective deletion of `call_blocked` and `cato_check` block events, which suppresses `security_failures_per_call` and causes Cato's scheduled audit to report a healthier posture than reality. This is not a theoretical concern: the governance story for OpenGolem depends entirely on the integrity of what Cato reads.

The `sequence_id` monotonicity contract in the audit-log-spec (§3.7, I-8) provides per-writer gap detection: a deleted row would produce a sequence gap detectable at the next audit. However, sequence IDs reset on process restart (the spec explicitly notes "the counter starts at 1 on process startup and is never persisted"). A complete database file replacement after a restart, or selective row manipulation between scheduled audit runs, is therefore undetectable. Field-level modification (changing `outcome` from `blocked` to `allowed` on existing rows while preserving row count and sequence values) is also undetectable with sequence IDs alone.

**Spec coverage:** Partially addressed.

The audit-log-spec.md correctly specifies INSERT-only write paths, a build-time check against UPDATE/DELETE (I-2), WAL mode (I-3), and `sequence_id` monotonicity (I-8). These are meaningful software-layer controls. The spec explicitly notes "no cryptographic integrity mechanism" — the gap is acknowledged, not overlooked. The SECURITY_STRENGTHENING.md HMAC chain recommendation is not reflected in any spec. The `sequence_id` contract section (§3.7) does not contain a caveat noting the limits of sequence gap detection.

**ADR recommendation:** New ADR required (Draft ADR-33, below). The ADR must be produced now so that the audit-log-spec can reserve the `hmac` column in Phase 1 (nullable, all writes set NULL) and the Cato spec can plan Phase 2 chain verification. The audit-log-spec §3.7 sequence_id documentation must also gain a caveat noting that sequence gap detection is a software-layer signal only and does not protect against OS-level file replacement or field-level modification.

---

### F-4 — In-Process Adapter Supply-Chain Risk Is Accepted Without Mitigation Controls

**Original severity:** High
**Confirmed severity:** Medium (downgraded from v1 report; scope change materially reduces the risk surface)
**Scope change impact:** Significant for the immediate risk assessment. The v1 report correctly noted that Grammy, Baileys, and their transitive dependencies all execute in-process with the orchestrator. Baileys is the larger supply-chain concern: it has hundreds of transitive dependencies and processes a binary protocol. Removing WhatsApp from v1.0 scope means Baileys is not present in the production dependency graph. Grammy remains, but it is a substantially smaller transitive surface. The finding is not closed — the structural risk of in-process adapters is unchanged — but the immediate blast radius is reduced by the absence of Baileys.

**Threat narrative:**
The Telegram adapter (Grammy) runs in-process with the orchestrator. Any zero-day or supply-chain compromise in Grammy or its transitive dependencies (`@grammyjs/types`, Grammy's HTTP client) executes within TD-ORCHESTRATOR. A compromised in-process adapter has access to all in-process state: the token store reference, Unix socket file descriptors, group filesystem paths, and the in-process audit log write path.

Grammy currently uses a semver caret (`^1.39.3`) in package.json, meaning it automatically adopts minor and patch updates on `npm install`. A compromised Grammy patch release would be automatically adopted without a lockfile audit. The documented OpenClaw/ClawHub exfiltration incident demonstrates this vector is actively exploited in the agentic assistant ecosystem.

The TUI adapter has no external protocol dependency and presents a negligible supply-chain risk. The risk is concentrated in Grammy.

**Spec coverage:** Partially addressed.

The channel-adapters-spec.md acknowledges the structural risk (ADR-6 acceptance) and requires `apply_permission: admin`. Invariant 9 correctly places the adapter in TD-ORCHESTRATOR with inbound data from TD-CHANNEL treated as untrusted. The `.intent.md` endpoint declaration requirement provides audit accountability for declared outbound connections.

The gaps: no spec restricts adapter sourcing to the canonical repository; no spec mandates Node.js `--permission` flags in production; no spec requires that Grammy's semver float be locked before shipping v1.0.

**ADR recommendation:** This finding should be addressed at two layers. First, the lockfile gap (Grammy `^1.39.3` floating) is addressable immediately and should be addressed as part of the F-10 supply-chain ADR (ADR-38). Second, a deployment policy ADR (Draft ADR-34, below) specifies: (a) adapter sourcing requirements, (b) Node.js `--permission` flags as mandatory for production, and (c) undeclared outbound connections from the orchestrator process as a loggable anomaly. Moving adapters out-of-process is a Phase 2 design objective, not a v1.0 requirement.

---

### F-5 — Token Store Crash Leaves Orphaned Containers

**Original severity:** Medium
**Confirmed severity:** Medium
**Scope change impact:** None. Token store behaviour is independent of channel scope.

**Threat narrative:**
The Token Broker's in-memory token store does not persist across restarts (intentional, per Decision 16). A container running when the broker crashes holds a token the broker no longer recognises. Its next proxied call returns HTTP 403. The container cannot complete its work but remains alive, consuming resources and holding filesystem write locks on the group directory, until its TTL expires.

The orchestrator's current failure-handling spec (Decision 6, ARCHITECTURE.md §1.3) covers broker-unreachable at task-start: pending messages are queued and no new containers are spawned. It does not address mid-task broker loss: what happens to containers already running when the broker socket goes down. The gap: stranded containers are not torn down promptly; their in-progress filesystem writes may produce inconsistent partial state in the group directory; and the audit trail for a container that was running during broker loss may be incomplete.

A more targeted attack: an adversary who can crash-loop the broker (via resource exhaustion of the broker process) can repeatedly strand running containers, creating a progressive resource accumulation attack that degrades the host without the orchestrator ever knowingly failing to start a task.

**Spec coverage:** Partially addressed.

The orchestrator-spec.md failure modes table covers token broker unreachable at dispatch time. It does not contain a "mid-task broker loss" entry. No polling mechanism for mid-task broker health is specified. Decision 6 does not address mid-task loss.

**ADR recommendation:** This can be closed with an orchestrator-spec addition rather than a new ADR. The orchestrator-spec.md failure modes table must add: "Token Broker socket unavailable for a running task (mid-task broker loss): The orchestrator detects loss on a 5-second polling interval during active tasks. On detected loss: (a) force-teardown all active containers immediately; (b) attempt to revoke their tokens via the socket — if the socket is unavailable, log the revocation obligation as unmet with a `container_teardown` event recording `reason: broker_loss` and `revocation_status: unenforceable`; (c) queue the interrupted task's originating message for retry when the broker recovers. Containers are never left running past a detected broker loss." A supervisor restart policy (systemd `RestartSec=2` for the broker process) is a DevOps/Stream H concern, but this spec addition is the architectural prerequisite for Stream H to document the correct restart procedure.

---

### F-6 — No Inbound Message Rate Limiting

**Original severity:** Medium
**Confirmed severity:** Medium (escalated context note: direct financial impact via API cost amplification)
**Scope change impact:** Marginal. Long-poll mode slightly reduces the attack surface for synthetic event injection (an attacker must compromise the Telegram adapter's connection or an allowlisted account rather than posting to an open HTTP endpoint), but the fundamental risk — a compromised allowlisted account or a compromised adapter that synthesises events — is unchanged. Queue flooding is still exploitable.

**Threat narrative:**
The orchestrator's per-group message queue accepts messages without bound (orchestrator-spec.md §3.2 specifies one-active-task-per-context concurrency control, not a queue depth cap). Each queued message will eventually trigger a container spawn with associated CPU, memory, and API credit consumption. A sender who can inject N messages into the queue has triggered N LLM API calls at the operator's expense.

The sender allowlist (TELEGRAM_VALID_USERS, group allowlists) mitigates this for identifiable bad actors known in advance. It does not mitigate: a compromised allowlisted account, a user who has not yet been identified as malicious and abuses their access, or a compromised Grammy adapter that synthesises `InboundMessage` objects with arbitrary sender IDs before allowlist checking occurs. The channel-adapters-spec explicitly states that adapters do not gate on sender identity — the orchestrator applies that check after delivery.

For an LLM-backed assistant, this is also a financial risk: there is no upper bound on how much an attacker who controls an allowlisted sender identity can spend at the operator's expense.

**Spec coverage:** Fully open.

The orchestrator-spec.md §3.2 specifies only one-active-task-per-context concurrency control. No per-sender rate limit, queue depth maximum, or back-pressure mechanism is specified. The dao_score KPI set (Decision 5) does not include an inbound anomaly metric. The SECURITY_STRENGTHENING.md recommendation is not reflected in any spec.

**ADR recommendation:** New ADR required (Draft ADR-35, below). The orchestrator-spec must gain a behavioral contract section for queue management covering per-sender rate limits and per-group queue depth caps. Both must produce audit log events detectable by Cato's scheduled audit.

---

### F-7 — Self-Hosted Model Deployments: Safety Posture Gap Is Underdocumented

**Original severity:** Medium
**Confirmed severity:** Medium
**Scope change impact:** None. The self-hosted model safety gap is independent of channel scope.

**Threat narrative:**
An operator who configures Ollama or a `custom` provider receives no in-product signal that their safety posture has changed materially. Anthropic's cloud API applies independent content moderation and safety filtering; a self-hosted Ollama instance applies none. In Phase 1, where Cato's inline checks are deterministic stubs (path traversal and oversized payload), the Phase 1 safety envelope for a self-hosted deployment is: Cato's two deterministic checks, the Call Inspector's five checks, and Alef's character-based assertiveness. There is no upstream backstop.

The cato-spec.md correctly documents the "prima-facie / anti-mind-reading" principle in its Phase 2 LLM escalation section — Cato's evaluator should read payload content charitably and not speculate about intent. This is the right posture for a Phase 2 LLM evaluator, but it does not help in Phase 1 where the LLM path is not yet wired. A self-hosted operator who reads the cato-spec would see a Phase 2 promise of thoughtful LLM oversight; they would not see a clear statement that in Phase 1 they are running on deterministic stubs only with no upstream content moderation.

**Spec coverage:** Partially addressed.

The token-broker-spec correctly specifies that Ollama calls receive no injected credential (AC-11) and ARCHITECTURE.md §3.0 correctly documents that Cato's inline `allow: false` is unconditional regardless of provider. Neither the skill-schema-spec, the soul-psyche-spec, nor deployment documentation contains the explicit warning that SECURITY_STRENGTHENING.md recommends.

**ADR recommendation:** This finding can be partially closed by spec additions rather than a full new ADR. Three additions are required: (1) skill-schema-spec behavioral contract must add an administrator acknowledgement prompt for self-hosted provider skills; (2) soul-psyche-spec (PSYCHE.md schema) must add a required section on self-hosted provider posture; (3) a "Safety posture by provider" table in deployment documentation. A new ADR (Draft ADR-36, below) records the architectural decision that the operator-visible acknowledgement is the governing mechanism, and that Cato's inline checks are the documented floor for all providers in Phase 1.

---

### F-8 — No Credential Rotation Procedure

**Original severity:** Medium
**Confirmed severity:** Medium
**Scope change impact:** None. Credential rotation is independent of channel scope.

**Threat narrative:**
The Token Broker holds the long-lived Anthropic API key or OAuth token in-process after loading from the configured backend. If this credential is compromised — via a `.env` file accidentally committed to version control (a common incident), a Bitwarden vault breach, or a memory disclosure from the broker process — the operator must rotate it. The current specs provide no guidance on: whether the broker reloads the backend without a restart, what happens to in-flight derivative tokens when the underlying credential changes, or what the emergency procedure is.

Worst case: an operator discovers a potential key leak, updates their Bitwarden vault, and believes they are now safe. The broker continues using the old key from memory until it is restarted. In-flight containers continue using derivative tokens derived from the old key. The leaked key remains valid and exploitable. The operator has no in-product path to force an immediate broker re-read without a full service restart, and a full restart tears down all active containers — which the operator may not know is the correct emergency procedure.

**Spec coverage:** Fully open.

The token-broker-spec specifies credential backend resolution at startup and derivative token issuance/revocation. It does not specify credential re-read, emergency rotation, or a `rotateCredential` method. Decision 8 defines the three backends but does not address rotation. No ADR covers rotation behavior.

**ADR recommendation:** New ADR required (Draft ADR-37, below). The token-broker-spec must gain: (a) a `rotateCredential` JSON-RPC method triggering immediate backend re-read and optional mass revocation of in-flight tokens; (b) a planned rotation polling behavior (credential changes take effect within a configurable interval without restart); (c) deployment documentation and Stream H runbook must include an emergency rotation procedure.

---

### F-9 — MCP Permission Tier Enforcement Is Phase 2 With No Interim Controls

**Original severity:** Medium
**Confirmed severity:** Medium (risk acceptance confirmed; interim control gap confirmed — unchanged from v1 report)
**Scope change impact:** None. MCP permission tier enforcement is independent of channel scope.

**Threat narrative:**
The `.intent.md` schema requires `min_permission_tier` per MCP server entry, and the skill-schema-spec validates this field as required (AC-3f). However, enforcement of the field at call time — verifying that the triggering user's permission tier meets or exceeds the declared minimum — is deferred to Phase 2. During Phase 1, any user who can send a message to a group where an MCP-declaring skill is active can trigger MCP calls to declared endpoints regardless of whether their permission tier would authorise those calls.

The bounds of this risk: the MCP server must be administrator-applied, the endpoint must be in the Call Inspector's constraint list (registered via `registerSkillScope`), and the Call Inspector enforces endpoint scope. The concern is not unconstrained access — it is that administrator approval of the skill does not imply per-user per-call authorisation, and that constraint is invisible in Phase 1.

**Spec coverage: the interim control from Decision 29 is confirmed absent from all behavioral specs.**

Decision 29 records PM risk acceptance with the following explicit condition: "MCP-declaring skills are restricted to administrator-only groups until Phase 2 permission tier enforcement is implemented. This must be stated as explicit deployment guidance in the documentation, not left implicit."

Checking all relevant specs confirms the gap is unchanged from v1:

- skill-schema-spec.md validates `min_permission_tier` as a required field (AC-3f) but contains no behavioral clause stating that MCP-declaring skills must only be applied to administrator-only groups, no administrator warning at application time, and no reference to Decision 29's conditions.
- orchestrator-spec.md, channel-adapters-spec.md, and soul-psyche-spec.md contain no reference to the MCP permission tier limitation or the admin-only restriction.
- No deployment documentation currently carries the required warning.

The risk acceptance recorded in Decision 29 is **conditional** on the interim control being documented. That condition has not been met. Any MCP-declaring skill published before this gap is closed violates the conditions of Decision 29.

**ADR recommendation:** Decision 29 is already the governing record. No new ADR is needed. The required action is a specific spec addition. The skill-schema-spec.md behavioral contract (On skill application section) must add: "When a skill has a non-empty `mcp.servers` list, the orchestrator must surface an administrator-visible warning at application time: 'This skill declares MCP servers. Permission tier enforcement (`min_permission_tier`) is parsed and stored but is not enforced at call time in Phase 1 (see Decision 29). This skill must only be applied to administrator-only groups until Phase 2 permission tier enforcement is implemented.' The administrator must explicitly confirm before the skill is applied. The confirmation is logged to the audit log as a `skill_mcp_warning_acknowledged` event with `skillId` and `timestamp`."

This single clause is the spec-level implementation of Decision 29's interim control. It must be in place before any MCP-declaring skill is published.

---

### F-10 — External Dependency Surface Is an Unaddressed Systemic Risk

**Original severity:** High
**Confirmed severity:** High (moderately reduced by scope change; Baileys is absent, which removes the largest transitive surface)
**Scope change impact:** Moderate. The v1 report noted Baileys as the largest transitive dependency surface — hundreds of dependencies processing a binary protocol — and flagged its addition as warranting its own audit review. Baileys is not in the v1.0 `package.json` and is not in scope. This reduces the immediate risk materially. However, Grammy's semver float (`^1.39.3`) remains, better-sqlite3's native addon remains, and the absence of a lockfile or npm audit policy remains fully open.

**Threat narrative — three surfaces assessed separately:**

**Surface 1: Node.js runtime.**
All host-side processes (orchestrator, Token Broker, Cato) run in Node.js. Any V8 or libuv vulnerability is unconditionally inherited below the application layer. OpenGolem's trust domain model and Call Inspector gates do not apply below the runtime. Node 20 is the minimum per `package.json`; Node 22 LTS is the current stable release. Running the latest LTS minimises exposure. This is a hygiene concern addressed by deployment documentation — it is not fixable in the application architecture.

**Surface 2: npm direct and transitive dependencies (v1.0 package.json analysis).**

| Package | Pinning | Risk surface | Assessment |
|---------|---------|--------------|------------|
| `better-sqlite3` `11.10.0` | Exact pin | Native C++ addon; in-process with all three host processes; parses all SQLite files including `data/audit.db` | **High concern.** The exact pin is correct hygiene. A native addon exploit executes native code in all three processes simultaneously and has direct read/write access to the audit log and all group message databases. Verify `11.10.0` has no known CVEs at ship time. The native build chain (node-gyp, Python, C++) is a build-time supply-chain surface. |
| `cron-parser` `5.5.0` | Exact pin | Parses `CATO_AUDIT_INTERVAL` configuration string | **Low concern.** Operator-supplied configuration, not attacker-controlled in the normal threat model. Exact pin is correct. ReDoS class issues have affected cron parsers; verify the version. |
| `grammy` `^1.39.3` | Semver caret — **floats** | Receives and parses all inbound Telegram messages before any application validation; runs in-process with the orchestrator | **High concern.** The semver float is the primary actionable gap: a compromised Grammy patch release is automatically adopted on `npm install`. Grammy's transitive graph includes `@grammyjs/types` and an HTTP client. Grammy is also the entry point for all untrusted Telegram payload data before Cato or the Call Inspector see it. **The `^` must be replaced with an exact pin before v1.0 ships.** |

**Missing lockfile:** A `package-lock.json` is not confirmed present in the repository (git status shows no lockfile changes). Without a lockfile, `npm install` does not guarantee reproducible installs. Any `npm install` on a fresh clone can produce a different dependency tree from what was tested.

**Missing npm audit policy:** No spec, no CI configuration, and no process document specifies that `npm audit` should be run or that a zero-high-severity policy is enforced. A high-severity vulnerability in any direct or transitive dependency has no detection gate before reaching production.

**Surface 3: Agent container image.**
The container base image and Claude Agent SDK installed inside are outside direct OpenGolem control. The container isolation model limits the impact: containers hold only derivative tokens, cannot write to the audit log, and cannot communicate with the orchestrator beyond the stdout sentinel. Image pinning by SHA256 digest (rather than mutable tag) is not specified, meaning a base image update could introduce a regression silently.

**Spec coverage:** Fully open.

No spec in the current set addresses npm audit policy, lockfile requirements, dependency version pinning, container image pinning, or supply-chain scanning. SECURITY_STRENGTHENING.md recommendations are not reflected in any spec or process document.

**ADR recommendation:** New ADR required (Draft ADR-38, below). Immediate actions before v1.0 ships: Grammy `^` changed to exact pin; `package-lock.json` committed; `npm audit --audit-level=high` enforced (zero tolerance for high/critical). Phase 2: explicit Rust crate dependency minimisation objective. Container image SHA256 pinning is deployable now and should be addressed in the container build scripts.

---

## Prioritised Remediation Sequence

### Must be addressed before v1.0 ships

| Priority | Finding | Action required | Owner |
|---|---|---|---|
| 1 | **F-9 interim control** | Add MCP warning clause to skill-schema-spec.md. This is the condition on which Decision 29's risk acceptance is contingent. No MCP skill may ship without it. | Stream G spec addition (immediate) |
| 2 | **F-10 (lockfile + Grammy pin + npm audit)** | Pin Grammy to exact version; commit `package-lock.json`; add `npm audit --audit-level=high` to CI. These are low-friction, high-impact mitigations. | Stream L (Supply-Chain Auditor) + Stream G ADR-38 |
| 3 | **F-2 (credential proxy binding)** | One-clause addition to token-broker-spec; no implementation complexity; risk surface is live in Phase 1. | Token Broker spec + ADR-32 |
| 4 | **F-6 (inbound rate limiting)** | Queue flooding is exploitable without elevated access; default limits prevent cost amplification attacks. Spec addition to orchestrator-spec. | Orchestrator spec + ADR-35 |
| 5 | **F-1 (Telegram webhook signature verification)** | Add INV-10 to channel-adapters-spec requiring signature verification when webhook mode is enabled. Long-poll mode is already safe by absence of inbound endpoint. | Channel Adapters spec + ADR-31 |
| 6 | **F-5 (mid-task broker loss)** | Orchestrator-spec failure modes table addition. Enables Stream H to write the correct supervisor restart runbook. | Orchestrator spec addition |
| 7 | **F-8 (credential rotation)** | `rotateCredential` method is a bounded spec addition; emergency runbook is a Stream H deliverable but requires this spec as input. | Token Broker spec + ADR-37 |
| 8 | **F-7 (self-hosted provider disclosure)** | Skill-schema-spec and soul-psyche-spec additions; low implementation cost; responsible AI obligation. | Skill Schema spec + soul-psyche-spec + ADR-36 |

### Phase 2 commitments (scheduled, not deferred indefinitely)

| Finding | Phase 2 deliverable |
|---|---|
| **F-3 (audit log integrity)** | HMAC chain per ADR-33; `hmac` column reserved in Phase 1 schema (all writes NULL in Phase 1). Phase 2 milestone must include this as a named deliverable. |
| **F-4 (in-process adapter isolation)** | Node.js `--permission` enforcement per ADR-34 (Phase 1 deployment policy); out-of-process adapters as Phase 2 design objective when Teams/WhatsApp are added. |
| **F-10 (Rust crate minimisation)** | Phase 2 crate dependency graph acceptance criterion per ADR-38. |

### Closed or materially reduced by scope change (Decision 30)

| Finding | Status |
|---|---|
| **F-1 (Teams inbound HTTP endpoint)** | Closed for the specific Teams Bot Framework inbound HTTP threat. The finding is re-framed as a conditional Medium for Telegram webhook mode. |
| **F-10 (Baileys transitive graph)** | Materially reduced: Baileys is not in the v1.0 dependency graph. When WhatsApp is added as an optional skill, Baileys introduction requires a dedicated supply-chain review at that time, per ADR-38. |

### Confirmed fully open (no spec coverage in current documents)

F-2, F-6, F-8, F-9 (interim control), F-10 (lockfile, npm audit policy, Grammy pin, container image pinning).

---

## Draft ADR Text

*The following ADR drafts are offered for PM review. Jim's approval is required before any is added to DECISIONS.md. ADR numbers 31–38 are proposed; the PM should verify sequencing against any ADRs produced by other streams in the same session.*

---

### Draft ADR-31: Inbound Channel Endpoint Authentication and Deployment Mode Policy

**Question:** What transport security and authentication requirements apply to channel adapter inbound endpoints? What is the required default deployment mode for Telegram?

**Decision:**

1. **Default mode is long-poll.** The Telegram adapter default deployment mode is long-poll (`getUpdates`). Long-poll creates no inbound TCP listener and presents no inbound network attack surface. This is the required default for v1.0.

2. **Webhook mode is an operator opt-in.** Webhook mode is a supported variant but requires explicit operator configuration. It is not enabled by default. Operators who enable webhook mode accept responsibility for correct reverse-proxy configuration.

3. **Signature verification is mandatory for webhook mode.** Any channel adapter configured in webhook mode must verify the channel provider's payload signature on every inbound request before delivering the event to the orchestrator. For Telegram webhook mode, this is `X-Telegram-Bot-Api-Secret-Token` header verification against a configured secret. Events that fail verification are discarded; a `message_signature_invalid` event is written to the audit log. The adapter returns HTTP 401 to the caller on verification failure. No partial event is delivered.

4. **This policy extends to future channel adapters.** When Teams and WhatsApp are added as optional skills, the same policy applies: any adapter that receives inbound push from a channel provider must implement the provider's signature verification scheme before v1.0-quality shipment.

**Implications:**
- channel-adapters-spec.md must add INV-10 codifying the webhook signature verification requirement.
- channel-adapters-spec.md must add a behavioral contract clause stating long-poll as the Telegram default.
- The deployment documentation must specify the reverse-proxy configuration for webhook mode (nginx or Caddy with TLS termination and `X-Telegram-Bot-Api-Secret-Token` configuration) before webhook mode is documented as a supported option.
- The Teams and WhatsApp optional skill specs must document the relevant signature verification requirements at the time those skills are developed.

---

### Draft ADR-32: Credential Proxy HTTP Binding Restriction

**Question:** What interface does the Token Broker's credential proxy HTTP server bind to, and what are the constraints on its network exposure?

**Decision:** The credential proxy HTTP server binds to the Docker bridge network interface address only. It does not bind to `0.0.0.0` or any host-external interface under any configuration.

The bind address is resolved at broker startup by inspecting the active Docker bridge interface. The default Docker bridge address is `172.17.0.1`; non-standard Docker network configurations (named networks, Podman, Apple Container) may differ. If the bridge address cannot be determined at startup (Docker not running, bridge not configured), the broker fails closed — it does not fall back to `0.0.0.0`.

`CREDENTIAL_PROXY_BIND_ADDRESS` overrides the resolved bridge address for deployments using non-standard container network configurations. This is a non-secret config var and belongs in `bootstrap.ts`'s `CONFIG_KEYS` whitelist per Decision 9.

**Implications:**
- token-broker-spec.md must add a behavioral contract clause: "The credential proxy HTTP server binds to `CREDENTIAL_PROXY_BIND_ADDRESS` if set, otherwise to the resolved Docker bridge network interface address. It never binds to `0.0.0.0`. If the bind address cannot be determined, the broker writes a fatal log entry and does not start."
- The deployment documentation must specify the correct `CREDENTIAL_PROXY_BIND_ADDRESS` value for each supported container runtime (Docker, Apple Container).
- The Tester must verify: the proxy is not reachable from a network address other than the configured bind address.
- If the project adds support for Apple Container (the `convert-to-apple-container` skill), the Apple Container host-side network interface address must be documented and the `CREDENTIAL_PROXY_BIND_ADDRESS` default must be updated accordingly.

---

### Draft ADR-33: Audit Log Cryptographic Integrity — HMAC Chain (Phase 2 Commitment with Phase 1 Schema Reservation)

**Question:** How should the audit log be protected against OS-level tampering (row deletion, field modification, database file replacement) that bypasses the application-layer INSERT-only semantics?

**Decision:** Phase 2 will implement a per-writer HMAC entry chain. Each audit log INSERT will include an `hmac` field: SHA-256 HMAC of the serialised row content concatenated with the previous entry's HMAC for that writer, using a writer-specific key held in the Token Broker's credential backend (same backend as LLM credentials, per Decision 8). The HMAC key per writer is distinct and is not stored in the audit log or group filesystem. Cato's scheduled audit will verify the HMAC chain for the audit period; a broken chain entry is reported as a `AUDIT_CHAIN_BREAK` anomaly in the hansei report.

Phase 1 schema reservation: the `events` table schema must add a nullable column `hmac TEXT` before Phase 1 ships. All Phase 1 writes set `hmac = NULL`. The schema is forward-compatible with Phase 2 population.

**Why not Phase 1:** The HMAC key provisioning mechanism requires the Token Broker credential backend to hold per-writer keys. In Phase 1, the `.env` backend is the primary backend, and adding cryptographic material to it before the multi-backend interface is stabilised would create a maintenance burden. Phase 2 introduces the full credential backend interface (Decision 8), at which point HMAC key provisioning is a natural addition.

**Implications:**
- audit-log-spec.md §3.1 must add `hmac TEXT` (nullable) to the `events` table schema.
- audit-log-spec.md §3.7 (sequence_id documentation) must add: "The `sequence_id` gap detection mechanism is a software-layer integrity signal. It detects dropped rows within a single process run but does not protect against OS-level file replacement, field-level modification, or cross-run manipulation. Cryptographic chain integrity (ADR-33, Phase 2) is the authoritative tamper-evidence mechanism."
- cato-spec.md scheduled audit section must add a Phase 2 note: "Phase 2: Cato verifies the HMAC chain for each writer for the covered audit period. A broken chain (NULL `hmac` where non-NULL is expected, or a hash mismatch) is reported as `AUDIT_CHAIN_BREAK` in the hansei report."
- Phase 2 scope must include HMAC key provisioning mechanism as a named deliverable.

---

### Draft ADR-34: In-Process Adapter Supply-Chain Policy

**Question:** Given the accepted supply-chain risk of in-process channel adapters (ADR-6), what mitigating controls apply?

**Decision:** Three mandatory controls for Phase 1. One Phase 2 design objective.

**Phase 1 controls:**

1. **Exact version pinning for adapter dependencies.** All packages that implement or support channel adapter functionality (e.g. Grammy for Telegram) must be pinned to exact versions in `package.json`. Semver caret or tilde ranges are not permitted for adapter-supporting packages in production. The rationale: a supply-chain compromise in a semver-floating adapter dependency is automatically adopted on `npm install` with no human review gate.

2. **Sourcing requirement.** Channel adapter skills applied to a production deployment must be sourced from the canonical OpenGolem repository or from an administrator-audited source. The deployment documentation must state this requirement explicitly. An administrator who applies a third-party adapter skill accepts sole responsibility for its supply-chain risk, and the deployment documentation must make this obligation visible.

3. **Node.js `--permission` flags in production.** Production deployments must launch the orchestrator process with Node.js `--permission` flags restricting filesystem access to declared paths (`groups/`, `data/`, `SOUL.md`, `PSYCHE.md`, `package.json`) and network access to the declared adapter endpoints. The exact flag set is a Stream H (DevOps) deliverable. Development mode (`npm run dev`) may relax this restriction.

**Phase 2 design objective.** High-privilege channel adapters (those with `apply_permission: admin` and a large outbound endpoint set) are candidates for out-of-process isolation with serialised IPC. The Architect should evaluate this at Phase 2 design time when Teams and/or WhatsApp are added. This is a design objective, not a Phase 2 commitment, because the serialisation cost is not yet evaluated.

**Implications:**
- Grammy `^1.39.3` must be changed to an exact pin before v1.0 ships. Stream L identifies the correct pinned version following a supply-chain review.
- `package-lock.json` must be committed to the repository before v1.0 ships.
- Deployment documentation must include an adapter sourcing guidance section.
- Stream H must produce the `--permission` flag set for production launch scripts and service unit files.

---

### Draft ADR-35: Inbound Message Rate Limiting and Queue Depth Control

**Question:** How does the orchestrator protect against inbound message flooding, queue exhaustion, and API cost amplification?

**Decision:** The orchestrator enforces two configurable limits at the message queue boundary.

**Per-sender rate limit:** Maximum N messages per sender (by `senderId`) per group per rolling 60-second window. Default: 10. Configurable via `INBOUND_RATE_LIMIT_PER_SENDER` (non-secret config var per Decision 9). Messages exceeding the rate limit are held in a per-sender cooldown queue (not dropped) for up to a configurable hold period (default: 5 minutes). If still held after the hold period, they are dropped and a `message_rate_limited` audit event is written with `senderId` hash, `groupId`, and `droppedCount`. The sender is notified via the channel that their messages are being rate-limited.

**Per-group queue depth maximum:** Maximum M pending messages in any single group's queue at any time. Default: 100. Configurable via `INBOUND_QUEUE_MAX_DEPTH` (non-secret config var per Decision 9). When a new message arrives and the group queue is at capacity, the new message is dropped immediately. A `queue_depth_exceeded` audit event is written. The sender is notified via the channel.

**No silently dropped messages:** The system must either queue, rate-hold, or explicitly drop (with audit log entry and sender notification) every inbound message. Messages are never silently lost.

**Audit observability:** Both event types (`message_rate_limited`, `queue_depth_exceeded`) are detectable by Cato's scheduled audit. A future dao_score extension may derive an inbound anomaly rate from these events.

**Implications:**
- orchestrator-spec.md §3.2 (queue management) must add the rate limit and queue depth behavioral contract, including the exact event types and the no-silent-drop invariant.
- audit-log-spec.md event type table must add `message_rate_limited` (fields: `senderIdHash`, `groupId`, `droppedCount`) and `queue_depth_exceeded` (fields: `groupId`, `queueDepth`, `droppedMessageHash`).
- `INBOUND_RATE_LIMIT_PER_SENDER` and `INBOUND_QUEUE_MAX_DEPTH` must be added to `bootstrap.ts`'s `CONFIG_KEYS` whitelist.

---

### Draft ADR-36: Self-Hosted Provider Safety Posture Disclosure

**Question:** What in-product disclosure is required when an operator configures a self-hosted (Ollama or custom) LLM provider? Who is responsible for surfacing the safety posture change?

**Decision:** When a skill with `providers.compatible` containing `ollama` or `custom` (not `any`, not `anthropic`, not `openrouter`) is applied by an administrator, the orchestrator emits an acknowledgement prompt before completing the application:

> "This skill is configured for a self-hosted provider (`ollama` or `custom`). No upstream content moderation or safety filtering applies to calls made through this provider. Cato's inline checks are the complete safety envelope for these calls. In Phase 1, Cato's inline checks are deterministic stubs (path traversal and oversized payload detection). Review your PSYCHE.md thresholds before deploying this skill in production. Confirm [yes/no]."

The skill is not applied until the administrator explicitly confirms. This acknowledgement is a one-time event per `skillId`. It is logged to the audit log as a `skill_safety_acknowledged` event with fields `skillId`, `providerType` (`ollama` or `custom`), and `acknowledgedAt`.

PSYCHE.md must include a required section `Self-Hosted Provider Posture` that specifies: (a) when a self-hosted provider is the active provider for any group, the scheduled audit interval should be reviewed; for high-call-volume self-hosted deployments, an interval of 1–2 hours (rather than the default 6 hours) is recommended; and (b) Cato's block thresholds should be verified before production use. The soul-psyche-spec must require this section's presence as a validation rule.

**Implications:**
- skill-schema-spec.md behavioral contract (On skill application) must add the provider acknowledgement flow.
- soul-psyche-spec.md PSYCHE.md schema section must add `Self-Hosted Provider Posture` as a required section.
- audit-log-spec.md event type table must add `skill_safety_acknowledged`.
- The deployment documentation must include a "Safety posture by provider" table before any external deployment is published.

---

### Draft ADR-37: Credential Rotation Procedure

**Question:** What happens when a long-lived credential (Anthropic API key, OAuth token, Bitwarden vault credential) is rotated? Can the Token Broker reload credentials without a full service restart? What is the emergency rotation procedure?

**Decision:**

**Planned rotation (credential updated in the backend):** The Token Broker polls the configured credential backend on a configurable interval (default: 5 minutes; configurable via `CREDENTIAL_RELOAD_INTERVAL`, non-secret config var per Decision 9) and reloads the long-lived credential if it has changed. In-flight derivative tokens continue to use the old credential for calls already in the proxy pipeline; new tokens issued after the reload use the new credential. The broker logs a `credential_reloaded` event to the audit log on each successful reload that detects a credential change.

**Emergency rotation (suspected compromise):** A `rotateCredential` JSON-RPC method is defined on the existing token lifecycle socket (`data/sockets/broker.sock`, per Decision 15):

```json
{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":true},"id":30}
{"jsonrpc":"2.0","result":{"reloaded":true,"revokedCount":N},"id":30}
```

`revokeInFlight: true` triggers: (a) immediate backend re-read; (b) revocation of all currently active derivative tokens (in-flight containers receive HTTP 403 on their next proxied call and are torn down by the orchestrator per the mid-task broker loss procedure, Decision F-5 spec addition); (c) a `credential_emergency_rotation` audit log event with `revokedCount` and `timestamp`. This is the in-product emergency rotation path. No service restart is required.

The deployment documentation and Stream H runbook must include an emergency rotation procedure with target time-to-rotation for each backend type: `.env` (immediate — edit file, then invoke `rotateCredential`), Bitwarden (update vault entry, then invoke `rotateCredential`), OneCLI (update via OneCLI, then invoke `rotateCredential`).

**Implications:**
- token-broker-spec.md must add `rotateCredential` to its External Interface section (§4.2.1) with the params schema and behavioral contract above.
- token-broker-spec.md must add a behavioral contract for the polling-based planned rotation.
- audit-log-spec.md must add `credential_reloaded` and `credential_emergency_rotation` event types.
- `CREDENTIAL_RELOAD_INTERVAL` must be added to `bootstrap.ts`'s `CONFIG_KEYS` whitelist.
- The Tester must verify: (a) after updating the `.env` credential and invoking `rotateCredential`, new proxied calls use the new credential; (b) `revokeInFlight: true` causes active containers to receive HTTP 403 on their next proxied call.

---

### Draft ADR-38: External Dependency Supply-Chain Policy

**Question:** What minimum policy governs the npm dependency surface in Phase 1? What acceptance criterion applies to the Phase 2 Rust crate dependency graph? What policy governs the agent container base image?

**Decision:**

**Phase 1 — npm dependency policy (minimum gate):**

1. `package-lock.json` must be committed to the repository. `npm install` in CI and on deployment machines must use `npm ci` (not `npm install`) to guarantee reproducible installs from the lockfile.
2. All production dependencies in `package.json` must be pinned to exact versions (no `^`, no `~`, no semver ranges). This applies to `dependencies`; `devDependencies` may retain ranges.
3. `npm audit --audit-level=high` must pass with zero findings as a required CI gate. Any high or critical CVE in a direct or transitive production dependency blocks the build until resolved (patched, pinned to a safe version, or explicitly excepted with a recorded risk acceptance).
4. When a new channel adapter package is introduced (Baileys for WhatsApp, botbuilder for Teams), it must undergo a dedicated supply-chain review by Stream L (Supply-Chain Auditor) before it is merged to `main`. The review report must be approved by the PM before the package is committed.

**Phase 2 — Rust crate minimisation:**

The Phase 2 Rust rewrite must include an explicit acceptance criterion: "The crate dependency graph for each rewritten component must be reviewed and justified. Each crate dependency requires a written rationale in the component's spec or ADR. The total transitive dependency count for the host-side process must be tracked and reported as a named metric in the Phase 2 milestone review." This makes supply-chain surface reduction a first-class design objective in Phase 2, alongside functional correctness.

**Container image pinning:**

The agent container base image (referenced in `container/build.sh`) must be pinned by SHA256 digest rather than a mutable tag before v1.0 ships. A mutable image tag silently adopts upstream OS updates that may introduce regressions or vulnerabilities. Pinning by digest guarantees the build is reproducible. The `container/build.sh` script must use `FROM <image>@sha256:<digest>` syntax. The pinned digest must be reviewed and updated deliberately, with a written rationale, rather than automatically on each build.

**Implications:**
- The `grammy` entry in `package.json` must change from `^1.39.3` to the exact version identified by Stream L's review before v1.0 ships.
- `package-lock.json` must be committed before v1.0 ships.
- CI configuration must add `npm audit --audit-level=high` as a required step.
- `container/build.sh` must be updated to use SHA256 image digest pinning.
- Phase 2 scope must include the crate dependency acceptance criterion as a named deliverable.

---

*End of report. All findings and ADR drafts are offered for PM review. Jim's approval is required before any ADR is added to DECISIONS.md or any spec is modified based on these recommendations.*
