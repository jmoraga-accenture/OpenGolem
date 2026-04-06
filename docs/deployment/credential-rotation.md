# Credential Rotation Runbook

**Who this is for:** Operators managing a running OpenGolem deployment who need to rotate an LLM API credential — either on a schedule or in response to a suspected compromise. No sysadmin expertise is required, but you need terminal access to the host where OpenGolem is running.

**When to use it:**
- Routine credential rotation (scheduled key cycling)
- After a suspected key leak or unauthorised access
- After a Bitwarden vault password change that affects the stored credential
- Any time your LLM provider advises you to rotate your API key

**Source authority:** Decision 37 (F-8 credential rotation procedure), Decision 32 (credential backend selection), `token-broker-spec.md` §`rotateCredential`.

---

## How rotation works

OpenGolem's Token Broker is the sole keeper of your long-lived LLM API credential. Agent containers never see the real key — they receive short-lived, scoped derivative tokens instead.

When you rotate the credential:

1. You update the credential in its source (your `.env` file, Bitwarden vault, or OneCLI vault).
2. You notify the broker to re-read its source by calling `rotateCredential` on its Unix socket.
3. The broker reloads the credential. New tasks will use the new credential immediately.
4. In an emergency, you pass `"revokeInFlight": true` to also invalidate all currently running agent sessions.

**Planned rotation** (no active incident): use `"revokeInFlight": false` — in-flight agent sessions are not interrupted.

**Emergency rotation** (suspected compromise): use `"revokeInFlight": true` — all in-flight sessions are torn down immediately. Users will receive a notification via their channel that their task was interrupted.

---

## How to invoke `rotateCredential` from the terminal

All three backend types use the same command to trigger the broker reload. The only variable is `revokeInFlight`.

**Planned rotation (non-disruptive):**

```bash
echo '{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":false},"id":30}' | \
  nc -U data/sockets/broker.sock
```

**Emergency rotation (tears down in-flight containers):**

```bash
echo '{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":true},"id":30}' | \
  nc -U data/sockets/broker.sock
```

**Expected response:**

```json
{"jsonrpc":"2.0","result":{"reloaded":true,"revokedCount":3},"id":30}
```

`revokedCount` tells you how many in-flight derivative tokens were revoked. In a planned rotation this will be `0`. In an emergency rotation it will be the number of agent sessions that were torn down.

If the socket is not reachable, run the command from the OpenGolem project root directory (where `data/` lives).

---

## Backend 1: `.env` file (development / simple deployments)

### Planned rotation

Target time: under 2 minutes.

1. Open your `.env` file in an editor:

   ```bash
   nano /path/to/OpenGolem/.env
   ```

2. Replace the old credential value. The relevant key is whichever of these you use:

   ```
   ANTHROPIC_API_KEY=sk-ant-...your-new-key...
   # or
   CLAUDE_CODE_OAUTH_TOKEN=...your-new-token...
   ```

3. Save and close the file.

4. Trigger the broker to reload from disk:

   ```bash
   echo '{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":false},"id":30}' | \
     nc -U data/sockets/broker.sock
   ```

5. Confirm the response shows `"reloaded": true`.

6. Run the post-rotation verification checklist (§4 below).

### Emergency rotation (suspected compromise)

Target time: under 2 minutes.

