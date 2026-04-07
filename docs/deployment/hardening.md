# Network Hardening Annex

**Who this is for:** Operators deploying OpenGolem on a Linux host (or WSL2) who are comfortable with a terminal but are not Linux sysadmin experts. This document covers the network and process-hardening steps that must be completed before putting OpenGolem on any machine that has external network access.

**When to use it:** Run through this checklist once after initial installation, and again whenever you change your Docker network configuration, switch container runtimes, or move the service to a new host.

**Source authority:** Decision 32 (F-2 credential proxy binding), Decision 31 (F-1 inbound transport security), Decision 34 (F-4 Node.js `--permission` flags), Decision 36 (F-7 self-hosted model safety posture), and the Token Broker and Orchestrator behavioral specifications.

---

## 1. Docker Network Configuration

### 1.1 Understanding the credential proxy binding

The Token Broker exposes a local HTTP server that agent containers use to make proxied LLM API calls. By design (Decision 32), this server **must not** bind to `0.0.0.0` — only to the Docker bridge network interface. Containers can reach it; the rest of your network cannot.

The default Docker bridge address is `172.17.0.1`. If you are using a named Docker network, Apple Container, or any other non-default runtime, this address will differ.

### 1.2 Confirm your Docker bridge address

Run this command to find the address Docker assigns to its bridge interface:

```bash
docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Expected output for a default Docker installation:

```
172.17.0.1
```

If you are using a named network, inspect that network instead:

```bash
docker network inspect <your-network-name> --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

You can also verify the interface directly on the host:

```bash
ip addr show docker0
```

Look for the `inet` line — for example, `inet 172.17.0.1/16`.

### 1.3 Set the bind address in your environment

If your bridge address matches the default (`172.17.0.1`), no extra configuration is needed. If it differs — because you are using a named network, Podman, or Apple Container — set `CREDENTIAL_PROXY_BIND_ADDRESS` in your `.env` file:

```bash
# .env
CREDENTIAL_PROXY_BIND_ADDRESS=<your-bridge-gateway-address>
```

For Apple Container (macOS native runtime), the gateway is typically `192.168.64.1`. Confirm with:

```bash
# macOS only
apple container network show 2>/dev/null | grep gateway || \
  netstat -rn | grep -E '^default.*utun'
```

For Podman on Linux, inspect the default network:

```bash
podman network inspect podman --format '{{range .Subnets}}{{.Gateway}}{{end}}'
```

**Critical:** If `CREDENTIAL_PROXY_BIND_ADDRESS` is not set and the broker cannot determine the bridge address (for example, because Docker is not running), the broker will refuse to start rather than fall back to `0.0.0.0`. This is intentional fail-closed behaviour. Never set `CREDENTIAL_PROXY_BIND_ADDRESS=0.0.0.0` — this is treated as a configuration error and the broker will not start.

---

## 2. Firewall Posture by Channel Type

OpenGolem's firewall requirements depend on which channels you have enabled. The rules below cover the two default channels (TUI and Telegram). Apply only the rules relevant to your deployment.

### 2.1 TUI channel — loopback only

The TUI channel does not open any network port. All TUI communication is through the local terminal session. No inbound firewall rules are required.

The orchestrator's health endpoint (`HEALTH_PORT`, default 3003) is bound to `127.0.0.1` only. Confirm this is not exposed externally:

```bash
# Should show 127.0.0.1:3003, not 0.0.0.0:3003
ss -tlnp | grep 3003
```

Expected output:
```
LISTEN  0  128  127.0.0.1:3003  0.0.0.0:*  users:(("node",pid=...,fd=...))
```

If you see `0.0.0.0:3003`, the health endpoint binding is misconfigured — do not expose this port to external interfaces.

### 2.2 Telegram channel — outbound long-poll only

The Telegram channel adapter uses long-polling by default (Decision 31). It makes outbound HTTPS connections to `api.telegram.org` — it does not open any inbound port. No inbound firewall rules are required for Telegram.

Required outbound connectivity:

```bash
# Test that the host can reach Telegram's API (should return a JSON response)
curl -s --max-time 10 https://api.telegram.org | head -c 100
```

