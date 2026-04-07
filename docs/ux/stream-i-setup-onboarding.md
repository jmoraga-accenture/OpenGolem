# Stream I — UX Review: Setup and Onboarding (M3)
*Status: Awaiting PM approval | Produced: 2026-04-07*
*UX/Interaction Designer: Claude Code | Scope: First-run setup through operational first use*

---

## Inputs Read

Before producing this review, the following documents were read in full:

- `README.md` — current user-facing documentation and quick start
- `docs/SECURITY_STRENGTHENING.md` — findings F-1 through F-10, particularly F-7 (self-hosted safety posture), F-8 (credential rotation), F-5 (broker startup failure)
- `docs/ARCHITECTURE.md` §1.3 (startup order and dependencies)
- `docs/specs/orchestrator-spec.md` §3.1 (orchestrator responsibilities at startup)
- `docs/ux/stream-j-cli-tui.md` — prior UX decisions for context

---

## Scope and Method

This review covers four areas: cognitive load at each setup step, documentation structure and progressive disclosure, error message clarity at startup failures, and the full annotated user flow from first run through skill application. Findings are presented as **current state**, **finding or gap**, and **recommendation**. Where a finding has responsible AI implications, this is called out explicitly.

The target user spectrum runs from non-expert (a person who is comfortable with a terminal but has never deployed a server application) to enterprise operator (a DevOps professional deploying for a team). Steps that create dead ends for non-experts are flagged separately.

---

## 1. Cognitive Load Assessment

### 1.1 The Quick Start Sequence

The README's quick start is five commands plus a copy-and-edit step:

```
cp .env.example .env   # then add your Anthropic credential
npm install
npm run build
./container/build.sh   # build the agent container image (once)
npm test
npm run dev
```

**Load analysis by user segment:**

| Step | Non-expert load | Enterprise operator load | Specific issue |
|------|----------------|--------------------------|----------------|
| `cp .env.example .env` + edit | High — "add your Anthropic credential" gives no path | Low — understood | User must know which of three credential variables to use; no decision guidance |
| `npm install` | Low | Low | None |
| `npm run build` | Low | Low | None |
| `./container/build.sh` | Medium — Docker must already be installed and running; no check | Low | Failure here (Docker not running) gives a Docker error, not an OpenGolem error |
| `npm test` | Low — passes visually; but why? | Low — CI gate | Non-expert may not understand why running tests is part of setup |
| `npm run dev` | Low | Low | None |

**Finding 1.1: The credential decision is front-loaded and unexplained.**

The README says "add your Anthropic credential" with no guidance on which variable to use. There are three possibilities: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or an `ANTHROPIC_BASE_URL_UPSTREAM` combination. The configuration reference table describes all three but does not recommend a decision path.

A non-expert will open `.env.example`, see three credential-adjacent variables, and not know which one applies to them. They will likely add the wrong one, complete setup, and receive an authentication error from the container — which is a bad state with an unclear recovery path (see §4).

**Recommendation 1.1:** Precede the credential variables in `.env.example` with a commented decision block:

```
# --- CHOOSE ONE CREDENTIAL TYPE ---
#
# Option A (most users): API key from console.anthropic.com
# ANTHROPIC_API_KEY=sk-ant-...
#
# Option B (Claude Code subscribers): OAuth token
# Run: claude setup-token
# Then set:
# CLAUDE_CODE_OAUTH_TOKEN=<token from above>
#
# Option C (enterprise/custom endpoint):
# ANTHROPIC_API_KEY=...
# ANTHROPIC_BASE_URL_UPSTREAM=https://your-enterprise-endpoint
#
# ---------------------------------
```

This converts a configuration table into a decision tree at the point of use. It adds twelve lines to the `.env.example` file and eliminates the most common first-run failure.

---

**Finding 1.2: `npm test` in setup is unexplained.**

The quick start includes `npm test` (505 tests) without explaining why. For a non-expert, running a test suite as part of installation is unusual. For an enterprise operator, it is normal CI hygiene — but they will wonder whether a test failure blocks operation.

**Recommendation 1.2:** Reframe `npm test` in the quick start as an optional verification step with a comment:

```bash
npm test        # optional: verify your installation (505 tests; skip if you want to get started faster)
npm run dev     # opengolem> prompt
```

