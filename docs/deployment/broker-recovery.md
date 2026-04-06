# Broker Crash Recovery Procedure

**Who this is for:** Operators who find that OpenGolem has stopped responding to messages, or who have received an alert that the Token Broker process has crashed. You need terminal access to the host where OpenGolem is running. No sysadmin expertise is required.

**When to use it:**
- OpenGolem stops processing messages and the broker process is not running
- Users receive unexpected interruption notifications
- You see `broker_loss_teardown` events in the audit log without a corresponding planned rotation
- The broker socket (`data/sockets/broker.sock`) is missing or unresponsive

**Source authority:** `orchestrator-spec.md` §mid-task broker loss; `token-broker-spec.md` §health; Decision 37; Finding F-5.

---

## How the orchestrator detects broker loss

The orchestrator monitors the broker socket continuously during active tasks. Every 5 seconds while a container is running, it checks whether `data/sockets/broker.sock` is responsive. If the socket is **unresponsive for two consecutive checks** (10 seconds total), the orchestrator treats the broker as lost and takes automatic protective action.

You do not need to trigger this — it happens automatically.

---

## What happens automatically when the broker crashes

When broker loss is confirmed, the orchestrator does the following without any operator input:

1. **Tears down all running agent containers** — every active task is immediately stopped. The orchestrator does not wait for the container TTL.

2. **Writes `broker_loss_teardown` audit events** — one entry per torn-down container, with fields `taskId`, `contextId`, and `reason: "broker_unavailable"`. Token revocation is noted as non-enforceable (the broker is unavailable), so the audit record documents this gap.

3. **Notifies affected users** — each user whose task was torn down receives a message via their channel saying the task was interrupted.

4. **Enters reconnect wait mode** — the orchestrator retries the broker socket at 10-second intervals. No new tasks are dispatched until the broker reconnects. Inbound messages are queued.

5. **Writes `broker_reconnected`** — when the broker comes back and the socket responds, the orchestrator logs this and resumes normal task dispatch.

---

## Operator response procedure

### Step 1 — Confirm the broker is down

Check whether the broker socket responds:

```bash
echo '{"jsonrpc":"2.0","method":"health","params":{},"id":1}' | \
  nc -U data/sockets/broker.sock
```

If you get a response, the broker is running (it may have already recovered). If the command hangs or gives a "no such file" error, the broker is down — continue with Step 2.

### Step 2 — Check the logs to understand why it crashed

**On systemd (Linux):**

```bash
# View recent broker logs (substitute the correct service name if different)
journalctl -u opengolem-broker --since "30 minutes ago" --no-pager

# If the broker runs as part of a single combined service
journalctl -u opengolem --since "30 minutes ago" --no-pager
```

**On launchd (macOS):**

```bash
# Check the log files you configured in the plist
tail -100 /tmp/opengolem-error.log
tail -100 /tmp/opengolem.log
```

**On WSL / manual start:**

```bash
# Check whichever log file your startup script writes to
tail -100 logs/opengolem.log 2>/dev/null || tail -100 /tmp/opengolem.log 2>/dev/null
```

Look for lines containing `FATAL`, `Error`, `ENOENT`, `EADDRINUSE`, or `credential_backend_unreachable`. Common causes:

| Log message | Likely cause |
|-------------|--------------|
| `credential_backend_unreachable` | `.env` key missing, Bitwarden unreachable, OneCLI vault not running |
| `EADDRINUSE` | A stale socket file was left by the previous crash; needs cleanup |
| `EACCES` | Socket directory permissions are wrong |
| `Cannot find module` | `npm run build` was not run after a code change |
| Out-of-memory / killed | System memory pressure — check `dmesg | grep -i oom` |

### Step 3 — Fix the root cause before restarting

**If the cause is a stale socket file:**

```bash
rm -f data/sockets/broker.sock data/sockets/escalation.sock
```

**If the cause is a missing credential:**

Update your `.env`, Bitwarden vault, or OneCLI vault with a valid credential before restarting. See `credential-rotation.md` for the procedure.

**If the cause is a code or build issue:**

```bash
npm run build
```

### Step 4 — Restart the broker

**Systemd (Linux):**

```bash
sudo systemctl restart opengolem
# or if the broker is a separate service
sudo systemctl restart opengolem-broker
```

**Launchd (macOS):**

```bash
launchctl kickstart -k gui/$(id -u)/com.opengolem
```

**WSL / manual:**

```bash
bash start-opengolem.sh
```

Wait 5–10 seconds for the broker to start and bind its socket.

### Step 5 — Verify broker health

```bash
echo '{"jsonrpc":"2.0","method":"health","params":{},"id":1}' | \
  nc -U data/sockets/broker.sock
```

Expected response:

```json
{"jsonrpc":"2.0","result":{"status":"ok"},"id":1}
```

If you get `"status": "degraded"` with `"reason": "credential_backend_unreachable"`, the broker started but cannot read its credential. Fix the credential first (see `credential-rotation.md`) and retry.

### Step 6 — Confirm the orchestrator has reconnected

Check the audit log for a `broker_reconnected` event:

```bash
sqlite3 data/audit.db \
  "SELECT timestamp, eventType FROM events \
   WHERE eventType='broker_reconnected' \
   ORDER BY timestamp DESC LIMIT 3;"
```

You should see a recent row. If this event is absent but the broker is healthy, the orchestrator may not have detected the recovery yet — wait up to 10 seconds and re-check.

