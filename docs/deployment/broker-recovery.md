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
# View recent broker logs
journalctl -u opengolem-broker --since "30 minutes ago" --no-pager

# If running as a combined single service
journalctl -u opengolem --since "30 minutes ago" --no-pager
```

**On launchd (macOS):**

```bash
# Check the log files configured in the plist
tail -100 /tmp/opengolem-broker-error.log
tail -100 /tmp/opengolem-broker.log
```

**On WSL / manual start:**

```bash
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

**Systemd (Linux) — separate service units (recommended):**

```bash
# Start broker first (it has no dependencies on Cato or Orchestrator)
sudo systemctl restart opengolem-broker

# Wait for broker to bind its socket (usually 2–5 seconds)
sleep 5

# The orchestrator's reconnect loop will detect the broker automatically
# Only restart the orchestrator if it is not running
sudo systemctl is-active opengolem-orchestrator || sudo systemctl restart opengolem-orchestrator
```

**Systemd (Linux) — combined service unit:**

```bash
sudo systemctl restart opengolem
```

**Launchd (macOS):**

```bash
launchctl kickstart -k gui/$(id -u)/com.opengolem.broker
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

## Target restart time and SLA guidance

**Default TTL values** (from `src/config.ts`):

| Setting | Default | What it governs |
|---------|---------|----------------|
| `CONTAINER_TIMEOUT` | 1800s (30 min) | Maximum container lifetime from spawn |
| `IDLE_TIMEOUT` | 1800s (30 min) | Container lifetime after last result received |
| `CREDENTIAL_RELOAD_INTERVAL` | 300s (5 min) | Broker backend polling interval |

**Restart time target:** The orchestrator's reconnect loop retries every 10 seconds. A broker restart that completes within **30–60 seconds** will be transparent to most users — the orchestrator re-queues inbound messages during the outage and resumes dispatch once the broker reconnects.

**Acceptable restart window:** Up to 120 seconds is acceptable without operator escalation. Beyond 120 seconds, manually check the broker logs (Step 2 above) and escalate if the cause is not immediately clear.

**Relationship to TTL:** A broker outage shorter than the shortest TTL (30 minutes) means no container tokens expire mid-outage due to TTL. All active containers are torn down immediately on broker loss detection — not at TTL expiry. The TTL is the worst-case bound for how long a derivative token could theoretically be active without revocation if the broker were somehow unavailable and teardown had not occurred.

---

## 5. Process Supervisor Configuration

### 5.1 Architecture: three separate long-lived processes

The three long-lived processes start in this order and must not restart each other:

```
Token Broker  →  Cato  →  Orchestrator
```

The orchestrator contacts both the broker and Cato at boot for health checks. It must not start until both are listening on their sockets. The broker and Cato are independent — neither depends on the other at startup.

### 5.2 Systemd unit files (Linux) — recommended production configuration

Create three separate unit files. The paths below assume the service account is `opengolem` and the installation directory is `/opt/opengolem`. Adjust as needed.

**`/etc/systemd/system/opengolem-broker.service`**

```ini
[Unit]
Description=OpenGolem Token Broker
Documentation=https://github.com/your-repo/OpenGolem
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=opengolem
Group=opengolem
WorkingDirectory=/opt/opengolem
EnvironmentFile=/opt/opengolem/.env
ExecStartPre=/bin/rm -f /opt/opengolem/data/sockets/broker.sock
ExecStartPre=/bin/rm -f /opt/opengolem/data/sockets/escalation.sock
ExecStart=/usr/bin/node dist/broker/index.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opengolem-broker

# Socket permissions: broker.sock and escalation.sock must be 600
ExecStartPost=/bin/bash -c 'sleep 1 && chmod 600 /opt/opengolem/data/sockets/broker.sock 2>/dev/null; chmod 600 /opt/opengolem/data/sockets/escalation.sock 2>/dev/null; true'

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/opengolem-cato.service`**

```ini
[Unit]
Description=OpenGolem Cato Oversight Process
Documentation=https://github.com/your-repo/OpenGolem
After=network.target

[Service]
Type=simple
User=opengolem
Group=opengolem
WorkingDirectory=/opt/opengolem
EnvironmentFile=/opt/opengolem/.env
ExecStartPre=/bin/rm -f /opt/opengolem/data/sockets/cato.sock
ExecStart=/usr/bin/node dist/cato/index.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opengolem-cato