Alternatively, move `npm test` to a "Verify your installation" section after the main quick start, so it reads as confirmation rather than prerequisite.

---

**Finding 1.3: Container build failure is invisible as an OpenGolem error.**

`./container/build.sh` fails with Docker error output if Docker is not running or not installed. The error comes from Docker, not from OpenGolem, and does not contain the word "OpenGolem." A non-expert who hits this error sees Docker output and does not know whether the OpenGolem installation is broken or whether Docker is the problem.

**Recommendation 1.3:** Prefix `./container/build.sh` with a prerequisite check that produces a clear, OpenGolem-attributed message:

```bash
#!/bin/bash
# container/build.sh

if ! docker info > /dev/null 2>&1; then
  echo "OpenGolem: Docker is not running or not installed."
  echo "  Install Docker: https://docs.docker.com/get-docker/"
  echo "  Then re-run this script."
  exit 1
fi

# ... rest of build
```

This is a one-time script change with disproportionate impact on non-expert first-run success.

---

### 1.2 Credential Backend Selection

The README describes three credential backends (`env`, `bitwarden`, `onecli`) in a configuration reference table row: `OPENGOLEM_CREDENTIAL_BACKEND | env | Credential backend: env | bitwarden | onecli`.

A non-expert reading this will not understand the significance of the backend choice. The `.env` backend is the correct default for solo use; Bitwarden is the recommended production backend; OneCLI is for enterprise deployments. This hierarchy exists in the architecture but is not surfaced in the documentation in a way that supports the decision.

**Finding 1.4: Credential backend choice is presented as a flat option list with no recommendation order.**

**Recommendation 1.4:** Add a "Credential backends" subsection after the configuration reference that makes the choice hierarchy explicit:

```
## Credential backends

**For personal use (default):** `OPENGOLEM_CREDENTIAL_BACKEND=env`
Your API key lives in `.env`. Suitable for a single user on a trusted machine.

**For a shared or always-on deployment:** `OPENGOLEM_CREDENTIAL_BACKEND=bitwarden`
Keys live in Bitwarden and are fetched at startup. Requires `BW_SESSION`, `BW_ITEM_NAME`,
`BW_FIELD_NAME`. See the /setup skill for the Bitwarden setup flow.

**For enterprise with OneCLI vault:** `OPENGOLEM_CREDENTIAL_BACKEND=onecli`
Keys are resolved through your organization's OneCLI gateway. Requires `ONECLI_GATEWAY_URL`
and `ONECLI_GATEWAY_TOKEN`. This is the highest-assurance option.

If you are unsure, start with `env`.
```

The final sentence ("If you are unsure, start with `env`") is the most important line in this subsection. It removes the decision burden from the non-expert without removing the options from the enterprise operator.

---

## 2. Documentation Structure and Progressive Disclosure

### 2.1 Current Structure

The README presents information in this order:

1. Description paragraph
2. "What you get today" — feature list with milestone labels
3. Requirements
4. Quick start — six commands
5. Configuration reference — full table of all variables
6. Channel notes — Telegram, WhatsApp, Teams
7. Shared context
8. Security model
9. Documentation index

**Finding 2.1: The configuration reference (full variable table) appears before any channel setup guidance.**

A user completing the quick start and wanting to add Telegram will scroll from the quick start past the full configuration table to the channel notes. The configuration table is 15 rows and covers variables for all three backends, all channels, all security modes, and runtime tuning. It is correct as a reference, but its position in the document places a dense reference table between the user's two most likely next actions (add a channel, understand the security model).

**Recommendation 2.1 — Document restructure:**

Reorganize the README into a three-zone structure:

**Zone 1 (Getting started):** Description → Requirements → Quick start → "What to do next" (three links: add a channel, understand the security model, understand configuration). This zone should be completable in under 5 minutes.

**Zone 2 (Add a channel):** Telegram (four-step flow, as recommended in Stream J R7) → WhatsApp → Teams (bridge note). Move channel notes here, rewritten as sequential setup flows rather than feature descriptions.

**Zone 3 (Reference):** Configuration table, security model depth, documentation index. This is the reference material a user returns to, not reads on first encounter.