If this fails, check that your outbound HTTPS (port 443) is not blocked by a corporate firewall or VPS provider rule.

No inbound firewall rules are needed for the Telegram channel in long-poll mode. Do **not** expose any port to the internet for Telegram unless you explicitly switch to webhook mode, which requires additional configuration documented separately.

### 2.3 Credential proxy port (all deployments)

The credential proxy listens on a TCP port (default: 3001, set by `CREDENTIAL_PROXY_PORT`). Even though the broker binds to the Docker bridge address and not to `0.0.0.0`, an extra firewall rule ensures that the port cannot be reached from any interface other than `docker0`.

**Using ufw (recommended for most Linux deployments):**

```bash
# Block inbound access to the proxy port from all interfaces...
sudo ufw deny in on any to any port 3001

# ...then allow it only from the docker0 interface
sudo ufw allow in on docker0 to any port 3001

# Reload to apply
sudo ufw reload

# Confirm ufw is active
sudo ufw status verbose
```

If you use a custom `CREDENTIAL_PROXY_PORT`, replace `3001` with your configured value in all commands above.

**Using iptables directly (alternative to ufw):**

```bash
# Accept proxy port traffic from the docker0 interface
sudo iptables -A INPUT -i docker0 -p tcp --dport 3001 -j ACCEPT

# Drop proxy port traffic from all other interfaces
sudo iptables -A INPUT -p tcp --dport 3001 -j DROP
```

To make these rules persist across reboots:

```bash
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

### 2.4 Verify the proxy is unreachable from the host network

After applying firewall rules, confirm that the proxy port is not reachable from the host's primary network interface. Replace `eth0` / external IP with your actual interface:

```bash
# This should fail (connection refused or timeout)
curl --max-time 3 http://$(hostname -I | awk '{print $1}'):${CREDENTIAL_PROXY_PORT:-3001}/

# This should succeed (broker is reachable from the bridge)
BRIDGE=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
curl --max-time 3 http://${BRIDGE}:${CREDENTIAL_PROXY_PORT:-3001}/health
```

If the first command succeeds, recheck your firewall rules. The proxy must not be reachable from external interfaces.

---

## 3. Unix Socket Permissions

OpenGolem uses three Unix sockets for inter-process communication:

| Socket | Path | Direction |
|--------|------|-----------|
| Token lifecycle socket | `data/sockets/broker.sock` | Orchestrator connects; broker listens |
| Cato inline check socket | `data/sockets/cato.sock` | Orchestrator connects; Cato listens |
| Escalation relay socket | `data/sockets/escalation.sock` | Broker connects; orchestrator listens |

All three sockets must be owned by the user account that runs the OpenGolem processes, and must not be world-readable or world-writable.

### 3.1 Set correct permissions at startup

The socket files are created at process startup. If you need to correct them manually (for example, after a crash left stale sockets):

```bash
# Remove stale socket files if present
rm -f data/sockets/broker.sock data/sockets/cato.sock data/sockets/escalation.sock

