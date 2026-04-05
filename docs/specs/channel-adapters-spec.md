# Channel Adapters — Behavioral Specification

*Produced: 2026-04-05 | Spec Writer: Claude Code | Component: Stream F (Channel Adapters, M9+)*
*Input documents: ARCHITECTURE.md §3.6, §4.1, ADR-6, ADR-8; DECISIONS.md Decision 4, Decision 13; docs/specs/skill-schema-spec.md*

---

## Responsibilities

Channel adapters are in-process components within TD-ORCHESTRATOR that bridge external channel providers to the orchestrator's internal message pipeline. Each adapter handles one channel.

The four channel adapters in scope for v1.0 (Decision 4):

| Adapter | Channel | Protocol |
|---------|---------|----------|
| **TUI** | Terminal UI | readline / PTY |
| **Microsoft Teams** | Enterprise messaging | Bot Framework / Graph API |
| **Telegram** | Messaging app | Telegram Bot API (long-poll or webhook) |
| **WhatsApp** | Messaging app | Baileys WebSocket |

Each adapter is responsible for:

1. **Protocol handling** — connecting to and communicating with the external channel provider using the channel's native protocol and SDK.
2. **Inbound message normalization** — converting inbound channel-specific event payloads into the orchestrator's canonical `InboundMessage` format, preserving all sender identity and language metadata (ADR-8).
3. **Outbound message formatting** — converting the orchestrator's canonical outbound payload into channel-native format (e.g. plain text to markdown, markdown to channel-native rich text).
4. **User identity resolution** — mapping channel-specific sender identifiers (Telegram user ID, WhatsApp JID, Teams user UPN) to the orchestrator's internal user identity representation.
5. **Health reporting** — reporting per-adapter connection status to the orchestrator's health surface on demand.
6. **Self-registration** — registering with the orchestrator's channel registry at startup so the orchestrator can route to them.

**What channel adapters do not do:**

- Make routing or scheduling decisions. The adapter delivers; the orchestrator decides what to do with the message.
- Enforce sender allowlists. Sender allowlist enforcement (Telegram valid users, group allowlists) is an orchestrator-level policy applied after the adapter delivers the inbound message. The adapter does not gate messages based on sender identity.
- Make safety decisions. No Cato interaction is initiated by adapters.
- Hold credentials. Bot tokens and API credentials are sourced from the credential backend (via the Token Broker at startup) and held by the adapter in-process for the duration of the connection. Adapters do not write credentials to disk.
- Invoke agent containers. Adapters have no container lifecycle authority.
- Access episodic or strategic memory. The channel adapter access column in ARCHITECTURE.md §6.4 is None for all memory tiers.
- Perform business logic. Parsing command intent, routing decisions, task queue management — all belong to the orchestrator.

Channel adapters run in the same process as the orchestrator. This is architecturally accepted (ADR-6): adapters are applied as Skills with audited declarations; the risk of in-process compromise is accepted because a malicious adapter is a supply-chain attack on the administrator's machine, which is outside OpenGolem's security boundary.

---

## Skill Declaration (`.intent.md`)

Each channel adapter is a Feature skill. The orchestrator validates the adapter's `.intent.md` at skill application time using the rules defined in the Skill Schema spec. A channel adapter whose `.intent.md` fails validation is not applied.

**Required fields common to all channel adapter `.intent.md` declarations:**

| Field | Required value / constraint |
|-------|-----------------------------|
| `type` | `feature` |
| `apply_permission` | `admin` — channel adapters run in-process with the orchestrator (ADR-6); only an administrator may expand the orchestrator's in-process surface |
| `providers.compatible` | Non-empty; typically `["any"]` — channel adapters do not depend on a specific LLM provider |
| `network.endpoints` | Must declare every external URL pattern the adapter will connect to. The Call Inspector enforces this list for all outbound calls made through the credential proxy. Adapter-to-channel-provider connections are NOT routed through the credential proxy — they are direct host connections — but the endpoint declaration is required for auditability. |
| `token_scopes.skills` | Must include the adapter's own skill ID (e.g. `["telegram"]`) |