This restructure moves the configuration reference from a required reading position to an optional reference position, reducing cognitive load at the exact moment it is highest (first run).

---

### 2.2 Progressive Disclosure for Credential Backend Options

The current documentation presents all three credential backends simultaneously. For a non-expert, this creates a false parity: "I have to choose between three options I don't understand."

**Recommendation 2.2:** Apply two-level disclosure:

**Level 1 (quick start):** Show only the `env` backend. The `.env.example` credential decision block (Recommendation 1.1) is the only thing a new user needs.

**Level 2 (linked from quick start):** A "Production hardening" or "Upgrade your setup" document (or a section in the README behind a heading) covers Bitwarden and OneCLI with their prerequisites, tradeoffs, and migration path from `env`.

This means a non-expert never sees `BW_SESSION` or `ONECLI_GATEWAY_URL` until they explicitly choose to upgrade. An enterprise operator following their organization's deployment guide will go directly to the advanced section.

---

### 2.3 Security Mode Disclosure

The configuration table includes `OPENGOLEM_SECURITY_MODE | golem_guard | Inspector mode: golem_guard | supervised | power` without explanation of what each mode means or when to change it.

**Finding 2.3: Security mode options are listed without behavioral description.**

A non-expert reading `power` in a security context may assume it provides more security. The name suggests capability, not reduced protection.

**Recommendation 2.3:** Rename the README table entry and add a one-line behavioral note:

| Variable | Default | Description |
|---|---|---|
| `OPENGOLEM_SECURITY_MODE` | `golem_guard` | Inspector mode. `golem_guard` (default): all checks enforced automatically. `supervised`: checks enforced, but you confirm ambiguous cases. `power`: reduced checks for advanced users only. **Do not change from the default unless you understand the tradeoffs.** |

The warning note ("Do not change from the default unless you understand the tradeoffs") is a responsible AI recommendation. The `power` mode materially weakens the inspection layer, and its documentation must not imply this is a desirable upgrade.

---

## 3. Error Message Clarity at Startup Failures

### 3.1 Broker Unreachable

**Architecture context (ARCHITECTURE.md §1.3):** The Token Broker must be listening on its Unix socket before the orchestrator starts. If the broker socket is unavailable at orchestrator startup, the orchestrator must queue messages and not spawn containers.

**Current state:** The orchestrator spec (§3.1) defines that the orchestrator "contacts broker at boot for health check" and blocks container spawn until all dependencies are healthy. The specific error message surfaced to the operator when the broker is unreachable is unspecified.

**Recommended error message for broker unreachable at startup:**

```
OpenGolem: Token Broker is not running or not reachable.
  Expected socket: data/sockets/broker.sock
  The Token Broker must start before the orchestrator.

  If you are using the default single-process mode (npm run dev):
    This may be a startup race condition. Try restarting.

  If you are running processes separately:
    Start the Token Broker first, then the orchestrator.

  System is in safe-hold: messages will queue but no tasks will run
  until the Token Broker is reachable.
```

Design principles for this error:
1. Names the missing component in plain English, not as a code identifier.
2. States where the socket is expected (useful for debugging).
3. Offers two recovery paths based on likely deployment modes.
4. Explicitly states the system behavior (safe-hold, messages queue) so the operator is not left wondering whether the system is broken or just waiting.

---

### 3.2 Cato Socket Missing

**Architecture context:** Cato must also be listening before the orchestrator starts. Cato unavailability is fail-closed — no action proceeds without Cato.

**Recommended error message for Cato socket missing:**

```
OpenGolem: Cato oversight process is not running or not reachable.
  Expected socket: data/sockets/cato.sock
  Cato must start before the orchestrator.

  No containers will be spawned until Cato is reachable.
  This is intentional — all actions require Cato approval.

  Recovery:
    If running as a service: check Cato's process status.
    If running manually: start Cato before the orchestrator.
    Logs: check stderr for the Cato process startup output.
```

The critical line here is "This is intentional — all actions require Cato approval." A non-expert might interpret Cato unavailability as a bug or a feature they could skip. The error message must make clear that this is an architectural requirement, not a configuration option.

---

### 3.3 Missing `.env` File

**Current state:** If `.env` does not exist and no environment variables are set, the Token Broker fails to resolve credentials. The specific error depends on the credential backend; for the `env` backend, it would be "ANTHROPIC_API_KEY is not set."