# After the processes start and recreate the sockets, apply permissions
chmod 600 data/sockets/broker.sock
chmod 600 data/sockets/cato.sock
chmod 600 data/sockets/escalation.sock
```

`600` means only the owning user can read or write the socket. No group access, no world access.

### 3.2 Verify socket permissions

```bash
ls -la data/sockets/
```

Expected output (owner will match your service account):

```
srw------- 1 opengolem opengolem 0 Apr  7 12:00 broker.sock
srw------- 1 opengolem opengolem 0 Apr  7 12:00 cato.sock
srw------- 1 opengolem opengolem 0 Apr  7 12:00 escalation.sock
```

The leading `s` indicates a Unix socket. The permission bits must be `------` for group and other (i.e., `rw-------` overall).

If you see wider permissions (e.g., `srw-rw-rw-`), tighten them immediately:

```bash
chmod 600 data/sockets/broker.sock data/sockets/cato.sock data/sockets/escalation.sock
```

---

## 4. Process User and Group Isolation

Running OpenGolem as your own user account is acceptable for personal development deployments. For any deployment where the host has external network access (a VPS, a home server accessible from the internet, or a shared machine), run OpenGolem under a dedicated service account.

### 4.1 Create a dedicated service account

```bash
# Create a system user with no login shell and no home directory
sudo useradd --system --no-create-home --shell /usr/sbin/nologin opengolem
```

### 4.2 Set ownership on the project directory

```bash
sudo chown -R opengolem:opengolem /opt/opengolem
```

Confirm the data directory and socket directory are owned correctly:

```bash
ls -la /opt/opengolem/data/
ls -la /opt/opengolem/data/sockets/
```

### 4.3 Add the service account to the docker group

The service account needs permission to call the Docker API to spawn agent containers:

```bash
sudo usermod -aG docker opengolem
```

Note: membership of the `docker` group is equivalent to root access to the Docker daemon. This is a known trade-off for self-hosted Docker deployments. If your threat model requires stricter isolation, evaluate rootless Docker or Podman as alternatives.

### 4.4 Verify the service account cannot log in

```bash
# Should print "nologin" or an equivalent message and exit immediately
sudo -u opengolem /usr/sbin/nologin
```

The service account should have no interactive shell access.

---

## 5. Node.js `--permission` Flags

Decision 34 requires production deployments to launch the orchestrator with Node.js `--permission` flags. These flags restrict what the Node.js process can access — limiting filesystem reads/writes to only what OpenGolem legitimately needs.

### 5.1 Required flag set

```
--experimental-permission
--allow-fs-read=./groups/,./data/,./runtime/,./package.json
--allow-fs-write=./groups/,./data/
--allow-child-process
--allow-worker
```

Network access is not restricted by Node.js `--permission` flags (that is handled by the firewall and bind-address configuration above). Filesystem restrictions are the primary control here.

Adjust the paths if your `groups/` or `data/` directories are at non-default locations.

### 5.2 Verify `--permission` flags are active

```bash
# Check that the running node process includes the permission flag
ps aux | grep 'experimental-permission' | grep -v grep
```

If no output appears, the process is not running with permission restrictions.

---

## 6. Safety Posture by Provider (F-7)

**This section is mandatory reading if you configure Ollama or a custom LLM provider.**

When OpenGolem uses Anthropic's cloud API, there are two layers of safety filtering on every LLM call:

1. **Anthropic's upstream safety filters** — applied server-side before the model generates a response. These include content moderation, harmful output detection, and policy enforcement that Anthropic operates and maintains.
2. **Cato's inline checks** — applied by OpenGolem before dispatching significant actions.

When you configure Ollama (`ANTHROPIC_BASE_URL_UPSTREAM` pointing to a local Ollama server) or a custom provider endpoint, Anthropic's upstream safety filters are **not present**. There is no server-side content moderation on the model's outputs. **Cato's inline checks are the only safety layer.**

### What this means in practice

| Provider | Upstream safety filter | Cato inline checks | Combined safety coverage |
|----------|-----------------------|--------------------|--------------------------|
| Anthropic (default) | Yes — Anthropic-operated | Yes | Two independent layers |
| Ollama (self-hosted) | **No** | Yes | Cato only |
| Custom endpoint | **No** (unless provider applies its own) | Yes | Cato only, or Cato + unknown |

In Phase 1, Cato's inline checks are deterministic rules (path traversal detection, oversized payload detection, prompt injection signature matching, call rate anomaly, endpoint scope). These are effective against known attack patterns but do not provide the same broad coverage as a cloud provider's safety infrastructure.

### Required actions when enabling Ollama or a custom provider

**Before enabling a self-hosted provider:**

1. Review `runtime/PSYCHE.md` and confirm that Cato's block thresholds are appropriate for your use case. Self-hosted deployments should use equal or stricter thresholds than the defaults.

2. Reduce the Cato audit interval from the default (6 hours) to 1–2 hours for high-call-volume self-hosted deployments:

   ```bash
   # .env
   CATO_AUDIT_INTERVAL_MS=3600000   # 1 hour
   ```

3. When applying any skill that declares `providers.compatible: [ollama]` or `custom`, the skill application flow will prompt you for an explicit acknowledgement that reduced upstream filter coverage applies. Do not skip this acknowledgement.

4. Document the decision in your deployment notes. The reduced safety coverage is a conscious choice that should be reviewed when you revisit your security posture.

### Cato's role under self-hosted providers

The five Call Inspector checks (skill whitelist, memory scope, prompt injection signatures, call rate, endpoint scope) apply identically regardless of provider. Cato's scheduled audit reads the same audit log and produces the same dao_score KPIs. However:

- Cato cannot compensate for harmful content that is generated by the model and returned to the user — it can only block calls before they are forwarded.
- The Phase 2 LLM escalation path in Cato (where Cato uses a separate frontier model to judge ambiguous cases) is especially important for self-hosted deployments. Until Phase 2 is available, ambiguous cases are resolved by the deterministic checks alone.
- If you are using a quantised or fine-tuned local model with weaker instruction-following, Cato's prompt injection detection may have a higher false-negative rate than with a frontier cloud model.

---

## 7. Systemd and Launchd Service Hardening

For complete systemd unit files including correct startup order and `After=` dependencies, see `broker-recovery.md` §5. The service hardening described there (separate units for Broker, Cato, and Orchestrator) is the recommended production configuration and implements the process isolation described in this document.

The Node.js `--permission` flags described in §5 must be added to the `ExecStart` line of the orchestrator unit. The broker and Cato units do not currently support `--permission` flags because they access a wider set of paths — apply the filesystem permission flags only to the orchestrator unit.

---

## 8. Verification Checklist

Run each command and confirm the expected result before marking the step complete.

### Step 1 — Docker bridge address confirmed

```bash
docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