**`filesystem` block:** Channel adapters do not require container mounts (`container_mounts: []`). They run in-process and do not write to the group filesystem directly. `host_reads` and `host_writes` must enumerate any host paths the adapter reads or writes (e.g. a WhatsApp session state file). If the adapter has no filesystem effects, the `filesystem` block may be omitted.

**`mcp` block:** Channel adapters do not declare MCP servers. The block may be omitted or declared empty (`mcp: {}`).

### Per-Adapter `.intent.md` Templates

**Telegram:**
```yaml
---
skill: telegram
version: 1.0.0
type: feature
description: Telegram channel adapter — delivers and receives messages via the Telegram Bot API

token_scopes:
  skills:
    - telegram

filesystem:
  host_reads: []
  host_writes: []
  container_mounts: []

network:
  endpoints:
    - pattern: "https://api.telegram.org/*"
      protocol: https
      direction: outbound

mcp: {}

providers:
  compatible:
    - any

apply_permission: admin
---
```

**WhatsApp:**
```yaml
---
skill: whatsapp
version: 1.0.0
type: feature
description: WhatsApp channel adapter — delivers and receives messages via Baileys WebSocket

token_scopes:
  skills:
    - whatsapp

filesystem:
  host_writes:
    - "data/whatsapp-session/*"
  container_mounts: []

network:
  endpoints:
    - pattern: "wss://*.whatsapp.net/*"
      protocol: wss
      direction: outbound
    - pattern: "https://*.whatsapp.net/*"
      protocol: https
      direction: outbound

mcp: {}

providers:
  compatible:
    - any

apply_permission: admin
---
```

**Microsoft Teams:**
```yaml
---
skill: teams
version: 1.0.0
type: feature
description: Microsoft Teams channel adapter — delivers and receives messages via the Bot Framework

token_scopes:
  skills:
    - teams

filesystem:
  host_reads: []
  host_writes: []
  container_mounts: []

network:
  endpoints:
    - pattern: "https://smba.trafficmanager.net/*"
      protocol: https
      direction: outbound
    - pattern: "https://login.microsoftonline.com/*"
      protocol: https
      direction: outbound

mcp: {}

providers:
  compatible:
    - any

apply_permission: admin
---
```

**TUI:**
```yaml
---
skill: tui
version: 1.0.0
type: feature
description: Terminal UI channel adapter — interactive terminal session with health dashboard (Ctrl-D toggle)

token_scopes:
  skills:
    - tui

filesystem:
  host_reads: []
  host_writes: []
  container_mounts: []

network:
  endpoints: []

mcp: {}

providers:
  compatible:
    - any

apply_permission: admin
---
```

Note: the TUI adapter declares no network endpoints because it communicates only with the local terminal — no outbound network connections.

---

## External Interface

### Inbound: Channel Provider → Adapter → Orchestrator

**Protocol (channel provider → adapter):** Channel-native. Each adapter uses the appropriate SDK or protocol:
- Telegram: Telegram Bot API (long-poll `getUpdates` or webhook; adapter choice is a deployment configuration).
- WhatsApp: Baileys WebSocket to WhatsApp servers.
- Teams: Bot Framework SDK; the adapter receives activity payloads via a locally-bound HTTP endpoint.
- TUI: readline over stdin; the adapter reads from the terminal.

**Protocol (adapter → orchestrator):** In-process function call. No serialization. Both sides are in the same Node.js process and the same trust domain (TD-ORCHESTRATOR). The adapter calls the orchestrator's message ingestion entry point directly.

**Canonical `InboundMessage` format** (the object the adapter constructs and delivers to the orchestrator):

```typescript
interface InboundMessage {
  // Routing and identity
  channel: "tui" | "teams" | "telegram" | "whatsapp";
  contextId: string;          // group identifier; resolved by the adapter from channel identifiers
  senderId: string;           // channel-native sender identifier (e.g. Telegram user ID as string)
  senderDisplayName?: string; // human-readable name if available from the channel; optional

  // Message content
  text: string;               // normalized message text; always present
  attachments?: Attachment[]; // optional; channel-specific attachments normalized to a common type

  // Metadata — must be preserved, never stripped (ADR-8)
  detectedLanguage?: string;  // BCP-47 language tag if the adapter can infer it; otherwise absent
  languageSwitchDetected?: boolean; // true if this message is in a different language than the previous
                                    // message from the same sender in the same context
  raw: unknown;               // the unmodified channel-native event payload; preserved for audit and debugging

  // Timing
  receivedAt: string;         // ISO 8601 timestamp at which the adapter received the event
}

interface Attachment {
  type: "image" | "audio" | "document" | "video" | "sticker" | "location" | "unknown";
  mimeType?: string;
  url?: string;               // URL if the channel provides a downloadable URL
  data?: Buffer;              // raw bytes if the channel delivers content inline
  filename?: string;
}
```