1. **Revoke the key at the provider first.** Go to [console.anthropic.com](https://console.anthropic.com) → API Keys → revoke the compromised key. Generate a new key.

2. Update `.env` with the new key value (step 2 of planned rotation above).

3. Immediately trigger emergency rotation:

   ```bash
   echo '{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":true},"id":30}' | \
     nc -U data/sockets/broker.sock
   ```

4. The broker revokes all active derivative tokens. Containers that are currently running will receive HTTP 403 on their next proxied call and will be torn down. Users will receive an interruption notification via their channel.

5. Confirm the audit log records the emergency event:

   ```bash
   sqlite3 data/audit.db \
     "SELECT timestamp, eventType, json_extract(data,'$.revokedCount') \
      FROM events \
      WHERE eventType='credential_emergency_rotation' \
      ORDER BY timestamp DESC LIMIT 5;"
   ```

   Expected: one row with a `revokedCount` matching the `revokedCount` in the socket response.

6. Run the post-rotation verification checklist (§4 below).

---

## Backend 2: Bitwarden (recommended production)

### Planned rotation

Target time: under 5 minutes.

1. Log in to your Bitwarden vault (web or desktop app).

2. Find the item containing your Anthropic API key or OAuth token. Update the stored value to the new credential.

3. Save the item in Bitwarden.

4. The broker polls Bitwarden on a configurable interval (default: 5 minutes, set by `CREDENTIAL_RELOAD_INTERVAL`). To pick up the new credential immediately without waiting for the next poll, call `rotateCredential`:

   ```bash
   echo '{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":false},"id":30}' | \
     nc -U data/sockets/broker.sock
   ```

5. Confirm the response shows `"reloaded": true`.

6. Verify the audit log shows a `credential_reloaded` event:

   ```bash
   sqlite3 data/audit.db \
     "SELECT timestamp, eventType, json_extract(data,'$.backendType') \
      FROM events \
      WHERE eventType='credential_reloaded' \
      ORDER BY timestamp DESC LIMIT 3;"
   ```

7. Run the post-rotation verification checklist (§4 below).

### Emergency rotation (suspected compromise)

Target time: under 5 minutes.

1. **Revoke the key at the provider first** (console.anthropic.com → API Keys → revoke). Generate a new key.

2. Update the item in your Bitwarden vault with the new key.

3. Trigger emergency rotation immediately:

   ```bash
   echo '{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":true},"id":30}' | \
     nc -U data/sockets/broker.sock
   ```

4. Confirm the audit log records the emergency event:

   ```bash
   sqlite3 data/audit.db \
     "SELECT timestamp, eventType, json_extract(data,'$.revokedCount') \
      FROM events \
      WHERE eventType='credential_emergency_rotation' \
      ORDER BY timestamp DESC LIMIT 5;"
   ```

5. Check that any running agent sessions were torn down (`broker_loss_teardown` events will appear for sessions interrupted by the emergency revocation):

   ```bash
   sqlite3 data/audit.db \
     "SELECT timestamp, eventType, taskId \
      FROM events \
      WHERE eventType='broker_loss_teardown' \
      ORDER BY timestamp DESC LIMIT 10;"
   ```

6. Run the post-rotation verification checklist (§4 below).

---

## Backend 3: OneCLI Agent Vault (optional)

### Planned rotation

Target time: under 5 minutes.

1. Use the OneCLI vault CLI to update the stored credential. The exact command depends on your OneCLI installation:

   ```bash
   onecli vault set ANTHROPIC_API_KEY sk-ant-...your-new-key...
   # or for OAuth token
   onecli vault set CLAUDE_CODE_OAUTH_TOKEN ...your-new-token...
   ```

   Consult your OneCLI documentation if the command syntax differs.

2. The broker polls the vault on the `CREDENTIAL_RELOAD_INTERVAL` schedule. To reload immediately:

   ```bash
   echo '{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":false},"id":30}' | \
     nc -U data/sockets/broker.sock
   ```

3. Confirm `"reloaded": true` in the response.

4. Verify the audit log:

   ```bash
   sqlite3 data/audit.db \
     "SELECT timestamp, eventType, json_extract(data,'$.backendType') \
      FROM events \
      WHERE eventType='credential_reloaded' \
      ORDER BY timestamp DESC LIMIT 3;"
   ```

5. Run the post-rotation verification checklist (§4 below).

### Emergency rotation (suspected compromise)

Target time: under 5 minutes.

1. **Revoke the key at the provider first** (console.anthropic.com → API Keys → revoke). Generate a new key.

2. Update the vault immediately:

   ```bash
   onecli vault set ANTHROPIC_API_KEY sk-ant-...your-new-key...
   ```

3. Trigger emergency rotation:

   ```bash
   echo '{"jsonrpc":"2.0","method":"rotateCredential","params":{"revokeInFlight":true},"id":30}' | \
     nc -U data/sockets/broker.sock
   ```

4. Confirm the emergency audit log entry:

   ```bash
   sqlite3 data/audit.db \
     "SELECT timestamp, eventType, json_extract(data,'$.revokedCount') \
      FROM events \
      WHERE eventType='credential_emergency_rotation' \
      ORDER BY timestamp DESC LIMIT 5;"
   ```

5. Run the post-rotation verification checklist (§4 below).

---

## What happens to in-flight containers during emergency rotation

When `revokeInFlight: true` is passed:

1. The broker immediately revokes all currently active derivative tokens.
2. Any agent container that makes a proxied LLM call after that point receives **HTTP 403** from the broker.
3. The orchestrator detects the 403, tears down the affected container, and routes an interruption notification to the user via their channel.
4. The audit log records a `credential_emergency_rotation` event (with `revokedCount`) and `broker_loss_teardown` events for each torn-down container.

Users whose sessions were interrupted will need to re-send their request after you confirm the new credential is working.

---

## 4. Post-Rotation Verification Checklist

Run all of these steps after any rotation — planned or emergency.

### Step 1 — Broker reports healthy

```bash
echo '{"jsonrpc":"2.0","method":"health","params":{},"id":1}' | \
  nc -U data/sockets/broker.sock
```

Expected:

```json
{"jsonrpc":"2.0","result":{"status":"ok"},"id":1}
```

If you see `"status": "degraded"` with `"reason": "credential_backend_unreachable"`, the broker cannot read the new credential from its source. Re-check that you saved the updated credential to the correct location.

### Step 2 — Audit log shows a reload event

```bash
sqlite3 data/audit.db \
  "SELECT timestamp, eventType FROM events \
   WHERE eventType IN ('credential_reloaded','credential_emergency_rotation') \
   ORDER BY timestamp DESC LIMIT 5;"
```

You should see a row timestamped within the last few minutes.

### Step 3 — New tasks succeed

Send a simple test message via your normal channel (TUI or Telegram). If the agent responds successfully, the new credential is working.

### Step 4 — Old credential is fully invalidated (emergency only)

If you performed an emergency rotation, confirm the old key is no longer accepted by the provider (log in to console.anthropic.com and verify the old key is in a Revoked or Deleted state).

### Step 5 — No orphaned teardown events

For emergency rotations, confirm that every `broker_loss_teardown` entry has an identifiable cause (the emergency rotation) and is not an unexpected teardown from before the rotation:

```bash
sqlite3 data/audit.db \
  "SELECT timestamp, taskId, json_extract(data,'$.reason') \
   FROM events \
   WHERE eventType='broker_loss_teardown' \
   ORDER BY timestamp DESC LIMIT 10;"
```

Entries with `"reason": "broker_unavailable"` may indicate a separate broker crash — see `broker-recovery.md` if those appear unexpectedly.
