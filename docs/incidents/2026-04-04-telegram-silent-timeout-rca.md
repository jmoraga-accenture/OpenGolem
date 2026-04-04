# RCA / FMA — Telegram group silent runs and container timeouts

**Date:** 2026-04-04  
**Status:** Closed (analysis) — follow-up actions tracked below  
**Scope:** Telegram group chats `tg:-5192058114`, `tg:-5029230580`; collateral: Cato audit, Telegram DM, credential proxy  

---

## 1. Executive summary

On 2026-04-04, two Telegram **group** sandboxes produced **poor user-visible behavior**: long periods with **no or minimal bot text**, while the host still had containers running or eventually recorded completion.

The host’s **hard timeout** is driven by **complete OpenGolem stdout marker frames** (`---OPENGOLEM_OUTPUT_START---` … `---OPENGOLEM_OUTPUT_END---`). If **no** such frames arrive for the configured window (~30 minutes by default), the container is stopped (**exit 137**, “timed out with no output”). **Stderr does not** extend the timeout.

A **`/status`** request in a **non-main** group correctly triggered the **status** skill’s **“main chat only”** reply (short text), which users can misread as “Telegram is broken” rather than “by design for this mount layout.”

The **credential proxy** logged **upstream HTTP timeouts (30s)** during the same window—consistent with API stress but **not** sufficient alone to assign a single root cause inside the agent.

---

## 2. Affected systems

| Chat / system | JID / folder | What happened |
|---------------|--------------|----------------|
| Jim, George and Alef-mark-01 | `tg:-5192058114` / `tg-g-5192058114` | First run: **~30 min**, **no streamed stdout markers** → **timeout**, **retry** with **3** batched user messages → **94-char** Telegram send (consistent with `/status` “main chat only” copy). Later run **completed** (~30 min, streaming mode). |
| Jim and Alef-mark-01 | `tg:-5029230580` / `tg-g-5029230580` | DB last user text: **“are you there?”** (not `/status`). **One 20-char** Telegram message, **~30 min silence**, then **successful** host completion. |
| Telegram DM | `tg:7448431705` | **Healthy**: large reply in ~seconds; separate long run **completed** (shows stack *can* work under load). |
| Cato (scheduled audit) | `Cato` | **Same pattern**: **~30 min**, timeout, **no output**—suggests **systemic** “no marker” risk, not Telegram-only. |

---

## 3. Evidence sources

| Source | Use |
|--------|-----|
| `logs/opengolem.error.log` | Timestamps, spawn/timeout/retry, agent output lengths, Telegram send lengths, proxy timeout error |
| `groups/tg-g-5192058114/logs/container-2026-04-04T04-32-38-342Z.log` | Timeout artifact: `Had Streaming Output: false`, exit **137**, duration **~1 831 277 ms** |
| `store/messages.db` | User message text per `chat_jid` (confirms **`/status`** on `tg:-5192058114` only, not `tg:-5029230580`) |
| `src/container-runner.ts` | Timeout **only** resets on parsed stdout marker JSON; stderr ignored for timeout |
| `src/config.ts` | `CONTAINER_TIMEOUT` / `IDLE_TIMEOUT` default **1 800 000 ms** (30 min) |
| `src/credential-proxy.ts` | Upstream request **30s** timeout |
| `container/skills/status/SKILL.md` | Non-main → fixed “main chat only” reply |

---

## 4. Reconstructed timeline (host log clock)

Log timestamps below match `opengolem.error.log` on the incident host. Container log **2026-04-04T04:32:38Z** aligns with log **07:32:38** (**UTC+3** local vs **UTC** artifact).

