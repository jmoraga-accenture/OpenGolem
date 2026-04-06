# Network Hardening Annex

**Who this is for:** Operators deploying OpenGolem on a Linux host (or WSL2) who are comfortable with a terminal but are not Linux sysadmin experts. This document covers the network and process-hardening steps that must be completed before putting OpenGolem on any machine that has external network access.

**When to use it:** Run through this checklist once after initial installation, and again whenever you change your Docker network configuration, switch container runtimes, or move the service to a new host.

**Source authority:** Decision 32 (F-2 credential proxy binding), Decision 34 (F-4 Node.js `--permission` flags), Decision 31 (F-1 inbound transport security), and the Token Broker and Orchestrator behavioral specifications.

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

**Critical:** If `CREDENTIAL_PROXY_BIND_ADDRESS` is not set and the broker cannot determine the bridge address (for example, because Docker is not running), the broker will refuse to start rather than fall back to `0.0.0.0`. This is intentional fail-closed behaviour.

---

## 2. Firewall Posture

### 2.1 Recommended ufw rules

The credential proxy listens on a TCP port (default: 3001, set by `CREDENTIAL_PROXY_PORT`). Even though the broker binds to the Docker bridge address and not to `0.0.0.0`, an extra firewall rule ensures that the port cannot be reached from any interface other than `docker0`.

If you use `ufw`:

```bash
# Block inbound access to the proxy port from everywhere...
sudo ufw deny in on any to any port 3001

# ...then allow it only from the docker0 interface
sudo ufw allow in on docker0 to any port 3001

# Reload to apply
sudo ufw reload

# Confirm ufw is active
sudo ufw status verbose
```

If you use a custom `CREDENTIAL_PROXY_PORT`, replace `3001` with your configured value in all commands above.

### 2.2 Recommended iptables rules (alternative to ufw)

If you manage `iptables` directly instead of through `ufw`:

```bash
# Accept proxy port traffic from the docker0 interface
sudo iptables -A INPUT -i docker0 -p tcp --dport 3001 -j ACCEPT

# Drop proxy port traffic from all other interfaces
sudo iptables -A INPUT -p tcp --dport 3001 -j DROP
```

To make these rules persist across reboots, use `iptables-save` and `iptables-restore`, or install `iptables-persistent`:

```bash
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

### 2.3 Verify the proxy is unreachable from the host network

After applying firewall rules, confirm that the proxy port is not reachable from the host's primary network interface. Replace `eth0` / `192.168.1.x` with your actual external interface name and address:

```bash
# This should fail (connection refused or timeout)
curl --max-time 3 http://$(hostname -I | awk '{print $1}'):3001/

# This should succeed (broker is reachable from the bridge)
curl --max-time 3 http://172.17.0.1:3001/health
```

If the first command succeeds, recheck your firewall rules. The proxy must not be reachable from external interfaces.

---

## 3. Unix Socket Permissions

OpenGolem uses two Unix sockets for inter-process communication:

| Socket | Path | Direction |
|--------|------|-----------|
| Token lifecycle socket | `data/sockets/broker.sock` | Orchestrator connects; broker listens |
| Escalation socket | `data/sockets/escalation.sock` | Broker connects; orchestrator listens |

Both sockets must be owned by the user account that runs the OpenGolem processes, and must not be world-readable or world-writable.

### 3.1 Set correct permissions at startup

The socket files are created at process startup. If you need to correct them manually (for example, after a crash left stale sockets):

```bash
# Remove stale socket files if present
rm -f data/sockets/broker.sock data/sockets/escalation.sock

