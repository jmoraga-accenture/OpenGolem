# What Does Each Part Do?

A reference for developers who want to understand the components before reading the full architecture. Each section is self-contained.

---

## Orchestrator

The Orchestrator is the central coordinator of the system. It is the only component that drives the full lifecycle of a task: receiving an inbound message, deciding when to start processing it, requesting a token, starting the agent container, waiting for the result, routing the reply back to the user, and cleaning up.

Think of it as a dispatcher at a shipping depot: it receives packages (messages), assigns resources, tracks every shipment in progress, and makes sure deliveries go to the right door — but it does not open the packages or decide whether they're safe to ship. Those decisions belong to other components.

**What it does not do:** The Orchestrator holds no API credentials. It makes no safety decisions on its own — every significant action is either permitted by Cato or scoped by a token from the Token Broker. It does not implement channel protocols (those are the Channel Adapters). It does not execute any agent logic.

---

## Token Broker

The Token Broker is the sole keeper of long-lived API credentials — the secret keys that authorize calls to the AI provider. It never hands those keys out directly. Instead, it issues temporary, scoped tokens: a token carries exactly what one task is allowed to do (which services to call, how many calls are permitted, which memory areas to access). When the task ends, the token is revoked.

Think of it as a hotel key desk. Guests never get a master key to the whole building. They get a room key that opens their specific room for their specific stay. When they check out, the key stops working.

The Token Broker also runs the **credential proxy**: an HTTP service that intercepts every API call from the agent, validates the token, runs the Call Inspector, and — on pass — injects the real credential before forwarding the call.

**What it does not do:** The Token Broker makes no routing or scheduling decisions. It does not contact Cato (the oversight process) directly — all Cato interactions are relayed through the Orchestrator. It never writes to the agent filesystem or manages containers.

---

## Call Inspector

The Call Inspector is a component inside the Token Broker that examines every outbound API call before it leaves the machine. It runs five checks in order: is the endpoint declared as allowed? does the request reference memory areas outside the task's scope? does the content match patterns associated with **prompt injection** (attempts to slip unauthorized instructions into the conversation text)? is the call rate anomalous? is the target URL within the permitted set?

Think of it as a customs inspector for outbound shipments. Every package leaving the building goes across the inspection table. Most packages pass without comment. Some are flagged and stopped. A few are ambiguous — those get sent upstairs to a supervisor (Cato) for a judgment call.

The Call Inspector is a rule-based system: it applies deterministic checks. When a check produces an ambiguous result, it escalates to Cato through the Orchestrator rather than guessing.

**What it does not do:** The Call Inspector does not reason about the broader intent of a task. It checks individual calls, not overall behavior. Behavioral analysis over time belongs to Cato's scheduled audit.

---

## Cato

Cato is the oversight process. It has two distinct functions.

**Inline check:** Cato receives a short, structured question from the Orchestrator before significant actions: starting an agent task, writing to memory, making an outbound call when the Call Inspector is uncertain. It returns allow or block. This response is binding — if Cato blocks, the action does not proceed, with no exceptions. If Cato is unreachable, the system treats that as a block.

**Scheduled audit:** Cato also runs a periodic deep review of the full audit log, looking at patterns across all recent tasks. It computes three performance metrics (security failures per call, data leaks per call, behavioral change rate) and writes a structured report for the administrator.

Think of Cato as two things at once: a security guard who checks IDs at the door (the inline check, fast and binary) and an internal auditor who reviews the logbook every six hours and writes a summary for management.

Cato uses rule-based pattern matching for its inline checks. When a check is ambiguous — meaning the rules can't reach a confident answer — it applies a constrained AI judgment, but only for specific, pre-defined questions. It cannot decide it needs to answer a different question.

**What Cato does not do:** Cato never addresses users. It never adjusts its own thresholds based on what it finds — threshold changes require an administrator decision. It holds no credentials and manages no containers.

---

## Memory Tiers

Agents need to remember things, but not all memory is the same. OpenGolem uses three tiers, each with different scope, lifetime, and access control.

**Tier 1 — Operational memory.** A markdown file per group (`groups/{name}/CLAUDE.md`). It holds recent decisions, active task context, and group-specific preferences. The agent can read and propose updates to it; the Orchestrator applies those updates only after Cato approves them. Think of it as a notepad on the agent's desk — visible during work and writable at the end of a session, but not without sign-off.

**Tier 2 — Episodic memory.** A database file per group, holding the full message history and task records for that group. Agents do not access it directly — the Orchestrator reads relevant excerpts and injects them as context before a task starts. Think of it as a filing cabinet of past conversations that only the Orchestrator can open.

**Tier 3 — Strategic memory.** A single shared database covering all groups, used to store cross-group patterns and long-term observations. Agents do not query it directly. The Orchestrator reads relevant entries and injects them as context for high-stakes tasks, but only after the Call Inspector approves the write that created each entry. Think of it as a background research library — agents never walk in themselves, but the Orchestrator can pull relevant pages for them.

Each tier is more restricted than the one before. Cross-group data only exists in Tier 3, where access is the most heavily mediated.

---

## Skill Schema

A skill is an administrator-approved extension to the Golem's capabilities. Skills are explicit: no new capability is discovered at runtime. Every skill carries a declaration file listing exactly what it adds: which service endpoints the agent will be allowed to call, which files or directories it needs access to, and who is permitted to apply it.

The Orchestrator validates this declaration when a skill is applied. If any field is missing or invalid, the skill is rejected. Once applied, the new capability takes effect for the next task — the token scope is updated accordingly, and the Call Inspector's permitted endpoint list expands to include what the skill declared.

Think of a skill as a building permit: you describe exactly what you're going to build, the inspector checks the plans, and only then are you allowed to proceed.

---

## Channel Adapters

Channel adapters are the pieces of code that connect the Orchestrator to the outside world. Two ship by default: the **TUI** (Terminal User Interface — the interactive `opengolem>` prompt in a terminal window) and **Telegram**. Others can be added via skills.

Each adapter handles the translation in both directions: incoming messages are converted from the channel's native format into the Orchestrator's internal format, and outgoing replies are converted back to whatever syntax the channel expects.

The adapters run inside the same process as the Orchestrator — they share its trust level. Adding a new channel is done by applying a channel feature skill, which adds the adapter code and registers it at startup.

**What they do not do:** Channel adapters contain no business logic. They do not route messages, make safety decisions, or store anything. They are translators only.

---

## Container Runner

The Container Runner is the part of the Orchestrator responsible for spawning and tearing down agent containers. When a task is ready to start, the Container Runner assembles the configuration: which directories to attach to the container (the group's working directory, the shared read-only context directory), which environment variables to set (the credential proxy URL, the assistant name, the task-specific settings), and resource limits (CPU and memory caps).

It starts the container, monitors its output for the result markers that signal task completion, and tears the container down when the task is done or when a time limit is reached.

The Container Runner never puts a raw API key in the container's environment. Credentials are always mediated through the Token Broker's proxy.

**What it does not do:** The Container Runner does not decide whether a task should start (that's the Orchestrator's logic, with Cato's approval). It does not communicate with the agent inside the container once it is running — all agent output is captured from the container's output stream and parsed for the result markers.