**Language and identity metadata (ADR-8):** The adapter must pass all sender language and identity information it can observe to the orchestrator as fields on `InboundMessage`. The adapter must not strip, normalize away, or suppress language signals. If the channel provides a UI language preference for the sender, the adapter includes it as `detectedLanguage`. If the adapter observes a language switch between consecutive messages from the same sender in the same context, it sets `languageSwitchDetected: true`. This signal is forwarded to Cato via the orchestrator; Cato treats language-switching as a potential evasion signal (ADR-8), while Alef uses the language information to respond in the user's language — these are independent uses of the same metadata.

**Sender allowlist is NOT the adapter's responsibility:** The adapter delivers every inbound message it receives from the channel, regardless of sender identity. Whether a given sender is on a valid-users list, a group allowlist, or any other access control list is an orchestrator-level policy decision applied after delivery. The adapter's job is to convert and deliver; the orchestrator's job is to gate.

### Outbound: Orchestrator → Adapter → Channel Provider

The orchestrator calls the adapter's outbound delivery function with a canonical `OutboundMessage`:

```typescript
interface OutboundMessage {
  channel: "tui" | "teams" | "telegram" | "whatsapp";
  contextId: string;          // identifies the conversation thread
  recipientId?: string;       // channel-native recipient; derived from the original inbound senderId
  text: string;               // content to deliver; may include Markdown
  replyToMessageId?: string;  // channel-native ID of the message being replied to; optional
}
```

The adapter formats `text` into channel-native syntax before sending. Exact formatting rules are channel-specific:
- Telegram: convert Markdown to Telegram MarkdownV2 or HTML (per deployment config).
- WhatsApp: convert Markdown to WhatsApp-native formatting (bold, italic via `*` and `_`).
- Teams: convert Markdown to Adaptive Card or Teams-native markdown.
- TUI: render Markdown using a terminal-appropriate formatter; also render the health panel if the health toggle is active.

**Delivery acknowledgment:** The adapter must confirm delivery success or failure to the orchestrator via a return value or thrown error. The orchestrator logs the delivery outcome. The adapter does not retry — retry logic, if any, belongs to the orchestrator.

### Health Reporting

Each adapter exposes a health status to the orchestrator's health query surface. The orchestrator aggregates per-adapter health into the overall system health response.

```typescript
interface AdapterHealthStatus {
  channel: "tui" | "teams" | "telegram" | "whatsapp";
  status: "connected" | "connecting" | "disconnected" | "error";
  detail?: string;     // human-readable detail; present on error or disconnected
  since: string;       // ISO 8601 timestamp of the last status change
}
```

### TUI — Additional: Health Dashboard Surface

The TUI adapter is the health dashboard surface (Decision 4). In addition to normal message channel behavior, the TUI adapter:

- Renders a split-pane terminal UI with a live health panel.
- The health panel is toggled on/off with `Ctrl-D`.
- The health panel displays: per-adapter connection status, Token Broker status, Cato status, active container count, recent audit events (last N entries from the orchestrator's in-memory audit window — not from the SQLite audit log directly), and the most recent hansei report summary if one has been ingested.
- The health panel content is read-only. No user input is accepted in the health panel pane.
- The health panel is rendered using terminal-compatible UI primitives. No external UI framework or browser dependency is introduced.
- When the TUI adapter is not running (headless deployment), the health dashboard is unavailable. This is expected. Other health surfaces (health endpoint, CLI status commands) remain available.

---

## Behavioral Contract

### Adapter startup and self-registration

**Given** the orchestrator is starting and a channel adapter is enabled (via `OPENGOLEM_CHANNELS`):

- The adapter initializes its channel connection using the channel-specific credential (e.g. `TELEGRAM_BOT_TOKEN`) sourced from the credential backend.
- The adapter registers itself with the orchestrator's channel registry. The registry entry includes: the channel name, the adapter's inbound delivery callback, the adapter's outbound delivery function, and the adapter's health status function.
- If the channel credential is absent or invalid, the adapter logs a startup error and does not register. The orchestrator starts without that adapter; messages for that channel cannot be delivered.
- A failed adapter startup does not block other adapters or the orchestrator itself.

**Registration is synchronous at startup.** By the time the orchestrator begins processing the message queue, all enabled adapters have either registered successfully or logged a startup error.

### Inbound message delivery

**Given** the adapter receives a message event from the channel provider:

- The adapter normalizes the event into an `InboundMessage` value, preserving all metadata fields described above.
- The adapter delivers the `InboundMessage` to the orchestrator's ingestion entry point in-process.
- The adapter does not filter, gate, or drop messages based on sender identity. It delivers all valid, parseable inbound events.
- If the event cannot be parsed into a valid `InboundMessage` (e.g. unsupported message type, missing required fields), the adapter logs a warning and discards the event. It does not crash.
- The adapter does not queue or buffer messages — it delivers each event as it arrives. Queue management belongs to the orchestrator.

### Outbound message delivery

**Given** the orchestrator calls the adapter's outbound delivery function with an `OutboundMessage`:

- The adapter formats `text` to channel-native syntax.
- The adapter sends the formatted message to the channel provider using the channel's native send API.
- On success: the adapter returns a success indicator to the orchestrator (specific return type is implementation-defined, but success must be distinguishable from failure).
- On failure (network error, API rate limit, invalid recipient): the adapter throws or returns an error value with a human-readable reason. The orchestrator logs the failure and decides whether to retry.
- The adapter does not suppress errors silently.

### Inbound events that are not text messages

Each adapter may receive non-text events from its channel (reactions, typing indicators, read receipts, group membership changes). The adapter's handling:
- Events that carry deliverable content for the user (voice notes, images, documents) are normalized into `InboundMessage` with the appropriate `attachments` entry.
- Events that do not carry deliverable content (typing indicators, read receipts) are silently discarded by the adapter. They are not delivered to the orchestrator.
- Group membership events (user added/removed from a group) are forwarded to the orchestrator as a distinct event type, not as an `InboundMessage`. The orchestrator decides whether they require a response. The specific event schema for membership events is outside the scope of this spec — the orchestrator spec (Stream E) defines how they are handled.

### Reconnection on connection loss

**Given** the adapter's connection to the channel provider is lost:

- The adapter updates its health status to `"disconnected"` or `"connecting"`.
- The adapter attempts reconnection with an exponential back-off (initial: 1 second; cap: 60 seconds). The adapter does not block the orchestrator's main loop during reconnection attempts.
- While disconnected, inbound messages cannot be received. The orchestrator is not notified of each reconnection attempt — only of status changes (disconnected → connected).
- On reconnection, the adapter updates its health status to `"connected"` and resumes normal event handling.
- If the channel credential has been revoked or expired, reconnection will permanently fail. The adapter logs a fatal error and stops attempting reconnection. An administrator must update the credential and restart.

---

## Failure Modes

### Channel credential absent at startup

The required credential (e.g. `TELEGRAM_BOT_TOKEN`) is not present in the credential backend. The adapter logs a startup error naming the missing credential. The adapter does not register with the channel registry. The orchestrator continues without this adapter.

### Channel provider API unavailable

The adapter cannot reach the channel provider's API endpoint at startup or during operation. The adapter retries with exponential back-off. Health status is reported as `"disconnected"` until connectivity is restored. The orchestrator queues inbound messages for contexts that are already known; new messages from this channel cannot arrive while the adapter is disconnected.

### Channel provider delivers a malformed event

An event payload cannot be parsed into a valid `InboundMessage`. The adapter logs a warning including the channel and a description of the parse failure (not the raw payload content — it may contain sensitive user data). The event is discarded. The adapter continues processing subsequent events.

### Outbound delivery fails

The adapter cannot deliver an outbound message (API error, rate limit, invalid recipient). The adapter returns an error to the orchestrator. The orchestrator logs the failure. The adapter remains connected and continues processing; the failure is isolated to the individual message.

### TUI adapter: terminal not attached

The TUI adapter is enabled but no terminal is attached (e.g. the process is running as a service with no TTY). The TUI adapter logs a startup warning and operates in a degraded mode: it accepts inbound text via stdin if a pipe is present, and writes outbound text to stdout. The health dashboard does not render. No error is thrown; the orchestrator continues.

### Adapter crashes at runtime

An unhandled exception in the adapter propagates to the orchestrator's global error handler. The orchestrator logs the exception, marks the adapter's health status as `"error"`, and does not attempt to restart the adapter automatically — the process supervisor (systemd/launchd) is responsible for process restart. Adapters must not allow per-message errors to propagate to an unhandled state: all per-message errors must be caught and handled (log + discard or log + return error to orchestrator).

---

## Invariants

These properties hold at all times during normal operation:

1. **Adapters do not enforce sender policy.** No adapter gates, filters, or drops messages based on sender identity. Allowlist enforcement is always the orchestrator's responsibility, applied after inbound delivery.

2. **Metadata is preserved.** Every `InboundMessage` delivered to the orchestrator includes all available sender identity and language metadata. No adapter strips or normalizes away `detectedLanguage`, `languageSwitchDetected`, or `senderId`.

3. **Adapters hold no memory-tier data.** Adapters read no Tier 1, Tier 2, or Tier 3 memory structures. All memory access is mediated by the orchestrator.

4. **Adapters hold no raw credentials after startup.** At startup, the adapter reads the channel credential from the credential backend (via the orchestrator's startup context). The credential is held in-process as an opaque value for the lifetime of the connection. It is never written to disk by the adapter, never passed to the orchestrator, and never included in log output.

5. **A failed adapter does not block other adapters.** Each adapter's startup failure, runtime failure, and reconnection cycle are isolated. The failure of one adapter does not affect the initialization or operation of any other adapter.

6. **The TUI adapter is the sole health dashboard surface.** No other adapter renders health panel content. When the TUI adapter is not running, the health dashboard is unavailable — other health surfaces remain functional.

7. **Outbound failures are reported, not suppressed.** An adapter never silently drops an outbound message. Every failed outbound delivery produces a distinguishable error return to the orchestrator.

8. **No in-process adapter-to-adapter communication.** Adapters do not call each other. All routing between channels passes through the orchestrator.

9. **Channel adapters are in TD-ORCHESTRATOR.** The external channel provider (Telegram's servers, WhatsApp's infrastructure, Microsoft Teams' infrastructure) is in TD-CHANNEL (untrusted). The adapter code, running in-process with the orchestrator, is in TD-ORCHESTRATOR. This boundary is the adapter's primary security surface: inbound data from TD-CHANNEL must be treated as untrusted input and normalized into the canonical schema before being passed into the orchestrator.

10. **`apply_permission` is always `admin`.** No channel adapter may be applied by a power user. Channel adapters expand the orchestrator's in-process attack surface (ADR-6); this expansion requires administrator authorization.

---

## Acceptance Criteria

Each criterion is testable from outside the adapters' internal implementation. No criterion relies on internal structure.

### AC-1: Adapter self-registers at startup when enabled

**Given** `OPENGOLEM_CHANNELS` includes a channel name (e.g. `telegram`),
**when** the orchestrator starts,
**then** the channel registry contains an entry for that channel with a valid inbound delivery callback, outbound delivery function, and health status function.

### AC-2: Disabled adapter does not register

**Given** `OPENGOLEM_CHANNELS` does not include a channel name (e.g. `teams`),
**when** the orchestrator starts,
**then** the channel registry contains no entry for that channel and no connection to that channel's provider is attempted.

### AC-3: Inbound message is normalized to `InboundMessage` format

**Given** the adapter receives a channel-native message event,
**when** the adapter delivers it to the orchestrator,
**then** the delivered object conforms to the `InboundMessage` schema: `channel`, `contextId`, `senderId`, `text`, and `receivedAt` are all present and non-empty; `raw` is the unmodified event payload.

### AC-4: Language metadata is preserved

**Given** the channel provides language information for the sender,
**when** the adapter normalizes the inbound event,
**then** `detectedLanguage` is set to the channel-provided BCP-47 tag and is included in the delivered `InboundMessage`.

**Given** a sender's consecutive messages in the same context are in different languages,
**when** the adapter normalizes the second message,
**then** `languageSwitchDetected` is `true` in the delivered `InboundMessage`.

### AC-5: Adapter does not filter messages by sender identity

**Given** the orchestrator has a Telegram valid-users list configured,
**when** a message arrives from a sender not on the list,
**then** the Telegram adapter delivers the message to the orchestrator (the orchestrator applies the allowlist check, not the adapter).

### AC-6: Malformed inbound event is discarded without crashing

**Given** the adapter receives a channel event that cannot be parsed into a valid `InboundMessage`,
**when** the adapter processes the event,
**then** the adapter logs a warning and the event is not delivered to the orchestrator; subsequent events are processed normally.

### AC-7: Outbound message is formatted and delivered

**Given** the orchestrator calls the adapter's outbound delivery function with a valid `OutboundMessage`,
**when** the adapter sends the message,
**then** the message is delivered to the channel provider in channel-native format and the adapter returns a success indicator.

### AC-8: Outbound delivery failure returns an error to the orchestrator

**Given** the channel provider returns an error for an outbound send attempt,
**when** the adapter processes the error,
**then** the adapter returns or throws an error value (not success) to the orchestrator; the adapter remains connected and processes subsequent messages.

### AC-9: Adapter reports health status

**Given** a running adapter,
**when** the orchestrator queries the adapter's health status function,
**then** the function returns an `AdapterHealthStatus` with `channel`, `status` (`"connected"` when the connection is live), and `since` populated.

### AC-10: Adapter reconnects after connection loss

**Given** the adapter is connected and the channel provider closes the connection,
**when** the adapter detects the disconnection,
**then** the adapter updates its health status to `"disconnected"` or `"connecting"` and begins reconnection attempts with exponential back-off; upon successful reconnection the health status returns to `"connected"`.

### AC-11: Missing credential prevents adapter startup without crashing

**Given** the required channel credential is absent from the credential backend,
**when** the adapter attempts to initialize,
**then** the adapter logs a startup error naming the missing credential, does not register with the channel registry, and the orchestrator continues to start with the remaining enabled adapters.

### AC-12: Failed adapter does not prevent other adapters from starting

**Given** the Telegram adapter fails to start (e.g. missing credential),
**when** WhatsApp is also enabled and its credential is present,
**then** the WhatsApp adapter initializes and registers successfully; the orchestrator is functional for the WhatsApp channel.

### AC-13: TUI health dashboard toggles with Ctrl-D

**Given** the TUI adapter is running with a connected terminal,
**when** the user presses `Ctrl-D`,
**then** the terminal renders a health panel pane showing component health; pressing `Ctrl-D` again hides the health panel.

### AC-14: TUI health panel is read-only

**Given** the TUI adapter is rendering the health panel,
**when** any key is pressed while the health panel pane is focused,
**then** no action is taken; the health panel pane accepts no user input.

### AC-15: Channel adapter `.intent.md` is validated at skill application time

**Given** a channel adapter's `.intent.md` is missing the required `apply_permission` field,
**when** the administrator applies the skill,
**then** the orchestrator rejects the skill with an error identifying `apply_permission` as the missing field; the adapter is not registered.

### AC-16: Channel adapter `apply_permission` must be `admin`

**Given** a channel adapter `.intent.md` with `apply_permission: power_user`,
**when** a power user (non-admin) attempts to apply the skill,
**then** the orchestrator rejects the application with an authorization error; the adapter is not registered.

### AC-17: Inbound message audit record is written by the orchestrator

**Given** the adapter delivers an `InboundMessage` to the orchestrator,
**when** the orchestrator processes the delivery,
**then** an audit log entry is written containing: context ID, sender identity hash (not raw sender ID), channel, and timestamp. Message content is not stored in the audit log — only a content hash.

### AC-18: `raw` field is not logged

**Given** the adapter delivers an `InboundMessage` including a `raw` channel-native payload,
**when** the orchestrator processes the delivery and writes the audit log entry,
**then** the audit log entry does not contain the `raw` field content. The `raw` field is available in-process for debugging only and is never persisted to any log or database.

---

*End of specification. The PM and Architect must review before the Tester writes against these criteria and the Developer begins implementation.*