**Finding 3.3:** The error will reference the variable name (`ANTHROPIC_API_KEY`) without telling the user that the `.env` file is missing. A non-expert who has not run `cp .env.example .env` will see an environment variable error and not know where to look.

**Recommended error message sequence:**

First, the Token Broker (or a startup check) should test for the existence of `.env`:

```
OpenGolem: No credential configuration found.
  Expected: a .env file in the project directory, or environment variables set.

  Quick fix:
    cp .env.example .env
    # then add your Anthropic API key to .env

  See README.md → Quick start for credential setup.
```

If `.env` exists but the credential variable is missing:

```
OpenGolem: Credential not found in .env.
  ANTHROPIC_API_KEY is not set and CLAUDE_CODE_OAUTH_TOKEN is not set.

  Open .env and uncomment one of:
    ANTHROPIC_API_KEY=your-key-here     (from console.anthropic.com)
    CLAUDE_CODE_OAUTH_TOKEN=your-token  (from: claude setup-token)
```

The second message does what the `.env.example` credential decision block (Recommendation 1.1) does at setup time: it surfaces the decision, not just the missing variable name.

---

### 3.4 Container Build Not Run

**Finding 3.4:** If a user runs `npm run dev` without running `./container/build.sh`, the first message they send will trigger a container spawn that fails because the image does not exist. The error will come from Docker ("No such image: opengolem-agent") and will appear in logs, not at the prompt.

**Recommended startup check:** The orchestrator (or a startup script) should check for the presence of the agent container image before accepting any messages:

```
OpenGolem: Agent container image not found.
  Expected image: opengolem-agent (or as configured in CONTAINER_IMAGE)

  Build the image with:
    ./container/build.sh

  Note: this takes 2–5 minutes on first run.
```

This check should run at startup and produce output to the TUI before the `opengolem>` prompt appears, so the operator sees it before sending their first message.

---

## 4. Annotated User Flow

### Flow: First Run → Channel Registration → Group Creation → Skill Application

---

**Step 1: Clone and configure**

```
git clone <repo>
cd OpenGolem
cp .env.example .env
# [edit .env — see credential decision block in .env.example]
```

Cognitive load: Medium. Reduced by Recommendation 1.1 (credential decision block in `.env.example`).

Failure modes:
- User adds the wrong credential variable → authentication error at container startup. Recovery: the error message (Recommendation 3.3) tells them which variable is needed.
- User does not edit `.env` at all → startup check (Recommendation 3.3) fires before any message is processed.

No current recovery path: if a user uses an expired or revoked API key, the error comes from the Anthropic API (HTTP 401) and is returned inside the container sentinel protocol. The TUI shows a task error without identifying the credential as the problem. **Recommended addition:** map HTTP 401/403 from the credential proxy to a specific startup-visible error: "Your Anthropic API key appears to be invalid or expired. Check your key at console.anthropic.com."

---

**Step 2: Install and build**

```
npm install
npm run build
./container/build.sh
```

Cognitive load: Low (after Recommendation 1.3 adds Docker check to `build.sh`).

Failure modes:
- Docker not running → Docker error, no OpenGolem context. Fixed by Recommendation 1.3.
- Build fails due to network (npm registry, Docker hub): errors from the underlying tool, not OpenGolem. No action recommended — these are transient infrastructure failures.

---

**Step 3: First run**

```
npm run dev
```

Expected TUI output (recommended, adding Recommendations 1.3 and R1 from Stream J):

```
OpenGolem starting...
  Token Broker:  ok
  Cato:          ok
  Channels:      tui

[golem_guard | tui] blocks: 0
opengolem>
```

Failure modes at this step:
- Broker unreachable → error per Recommendation 3.1, then system enters safe-hold.
- Cato unreachable → error per Recommendation 3.2, no tasks proceed.
- Container image missing → check per Recommendation 3.4, fires before first message is processed.
- `.env` missing or credential absent → error per Recommendation 3.3.