ExecStartPost=/bin/bash -c 'sleep 1 && chmod 600 /opt/opengolem/data/sockets/cato.sock 2>/dev/null; true'

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/opengolem-orchestrator.service`**

```ini
[Unit]
Description=OpenGolem Orchestrator
Documentation=https://github.com/your-repo/OpenGolem
# Orchestrator must start after broker and Cato are ready
After=opengolem-broker.service opengolem-cato.service docker.service
Requires=opengolem-broker.service opengolem-cato.service docker.service

[Service]
Type=simple
User=opengolem
Group=opengolem
WorkingDirectory=/opt/opengolem
EnvironmentFile=/opt/opengolem/.env
ExecStart=/usr/bin/node \
  --experimental-permission \
  --allow-fs-read=/opt/opengolem/groups/,/opt/opengolem/data/,/opt/opengolem/runtime/,/opt/opengolem/package.json \
  --allow-fs-write=/opt/opengolem/groups/,/opt/opengolem/data/ \
  --allow-child-process \
  --allow-worker \
  dist/index.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opengolem-orchestrator

[Install]
WantedBy=multi-user.target
```

**Enable and start all three services:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable opengolem-broker opengolem-cato opengolem-orchestrator
sudo systemctl start opengolem-broker opengolem-cato
# Wait for broker and Cato to bind their sockets before starting the orchestrator
sleep 5
sudo systemctl start opengolem-orchestrator
```

**Verify all three are running:**

```bash
sudo systemctl status opengolem-broker opengolem-cato opengolem-orchestrator
```

**Check restart policy is in effect:**

```bash
systemctl show opengolem-broker -p Restart -p RestartSec
systemctl show opengolem-cato -p Restart -p RestartSec
systemctl show opengolem-orchestrator -p Restart -p RestartSec
```

Expected for each:
```
Restart=always
RestartSec=2s
```

**View live logs from all three processes:**

```bash
journalctl -u opengolem-broker -u opengolem-cato -u opengolem-orchestrator -f
```

### 5.3 Launchd configuration (macOS)

The existing `deploy/service/com.opengolem.plist` covers a single combined process. For production macOS deployments, create three separate plist files.

**`~/Library/LaunchAgents/com.opengolem.broker.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opengolem.broker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>dist/broker/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/yourname/assistants/OpenGolem</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/yourname</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/opengolem-broker.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/opengolem-broker-error.log</string>
</dict>
</plist>
```

**`~/Library/LaunchAgents/com.opengolem.cato.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opengolem.cato</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>dist/cato/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/yourname/assistants/OpenGolem</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/yourname</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/opengolem-cato.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/opengolem-cato-error.log</string>
</dict>
</plist>
```

**`~/Library/LaunchAgents/com.opengolem.orchestrator.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opengolem.orchestrator</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>--experimental-permission</string>
    <string>--allow-fs-read=/Users/yourname/assistants/OpenGolem/groups/,/Users/yourname/assistants/OpenGolem/data/,/Users/yourname/assistants/OpenGolem/runtime/,/Users/yourname/assistants/OpenGolem/package.json</string>
    <string>--allow-fs-write=/Users/yourname/assistants/OpenGolem/groups/,/Users/yourname/assistants/OpenGolem/data/</string>
    <string>--allow-child-process</string>
    <string>--allow-worker</string>
    <string>dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/yourname/assistants/OpenGolem</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/yourname</string>
    <key>ASSISTANT_NAME</key>
    <string>Alef</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/opengolem-orchestrator.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/opengolem-orchestrator-error.log</string>
</dict>
</plist>
```

**Load all three agents (in order):**

```bash
# Load broker and Cato first
launchctl load ~/Library/LaunchAgents/com.opengolem.broker.plist
launchctl load ~/Library/LaunchAgents/com.opengolem.cato.plist

# Wait for broker and Cato to bind their sockets
sleep 5

# Load the orchestrator last
launchctl load ~/Library/LaunchAgents/com.opengolem.orchestrator.plist
```

**Verify all three are running:**

```bash
launchctl list | grep com.opengolem
```

Expected: three rows, each with a PID (not `-`) in the first column.

**Restart a specific process:**

```bash
launchctl kickstart -k gui/$(id -u)/com.opengolem.broker
launchctl kickstart -k gui/$(id -u)/com.opengolem.cato
launchctl kickstart -k gui/$(id -u)/com.opengolem.orchestrator
```

**Unload all three (e.g. for maintenance):**