Expected: an IP address (not blank). If using a non-standard runtime, set `CREDENTIAL_PROXY_BIND_ADDRESS` in `.env` to match.

### Step 2 — Proxy not reachable from external interface

```bash
curl --max-time 3 http://$(hostname -I | awk '{print $1}'):${CREDENTIAL_PROXY_PORT:-3001}/
```

Expected: connection refused, connection timed out, or similar failure. If this succeeds, your firewall rules are not applied.

### Step 3 — Proxy reachable from Docker bridge

```bash
BRIDGE=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
curl --max-time 3 http://${BRIDGE}:${CREDENTIAL_PROXY_PORT:-3001}/health
```

Expected: an HTTP response (even an error body is acceptable — the point is that the TCP connection succeeds).

### Step 4 — Socket permissions are 600

```bash
ls -la data/sockets/broker.sock data/sockets/cato.sock data/sockets/escalation.sock
```

Expected: all three files show `srw-------` with the OpenGolem service user as owner.

### Step 5 — ufw status shows the correct rules

```bash
sudo ufw status verbose | grep ${CREDENTIAL_PROXY_PORT:-3001}
```

Expected: one ALLOW rule on `docker0`, one DENY rule on `any`.

### Step 6 — Orchestrator started with `--permission` flags

```bash
# systemd
systemctl show opengolem-orchestrator -p ExecStart

# launchd (macOS)
launchctl list com.opengolem.orchestrator

# manual check (any platform)
ps aux | grep 'experimental-permission' | grep -v grep
```

Expected: the process arguments include `--experimental-permission` and the `--allow-fs-read`/`--allow-fs-write` flags.

### Step 7 — Health endpoint is loopback-only

```bash
ss -tlnp | grep ${HEALTH_PORT:-3003}
```

Expected: `127.0.0.1:3003` in the local address column. Not `0.0.0.0`.

### Step 8 — Broker socket responds to health check

```bash
echo '{"jsonrpc":"2.0","method":"health","params":{},"id":1}' | \
  nc -U data/sockets/broker.sock
```

Expected response:

```json
{"jsonrpc":"2.0","result":{"status":"ok"},"id":1}
```

### Step 9 — Self-hosted provider acknowledgement (if applicable)

If you are using Ollama or a custom provider, confirm:

```bash
# Cato audit interval is set to 1 hour or less
grep CATO_AUDIT_INTERVAL_MS .env

# PSYCHE.md has a Self-Hosted Provider Posture section
grep -l "Self-Hosted Provider Posture" runtime/PSYCHE.md
```