**Current bad state with no recovery path:** If all three processes (orchestrator, broker, Cato) are started manually in the wrong order, the orchestrator's health check fails and the system enters safe-hold silently. The TUI shows the prompt but no messages are processed. There is no indication that the system is waiting for dependencies. **Recommendation:** The TUI status hint (Stream J R1) should include a dependency status indicator: `[waiting for Cato]` or `[broker: unreachable]` until all dependencies are healthy. Do not show the normal `opengolem>` prompt until the system is ready to process messages.

---

**Step 4: Send first message (default group)**

The first message sent at the `opengolem>` prompt triggers container spawn for the default group.

Cognitive load: None — it is a chat interface.

Failure modes:
- Invalid API key → container returns error via sentinel protocol. The orchestrator receives `"status": "error"` and routes it to the TUI. **Current state:** the TUI displays the error as an agent response (same visual treatment as a normal response). A non-expert will not know whether this is the agent saying something, or a system error. **Recommendation:** error responses from the sentinel protocol should be prefixed with a system notification style: `[System error] Container failed: authentication failed with the API. Check your API key in .env.`

---

**Step 5: Add a channel (Telegram)**

```
# In .env:
TELEGRAM_BOT_TOKEN=<token from @BotFather>
OPENGOLEM_CHANNELS=tui,telegram
# Restart OpenGolem
```

Cognitive load: Medium for a non-expert (finding @BotFather, understanding what a "bot token" is, knowing to restart). Reduced by adding a four-step ordered flow to the README (Stream J Recommendation R7).

Failure modes:
- `OPENGOLEM_CHANNELS` set but `TELEGRAM_BOT_TOKEN` missing → TUI shows a log warning. **Recommendation:** this should also produce a startup advisory in the TUI: "Telegram is listed in OPENGOLEM_CHANNELS but TELEGRAM_BOT_TOKEN is not set. Telegram will not be available until you add this to .env."
- Valid token but bot has never been messaged → bot is connected but idle. This is not an error state; the TUI status hint will show `tui telegram` as active channels, confirming success.

**Current bad state with no recovery path:** if a user sets `OPENGOLEM_CHANNELS=telegram` (only) without a TTY, the TUI adapter is disabled and Telegram is the sole channel. If the bot token is invalid, the system is running but completely unreachable — no TUI, no Telegram. There is no way to receive the error except via log files. **Recommendation:** in headless mode (no TTY), if Telegram fails to connect, the system should write a startup error to stderr with a recovery path: "No channels are available. Check your TELEGRAM_BOT_TOKEN and restart."

---

**Step 6: Group creation**

Groups are created by directory (a `groups/{name}/` directory with a `CLAUDE.md` file). The orchestrator creates `CLAUDE.md` automatically on first spawn (orchestrator-spec.md §2.5). The README does not document explicit group creation.

**Finding 4.6:** Group creation is implicit. A non-expert who wants to create a second group (e.g. for a different context) has no documented path.

**Recommendation 4.6:** Add a "Working with groups" section to the README:

```
## Groups

OpenGolem routes every conversation to a named group. The default group is created
automatically when you first send a message.

To create a new group:
  mkdir groups/mygroup
  # Optional: add a CLAUDE.md with initial context for that group

To route a channel to a specific group, configure the group ID in your channel settings
or use the /setup skill.
```

The specifics of group-to-channel routing are not fully documented in what has been read for this review; this recommendation should be validated against the channel adapters spec before being written.

---

**Step 7: Skill application**

Skill application (e.g. `/add-telegram`, `/claw`) is documented as a skill catalog in the CLAUDE.md developer reference. The README does not describe how to apply skills.

**Finding 4.7:** The path from "I want to add a capability" to "I have applied a skill" is not documented in the README. A user who reads the README features list (which mentions skills) and wants to apply one has no documented next step.

**Recommendation 4.7:** Add a skills subsection to the README immediately after the channel notes:

```
## Adding capabilities (skills)

OpenGolem's capabilities are extended through skills. To apply a skill,
open Claude Code in this directory and use the skill's slash command:

  /add-telegram      — Add Telegram as a channel
  /add-whatsapp      — Add WhatsApp as a channel
  /claw              — Install the command-line agent tool
  /debug             — Troubleshoot container issues

Skills are documented in their own guides. Run any skill command to see its
setup flow.
```

---

## 5. Steps Where a User Can Reach a Bad State with No Clear Recovery Path