# After the processes start and recreate the sockets, apply permissions
chmod 600 data/sockets/broker.sock
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
srw------- 1 opengolem opengolem 0 Apr  7 12:00 escalation.sock
```

The leading `s` indicates a Unix socket. The permission bits must be `------` for group and other (i.e., `rw-------` overall).

If you see wider permissions (e.g., `srw-rw-rw-`), tighten them immediately:

```bash
chmod 600 data/sockets/broker.sock data/sockets/escalation.sock
```

---

## 4. Systemd and Launchd Service Hardening

Decision 34 requires production deployments to launch the orchestrator with Node.js `--permission` flags. These flags restrict what the Node.js process can access — limiting filesystem reads/writes and network connections to only what OpenGolem legitimately needs.

### 4.1 Node.js `--permission` flag set

The required flags for the orchestrator process are:

```
--experimental-permission
--allow-fs-read=./groups/,./data/,./SOUL.md,./PSYCHE.md,./package.json
--allow-fs-write=./groups/,./data/
--allow-child-process
--allow-worker
```

Network access is not restricted by Node.js `--permission` flags (that is handled by the firewall and bind-address configuration above). Filesystem restrictions are the primary control here.

Adjust the paths if your `groups/` or `data/` directories are at non-default locations.

### 4.2 Systemd unit file (Linux)

Create or edit your systemd unit file (typically at `/etc/systemd/system/opengolem.service` or `~/.config/systemd/user/opengolem.service`):

```ini
[Unit]
Description=OpenGolem AI Assistant Orchestrator
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=opengolem
WorkingDirectory=/opt/opengolem
EnvironmentFile=/opt/opengolem/.env
ExecStart=node \
  --experimental-permission \
  --allow-fs-read=./groups/,./data/,./SOUL.md,./PSYCHE.md,./package.json \
  --allow-fs-write=./groups/,./data/ \
  --allow-child-process \
  --allow-worker \
  dist/index.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opengolem

[Install]
WantedBy=multi-user.target
```

Reload systemd and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable opengolem
sudo systemctl start opengolem
```

### 4.3 Launchd plist (macOS)

Edit `~/Library/LaunchAgents/com.opengolem.plist` to include the permission flags in the `ProgramArguments` array:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opengolem</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>--experimental-permission</string>
    <string>--allow-fs-read=./groups/,./data/,./SOUL.md,./PSYCHE.md,./package.json</string>
    <string>--allow-fs-write=./groups/,./data/</string>
    <string>--allow-child-process</string>
    <string>--allow-worker</string>
    <string>dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/yourname/assistants/OpenGolem</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/opengolem.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/opengolem-error.log</string>
</dict>
</plist>
```

Load or reload the agent:

```bash
launchctl unload ~/Library/LaunchAgents/com.opengolem.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.opengolem.plist
```

### 4.4 WSL / no systemd

For WSL or environments without systemd, use the provided start script. Edit `start-opengolem.sh` to prepend the `--permission` flags to the node invocation, then run it normally:

```bash
bash start-opengolem.sh
```

---

## 5. Verification Checklist

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
ls -la data/sockets/broker.sock data/sockets/escalation.sock
```

Expected: both files show `srw-------` with the OpenGolem service user as owner.

### Step 5 — `ufw` status shows the correct rules

```bash
sudo ufw status verbose | grep 3001
```

Expected: one ALLOW rule on `docker0`, one DENY rule on `any`.

### Step 6 — Orchestrator started with `--permission` flags

```bash
# systemd
systemctl --user show opengolem -p ExecStart

# launchd (macOS)
launchctl list com.opengolem

# manual check (any platform)
ps aux | grep 'experimental-permission'
```

Expected: the process arguments include `--experimental-permission` and the `--allow-fs-read`/`--allow-fs-write` flags.

### Step 7 — Broker socket is reachable from orchestrator process

Send a `health` JSON-RPC call to the broker socket (see also `broker-recovery.md` §3 for the full health-check one-liner):

```bash
echo '{"jsonrpc":"2.0","method":"health","params":{},"id":1}' | \
  nc -U data/sockets/broker.sock
```

Expected response:

```json
{"jsonrpc":"2.0","result":{"status":"ok"},"id":1}
```
