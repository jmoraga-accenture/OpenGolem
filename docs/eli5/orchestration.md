# How Does OpenGolem Work?

This document walks through what happens from the moment a user sends a message to the moment they get a reply. Every major step and handoff is covered.

## The three permanent processes

OpenGolem runs three long-lived programs on the host machine:

**The Orchestrator** is the coordinator. It receives incoming messages, manages the task lifecycle, and routes replies back to the user. It holds no secrets and makes no safety decisions — it asks others for those.

**The Token Broker** is the vault. It holds the real API credentials (the secret passwords that allow calls to Anthropic's servers) and never hands them out directly. It issues temporary, limited-use passes to tasks and revokes them when tasks finish.

**Cato** is the gatekeeper. It receives yes/no questions — "should this action be allowed?" — and returns an allow or block decision. It cannot be addressed by users or instructed by the agent.

A fourth kind of process exists but is temporary: the **agent container**, one per task, started when a task begins and removed when it ends.

---

## Step-by-step: what happens when you send a message

### 1. Your message arrives

A **channel adapter** (code running inside the Orchestrator's own process) receives the message in the channel's native format — Telegram's wire format, or a line of text from the command line — and converts it into the Orchestrator's internal format. Think of it as a translator at the front door.

### 2. The message enters a queue

The Orchestrator places your message in a queue for your group. Only one task runs per group at a time. If a task is already running, your message waits.

### 3. Cato checks before anything starts

The Orchestrator sends a check request to Cato over a **local communication pipe** (a channel that exists only on the host machine, not on the network) before starting any work. If Cato's pipe is unreachable, the Orchestrator treats that as a block — no task starts without a Cato allow response.

### 4. The Token Broker issues a temporary pass

The Orchestrator asks the Token Broker for a token scoped to this task: which services the agent may call, how many API calls are permitted, and which memory areas the agent can touch. The Broker creates a signed token — like an event wristband encoding exactly which areas you're allowed into — and returns it. The token is never written to disk.

### 5. An agent container is started

The Orchestrator starts a fresh, isolated Linux container — think of it as a locked room — configured precisely:

- The group's working directory is attached, so the agent can read its context and write files.
- A shared read-only directory for documents available to all groups is attached.
- All API calls are directed to the **credential proxy** — a local HTTP service run by the Token Broker — rather than to Anthropic directly. The agent never learns the real API endpoint or credentials.
- The task description is written to a file in the group directory before the container starts. The agent reads it from there via the attached directory.

No raw API key appears anywhere in the container's environment.

### 6. The agent makes API calls through the credential proxy

The agent runtime (Claude Agent SDK) starts inside the container and begins working. When it needs to call the AI model, it sends that request to the proxy URL it was given. The Token Broker intercepts every request and hands it to the **Call Inspector**.

### 7. The Call Inspector checks every outbound call

The Call Inspector runs five checks on every outbound API call before it goes to the network:

- Is the endpoint one the agent is allowed to call?
- Does the request reference memory areas outside this task's permitted scope?
- Does the request match patterns suggesting unauthorized instructions were inserted?
- Is the call rate anomalous?
- Is the target URL within the declared endpoint set for this task?

If all checks pass, the Token Broker replaces the temporary pass with the real credential and forwards the call. If a check fails, the call is blocked and logged.

### 8. What happens when a check is ambiguous

When a check returns neither a clear pass nor a clear fail, the Call Inspector does not guess. It routes the question: **Call Inspector → Token Broker → Orchestrator → Cato**. The Token Broker sends the question to the Orchestrator (over a second local pipe), and the Orchestrator forwards it to Cato. Cato returns allow or block. The answer travels back the same way. The Token Broker and Cato never communicate directly — the Orchestrator is the relay.

### 9. The agent produces a result

When the agent finishes, it writes its response to its standard output (the normal text output channel for any program) between two fixed marker lines:

```
---OPENGOLEM_OUTPUT_START---
{"status":"success","result":"...","newSessionId":"..."}
---OPENGOLEM_OUTPUT_END---
```

The Orchestrator reads the agent's output stream, extracts what appears between the markers, and discards the rest. The agent cannot initiate contact with the Orchestrator — the Orchestrator reads the output passively.

### 10. Reply and cleanup

The Orchestrator passes the result to the channel adapter, which formats it for the channel and delivers it to the user.

Then: the temporary pass is revoked with the Token Broker, the container is stopped and removed, and a record of the completed task is written to the audit log.

If the agent proposed memory updates (notes for future sessions), the Orchestrator asks Cato for a check before committing them. No memory update is written without a Cato allow response.

---

## What happens when something is blocked

If Cato blocks an action, the task stops. The agent translates the block into a plain-language explanation for the user — naming the risk category without reproducing the blocked content. The user always receives an explanation; the system never goes silent on a block. The decision and explanation are written to the audit log.

---

## What the agent cannot do

These restrictions are structural — there is no communication channel, not just a rule:

- The agent cannot send requests to the Orchestrator. Its only output is the stdout stream the Orchestrator reads passively.
- The agent cannot contact Cato.
- The agent can only reach the Token Broker through the credential proxy.
- The agent cannot read another group's files.
- The agent cannot write to the audit log.