### Step 7 — Re-queue any interrupted user requests

Interrupted tasks are **not automatically re-run**. Users need to re-send their request. To identify which users were affected, query the audit log for teardown events around the time of the crash:

```bash
sqlite3 data/audit.db \
  "SELECT timestamp, taskId, contextId, json_extract(data,'$.reason') \
   FROM events \
   WHERE eventType='broker_loss_teardown' \
   ORDER BY timestamp DESC LIMIT 20;"
```

The `contextId` field corresponds to the group. Notify affected users (or groups) that they can re-send their last request.

---

## How to tell if broker loss caused silent data loss

Broker loss interrupts running tasks, but it should not cause silent data loss. However, there is a specific scenario to check: a task that was in the middle of a **filesystem write** when the broker crashed. In that case, the write may be incomplete.

### Check for unpaired teardown events

A task that completed successfully before the crash will have both a `broker_loss_teardown` event and (if it finished before the crash) a `task_completed` event. A task with `broker_loss_teardown` but no `task_completed` was interrupted mid-execution.

```bash
sqlite3 data/audit.db "
  SELECT
    t.timestamp AS teardown_time,
    t.taskId,
    t.contextId,
    CASE WHEN c.taskId IS NOT NULL THEN 'completed' ELSE 'INTERRUPTED' END AS status
  FROM (
    SELECT timestamp, taskId, contextId
    FROM events
    WHERE eventType = 'broker_loss_teardown'
  ) t
  LEFT JOIN (
    SELECT taskId FROM events WHERE eventType = 'task_completed'
  ) c ON t.taskId = c.taskId
  ORDER BY t.timestamp DESC
  LIMIT 20;
"
```

Rows with status `INTERRUPTED` represent tasks that were torn down before producing output. These tasks produced no output and made no persistent changes (agent containers write results back via the sentinel protocol). No data was lost from these tasks — they simply need to be re-run.

If you are concerned about a specific group's memory file (`groups/<name>/CLAUDE.md`) being in a corrupt state, inspect it directly:

```bash
cat groups/<groupname>/CLAUDE.md
```

A truncated or syntactically broken file indicates the container was writing to it when it was torn down. In that case, restore from your most recent backup, or edit the file to remove any partial content at the end.

---

## Prevention: Recommended service configuration

The most effective prevention is ensuring the broker process restarts automatically if it crashes. The orchestrator's reconnect loop means that a fast broker restart (within 30–60 seconds) will be transparent to most users.

### Systemd `Restart=always` (Linux)

Add these lines to your service unit file (or confirm they are present):

```ini
[Service]
Restart=always
RestartSec=2
```

`RestartSec=2` gives the process 2 seconds after a crash before systemd attempts a restart. This avoids rapid-restart loops if the broker is crashing immediately on startup (which indicates a configuration error that needs operator attention).

Apply the change:

```bash
sudo systemctl daemon-reload
sudo systemctl restart opengolem
```

Verify the restart policy is in effect:

```bash
systemctl show opengolem -p Restart -p RestartSec
```

Expected:

```
Restart=always
RestartSec=2s
```

### Launchd `KeepAlive` (macOS)

In your launchd plist, confirm `KeepAlive` is set to `true`:

```xml
<key>KeepAlive</key>
<true/>
```

With `KeepAlive` set, launchd will restart the process automatically after a crash. Unlike systemd, launchd does not have a configurable restart delay — it uses an exponential backoff automatically.

Reload the plist to apply any changes:

```bash
launchctl unload ~/Library/LaunchAgents/com.opengolem.plist
launchctl load ~/Library/LaunchAgents/com.opengolem.plist
```

---

## Verification Checklist

Run these steps after completing a recovery to confirm the system is fully operational.

### Step 1 — Broker socket exists and responds

```bash
echo '{"jsonrpc":"2.0","method":"health","params":{},"id":1}' | \
  nc -U data/sockets/broker.sock
```

Expected: `{"jsonrpc":"2.0","result":{"status":"ok"},"id":1}`

### Step 2 — Broker reconnected event is in the audit log

```bash
sqlite3 data/audit.db \
  "SELECT timestamp FROM events \
   WHERE eventType='broker_reconnected' \
   ORDER BY timestamp DESC LIMIT 1;"
```

Expected: a timestamp within the last few minutes.

### Step 3 — No unexpected teardown events since recovery

```bash
sqlite3 data/audit.db \
  "SELECT COUNT(*) FROM events \
   WHERE eventType='broker_loss_teardown' \
   AND timestamp > datetime('now','-5 minutes');"
```

Expected: `0` (any teardown events during recovery are accounted for; new ones indicate a recurring problem).

### Step 4 — New tasks are dispatched successfully

Send a test message via your channel. Confirm the agent responds. If it does not respond within the normal response time, check the orchestrator logs for further errors.

### Step 5 — Restart policy is confirmed

**Systemd:**

```bash
systemctl show opengolem -p Restart -p RestartSec
```

Expected: `Restart=always` and `RestartSec=2s`.

**Launchd:**

```bash
grep -A1 KeepAlive ~/Library/LaunchAgents/com.opengolem.plist
```

Expected: `<true/>` on the line following `<key>KeepAlive</key>`.

### Step 6 — Interrupted users have been notified

Confirm that each `contextId` from the `broker_loss_teardown` query (Step 7 of the recovery procedure) has been either notified automatically by the orchestrator or manually informed that they should re-send their request.