The following are the steps where the current documentation and system behavior leave a user stranded without a clear next action. They are ordered by likelihood of occurrence for a non-expert user.

| # | Trigger | Bad state | Gap | Recommendation |
|---|---------|-----------|-----|----------------|
| B-1 | Wrong credential variable in `.env` | Authentication error inside container, displayed as agent error response | Error message does not name the credential problem | Map HTTP 401/403 from proxy to startup-visible credential error |
| B-2 | Docker not running when `./container/build.sh` is run | Docker error output with no OpenGolem context | No Docker health check before build | Add Docker check to `build.sh` (Recommendation 1.3) |
| B-3 | Orchestrator starts before Broker or Cato in manual deployment | System in safe-hold with no visible indicator | TUI prompt appears even when system cannot process messages | Do not display `opengolem>` prompt until all dependencies are healthy (Recommendation 3.1 + 3.2) |
| B-4 | Container image not built before first message | Docker "no such image" error in logs, no TUI surface | No startup check for container image | Add image existence check at startup (Recommendation 3.4) |
| B-5 | Telegram-only headless deployment with invalid bot token | No channels reachable, no way to receive error | No stderr fallback documented for headless channel failures | Write startup error to stderr in headless no-channel state (step 5 finding) |
| B-6 | User wants a second group | No documented path for group creation | Group creation is implicit | "Working with groups" section in README (Recommendation 4.6) |
| B-7 | User wants to apply a skill | No documented path from README to skill application | Skill catalog only in developer docs | Skills subsection in README (Recommendation 4.7) |
| B-8 | `.env` present but both credential variables missing | Token Broker fails with variable name error, no `.env` guidance | Error message names variable but not file or recovery | Error message maps missing variable to `.env` edit path (Recommendation 3.3) |

---

## Summary of Recommendations

| # | Area | Recommendation | Priority |
|---|------|---------------|----------|
| 1.1 | `.env.example` | Add commented credential decision block (Option A/B/C) | High |
| 1.2 | Quick start | Reframe `npm test` as optional verification | Low |
| 1.3 | `container/build.sh` | Add Docker health check with OpenGolem-attributed error | High |
| 1.4 | Credential backends | Add hierarchy (env → bitwarden → onecli) with "if unsure, start with env" | Medium |
| 2.1 | README structure | Three-zone restructure: Getting started / Add a channel / Reference | Medium |
| 2.2 | Credential backend disclosure | Show only `env` in quick start; Bitwarden/OneCLI in a linked advanced section | Medium |
| 2.3 | Security mode documentation | Rename table entry to include behavioral description and "do not change from default" warning | High |
| 3.1 | Broker unreachable | Specify error message with component name, socket path, deployment-mode recovery, and safe-hold statement | High |
| 3.2 | Cato missing | Specify error message with "this is intentional — all actions require Cato approval" | High |
| 3.3 | Missing `.env` / missing variable | Two-level error: file missing → file but variable missing; both with recovery action | High |
| 3.4 | Container image not built | Add startup check for image existence; fire before first message prompt | High |
| 4.6 | Group creation | Add "Working with groups" section to README | Medium |
| 4.7 | Skill application | Add skills subsection to README with slash command list | Medium |

---

## Open Questions for PM

1. **Startup dependency display:** Should the TUI prompt be suppressed until all dependencies (Broker, Cato) are healthy, or should the prompt appear with an advisory? Suppression is safer UX but changes the current behavior. Advisory preserves the prompt but may be ignored.

2. **Bad state B-1 (wrong credential):** Mapping HTTP 401/403 from the credential proxy to a TUI-visible message requires the orchestrator to inspect the container's error result and classify it. Is this the right place for that classification, or should the credential proxy return a structured error that the orchestrator can identify directly?

3. **Headless channel failure (bad state B-5):** The recommendation is to write to stderr in headless no-channel state. The architecture specifies no web UI and no push notification to the operator. Is stderr the agreed fallback for this failure, or should the system write to a failure log file that the operator checks?

4. **Group creation documentation:** The path from a channel message to a group is implicit in the architecture (group directory + CLAUDE.md). Is explicit group creation (via a CLI command or a documented directory convention) on the roadmap, or is the implicit model intentional?

---

*Produced: 2026-04-07 | Awaiting PM approval*