| Time (log) | Event |
|------------|--------|
| 06:10 | Cato audit: container spawned |
| 06:40 | Cato: **timeout**, **no output**, **~30.5 min**, code **137** |
| 07:01 | Telegram DM: processed; **~1735 chars** sent ~18 s later (healthy) |
| 07:02:07 | `tg:-5192058114`: **1** message, container `…5192058114-1775275327069` spawned |
| 07:04:09 | `tg:-5029230580`: **1** message, container `…5029230580-1775275449153` spawned |
| 07:04:13 | `tg:-5029230580`: **Agent output 20 chars** → Telegram length **20** |
| 07:04:23 | `tg:-5192058114`: further user message **stored** (queued; container already active) |
| 07:05:06 | `tg:-5192058114`: **New messages count 1** |
| 07:06:45 | **ERROR**: credential proxy **upstream timed out after 30s** |
| 07:31:30 | Telegram DM long run **completed** (streaming) |
| 07:32:37–38 | `tg:-5192058114`: **Container timeout**, **no output**, **~1 831 277 ms**, **137**; `Had Streaming Output: **false**` |
| 07:32:38 | Message cursor **rolled back**; retry **5 s** backoff |
| 07:32:43 | Retry: **`messageCount: 3`** (batched backlog) |
| 07:32:54 | **94 chars** agent output → Telegram `tg:-5192058114` length **94** |
| 07:34:14 | `tg:-5029230580`: **Container completed** (streaming), **~1 804 953 ms** |
| 08:02:55 | `tg:-5192058114`: **second** long run **completed** (~30 min) |

---

## 5. Failure modes (FMA)

| ID | Mode | Mechanism | User effect | Detection |
|----|------|-----------|-------------|-----------|
| FM-1 | **No stdout markers** for full hard timeout | `container-runner` kills container; `hadStreamingOutput === false` | No bot text ~30 min; then error/retry | `Container timed out with no output`, timeout log |
| FM-2 | **Sparse markers** | First marker resets clock; long gap before next user-visible `result` | One short line, then silence | `Agent output: N chars` once, long gap |
| FM-3 | **Credential proxy upstream > 30s** | Proxy aborts single upstream request | In-container failures/retries; unclear in Telegram | `Credential proxy upstream request timed out after 30s` |
| FM-4 | **`/status` on non-main** | `container/skills/status` → `NOT_MAIN` branch | Short “use main chat” reply | Expected; can confuse users |
| FM-5 | **Cato no-output timeout** | Same marker/timeout rules | Audit status **unknown** | Cato timeout lines in host log |

---

## 6. Root cause analysis

### 6.1 Direct mechanism (established)

- **`tg:-5192058114` first run:** The agent process did **not** emit **any** complete OpenGolem stdout marker JSON for **~30 minutes** → host **stopped** the container (**137**, “timed out with no output”). **Retry** reprocessed **three** user messages together; the **94-character** reply matches the **status** skill length for the “main chat only” message.
- **`tg:-5029230580`:** At least **one** early marker (20-char user-visible send) **reset** the hard timeout; **no further** user-visible streamed results until **~30 minutes** later, when the run **completed successfully** on the host.

Reference (timeout reset only on markers):

```450:474:src/container-runner.ts
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
```

### 6.2 Contributing factors (hypotheses to validate)

1. **Upstream latency or errors** (proxy **30s** timeout observed same window).  
2. **Long tool loops / session behavior** inside the agent without flushing markers.  
3. **Parallel long jobs** (Cato + multiple containers) increasing contention or confusion during triage.

### 6.3 What logs cannot prove

- Per-request Anthropic payloads/responses at default log level.  
- Full in-container transcript without **verbose** container logs or Claude session files under the group workspace.

---

## 7. Recommended actions

| Priority | Action | Owner |
|----------|--------|--------|
| P1 | For incidents: run with **`LOG_LEVEL=trace`** (or equivalent) so **stdout/stderr** are persisted in `groups/.../logs/container-*.log` on non-zero paths as already documented in `container-runner` | Ops |
| P2 | **Metrics/alerts**: rate of `Container timed out with no output`, `Credential proxy upstream request timed out`, **time-to-first-marker** | Engineering |
| P3 | **Product copy**: clarify in docs or skill that **`/status` full report is main-chat-only**; optional pointer to **`npm run status`** / **`/health`** for host operators | Docs / skills |
| P4 | **Investigate** agent/SDK path when **no markers** for 30+ minutes (repro with captured session) | Engineering |

---

## 8. Related documentation

- `docs/INTERNALS.md` — message loop, queueing, startup  
- `docs/SPECS.md` — architecture  
- `container/skills/status/SKILL.md` — `/status` behavior on non-main mounts  
- `CLAUDE.md` — sentinel protocol and dev commands  

---

## 9. Revision history

| Date | Author | Change |
|------|--------|--------|
| 2026-04-04 | OpenGolem (RCA draft) | Initial reconstruction from logs and DB |