```bash
launchctl unload ~/Library/LaunchAgents/com.opengolem.orchestrator.plist
launchctl unload ~/Library/LaunchAgents/com.opengolem.cato.plist
launchctl unload ~/Library/LaunchAgents/com.opengolem.broker.plist
```

Note: launchd does not support explicit `After=` dependency ordering between agents. The orchestrator is started after broker and Cato because of the explicit `sleep 5` above. The orchestrator will also retry its startup health check at boot — if the broker or Cato socket is not yet available when the orchestrator starts, it will wait and retry rather than failing immediately.

### 5.4 Startup order note for all platforms

The startup order **Token Broker → Cato → Orchestrator** is required. The orchestrator performs a health check against both the broker socket (`data/sockets/broker.sock`) and the Cato socket (`data/sockets/cato.sock`) at boot. If either socket is not available, the orchestrator queues inbound messages and does not spawn containers until both dependencies are healthy.

Starting the orchestrator before the broker or Cato is safe — it will wait — but will cause log warnings during the startup window. On systemd, the `After=` and `Requires=` directives enforce this order automatically.

---

## Prevention: Recommended service configuration

The most effective prevention is ensuring the broker process restarts automatically if it crashes. The orchestrator's reconnect loop means that a fast broker restart (within 30–60 seconds) will be transparent to most users.

### Systemd `Restart=always`

The unit files in §5.2 already include `Restart=always` and `RestartSec=2`. Verify this is in effect after any unit file edit:

```bash
sudo systemctl daemon-reload
sudo systemctl restart opengolem-broker
systemctl show opengolem-broker -p Restart -p RestartSec
```

`RestartSec=2` gives the process 2 seconds after a crash before systemd attempts a restart. This avoids rapid-restart loops if the broker is crashing immediately on startup (which indicates a configuration error that needs operator attention). If the broker crashes more than 5 times in 10 seconds, systemd will stop restarting it — check `journalctl -u opengolem-broker -n 50` to diagnose.

### Launchd `KeepAlive`

In each launchd plist, `KeepAlive` is set to `true`. With `KeepAlive` set, launchd will restart the process automatically after a crash with exponential backoff.

---

## Verification Checklist

Run these steps after completing a recovery to confirm the system is fully operational.

### Step 1 — Broker socket exists and responds

```bash
echo '{"jsonrpc":"2.0","method":"health","params":{},"id":1}' | \
  nc -U data/sockets/broker.sock
```

Expected: `{"jsonrpc":"2.0","result":{"status":"ok"},"id":1}`

### Step 2 — Cato socket exists and responds

```bash
echo '{"jsonrpc":"2.0","method":"health","params":{},"id":1}' | \
  nc -U data/sockets/cato.sock
```

Expected: `{"jsonrpc":"2.0","result":{"status":"ok"},"id":1}`

### Step 3 — Broker reconnected event is in the audit log

```bash
sqlite3 data/audit.db \
  "SELECT timestamp FROM events \
   WHERE eventType='broker_reconnected' \
   ORDER BY timestamp DESC LIMIT 1;"
```

Expected: a timestamp within the last few minutes.

### Step 4 — No unexpected teardown events since recovery

```bash
sqlite3 data/audit.db \
  "SELECT COUNT(*) FROM events \
   WHERE eventType='broker_loss_teardown' \
   AND timestamp > datetime('now','-5 minutes');"
```

Expected: `0` (any teardown events during recovery are accounted for; new ones indicate a recurring problem).

### Step 5 — New tasks are dispatched successfully

Send a test message via your channel. Confirm the agent responds. If it does not respond within the normal response time, check the orchestrator logs for further errors.

### Step 6 — Restart policy is confirmed

**Systemd:**

```bash
systemctl show opengolem-broker -p Restart -p RestartSec
systemctl show opengolem-cato -p Restart -p RestartSec
systemctl show opengolem-orchestrator -p Restart -p RestartSec
```

Expected: `Restart=always` and `RestartSec=2s` for each.

**Launchd:**

```bash
grep -A1 KeepAlive ~/Library/LaunchAgents/com.opengolem.broker.plist
grep -A1 KeepAlive ~/Library/LaunchAgents/com.opengolem.cato.plist
grep -A1 KeepAlive ~/Library/LaunchAgents/com.opengolem.orchestrator.plist
```

Expected: `<true/>` on the line following each `<key>KeepAlive</key>`.

### Step 7 — Interrupted users have been notified

Confirm that each `contextId` from the `broker_loss_teardown` query (Step 7 of the recovery procedure) has been either notified automatically by the orchestrator or manually informed that they should re-send their request.
