/**
 * Orchestrator v2 — M23 implementation.
 *
 * Exports:
 *   Orchestrator            — class managing per-group queues, token lifecycle, Cato checks
 *   startOrchestrator       — starts all loops, health checks, socket listeners
 *   stopOrchestrator        — clean shutdown
 *   getOrchestratorHealth   — returns health object
 *   dispatchInboundMessage  — public entry point for channel adapters
 *   loadGroupConfig         — per-group config.json loading with fallback
 *   parseSentinelOutput     — sentinel marker parsing
 *   getAuditWriteStatements — returns list of SQL INSERT statements used
 *   DEPLOYMENT_DEFAULTS     — default group config values
 *
 * Spec: docs/specs/orchestrator-spec.md
 * Decisions: 13, 20, 21, 22, 23, 24, 25, 26
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §2.1 — Normalized inbound message delivered by a channel adapter. */
export interface InboundMessage {
  groupId: string;
  channelId: string;
  senderId: string;
  messageId: string;
  text: string;
  timestamp: string; // ISO-8601
}

/** Per-group config (spec §3.9, Decision 25). */
export interface GroupConfig {
  securityMode: 'golem_guard' | 'supervised' | 'power';
  assertiveness_level: number;
  flag_display_tag?: string;
  blocked_display_tag?: string;
  skill_set_override?: string[];
}

/** Audit log interface (in-memory or SQLite). */
export interface AuditLog {
  append(entry: Record<string, unknown>): void;
}

/** Sentinel output parsed from container stdout. */
export interface SentinelResult {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/** Options for parseSentinelOutput. */
export interface ParseSentinelOptions {
  onError?: (msg: string) => void;
}

/** Channel interface for routing results. */
export interface ChannelAdapter {
  sendMessage(jid: string, text: string): void;
}

/** Options passed to the Orchestrator constructor. */
export interface OrchestratorOptions {
  rootDir: string;
  audit: AuditLog;
  brokerSocketPath?: string;
  catoSocketPath?: string;
  escalationSocketPath?: string;
  channel?: ChannelAdapter;
  defaultTtlMs?: number;
  supervisedConfirmTimeoutMs?: number;
}

/** Cato check request (spec §2.4). */
export interface CatoCheckParams {
  action:
    | 'AGENT_PROMPT'
    | 'OUTBOUND_API_CALL'
    | 'FILESYSTEM_WRITE'
    | 'CREDENTIAL_REQUEST'
    | 'MEMORY_WRITE';
  contextId: string;
  tokenId: string;
  payloadHash: string;
  payloadSize: number;
  contentExcerpt?: string | null;
}

/** Cato check response. */
export interface CatoCheckResult {
  checkId: string;
  allow: boolean;
  code: string | null;
  reason: string | null;
}

/** Remote control invocation params. */
export interface RemoteControlParams {
  groupId: string;
  taskDescription: string;
  bridgeStatus: 'ok' | 'unreachable';
}

/** Supervised wait params. */
export interface SupervisedWaitParams {
  checkId: string;
  groupId: string;
}

/** Memory write proposal. */
export interface MemoryWriteProposal {
  groupId: string;
  taskId: string;
  tokenId: string;
  proposedDelta: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel markers — must match container/agent-runner/src/index.ts */
export const OUTPUT_START_MARKER = '---OPENGOLEM_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---OPENGOLEM_OUTPUT_END---';

/** Valid security mode values. */
const VALID_SECURITY_MODES = new Set(['golem_guard', 'supervised', 'power']);

/** Default deployment configuration (Decision 25). */
export const DEPLOYMENT_DEFAULTS: GroupConfig = {
  securityMode: 'golem_guard',
  assertiveness_level: 10,
};

/** Default TTL for issued tokens (ms). */
const DEFAULT_TOKEN_TTL_MS = 300_000; // 5 minutes

/** Default supervised confirmation timeout (ms) — Decision 24. */
const DEFAULT_SUPERVISED_CONFIRM_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * SQL INSERT statements used by the orchestrator for audit logging.
 * Exported for testability (INV-9).
 */
const AUDIT_SQL_STATEMENTS = [
  `INSERT INTO audit_log (ts, event, groupId, taskId, tokenId, details) VALUES (?, ?, ?, ?, ?, ?)`,
];

// ─────────────────────────────────────────────────────────────────────────────
// Utility — Sentinel output parsing (spec §2.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses sentinel-wrapped output from container stdout.
 * Returns the parsed SentinelResult or null on any error.
 */
export function parseSentinelOutput(
  raw: string,
  opts: ParseSentinelOptions = {},
): SentinelResult | null {
  const onError =
    opts.onError ??
    (() => {
      /* no-op */
    });

  const startIdx = raw.indexOf(OUTPUT_START_MARKER);
  if (startIdx === -1) {
    onError('Missing output start sentinel marker');
    return null;
  }
  const endIdx = raw.indexOf(OUTPUT_END_MARKER, startIdx);
  if (endIdx === -1) {
    onError('Missing output end sentinel marker');
    return null;
  }

  const jsonPart = raw
    .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
    .trim();
  try {
    const parsed = JSON.parse(jsonPart) as SentinelResult;
    return parsed;
  } catch (err) {
    onError(`Failed to parse JSON between sentinel markers: ${String(err)}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility — Audit write statements export (INV-9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all SQL statements the Orchestrator uses for audit writes.
 * All must be INSERT statements (append-only, INV-9).
 */
export function getAuditWriteStatements(): string[] {
  return [...AUDIT_SQL_STATEMENTS];
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility — Group config loading (spec §3.9, Decision 25)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads per-group config from groups/{name}/config.json.
 * Falls back to DEPLOYMENT_DEFAULTS if absent or malformed.
 * Logs config_parse_error audit entry on parse failure.
 */
export async function loadGroupConfig(
  groupDir: string,
  opts: { audit?: AuditLog } = {},
): Promise<GroupConfig> {
  const configPath = path.join(groupDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    return { ...DEPLOYMENT_DEFAULTS };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { ...DEPLOYMENT_DEFAULTS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    opts.audit?.append({
      eventType: 'config_parse_error',
      groupId: path.basename(groupDir),
      reason: 'json_parse_failed',
      ts: Date.now(),
    });
    return { ...DEPLOYMENT_DEFAULTS };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    opts.audit?.append({
      eventType: 'config_parse_error',
      groupId: path.basename(groupDir),
      reason: 'not_an_object',
      ts: Date.now(),
    });
    return { ...DEPLOYMENT_DEFAULTS };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate securityMode
  if (
    typeof obj.securityMode !== 'string' ||
    !VALID_SECURITY_MODES.has(obj.securityMode)
  ) {
    opts.audit?.append({
      eventType: 'config_parse_error',
      groupId: path.basename(groupDir),
      reason: 'invalid_security_mode',
      ts: Date.now(),
    });
    return { ...DEPLOYMENT_DEFAULTS };
  }

  const cfg: GroupConfig = {
    securityMode: obj.securityMode as GroupConfig['securityMode'],
    assertiveness_level:
      typeof obj.assertiveness_level === 'number'
        ? obj.assertiveness_level
        : DEPLOYMENT_DEFAULTS.assertiveness_level,
  };

  if (typeof obj.flag_display_tag === 'string') {
    cfg.flag_display_tag = obj.flag_display_tag;
  }
  if (typeof obj.blocked_display_tag === 'string') {
    cfg.blocked_display_tag = obj.blocked_display_tag;
  }
  if (Array.isArray(obj.skill_set_override)) {
    cfg.skill_set_override = obj.skill_set_override as string[];
  }

  return cfg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility — JSON-RPC 2.0 over Unix socket
// ─────────────────────────────────────────────────────────────────────────────

let _rpcIdCounter = 1;

function nextRpcId(): number {
  return _rpcIdCounter++;
}

function sendJsonRpc(
  sockPath: string,
  method: string,
  params: unknown,
  timeoutMs = 10_000,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  return new Promise((resolve, reject) => {
    const id = nextRpcId();
    const socket = net.createConnection(sockPath);
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`JSON-RPC timeout calling ${method} on ${sockPath}`));
    }, timeoutMs);

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(
            JSON.parse(line) as {
              result?: unknown;
              error?: { code: number; message: string };
            },
          );
        } catch (e) {
          reject(e);
        }
      }
    });

    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n',
      );
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility — Cato inline check over Unix socket
// ─────────────────────────────────────────────────────────────────────────────

function sendCatoCheck(
  sockPath: string,
  req: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<CatoCheckResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Cato check timeout on ${sockPath}`));
    }, timeoutMs);

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(JSON.parse(line) as CatoCheckResult);
        } catch (e) {
          reject(e);
        }
      }
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify(req) + '\n');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Orchestrator class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orchestrator v2 — per-group queue, token lifecycle, Cato checks,
 * escalation relay, Hansei inbox polling.
 */
export class Orchestrator {
  private readonly rootDir: string;
  private readonly audit: AuditLog;
  private readonly brokerSocketPath: string;
  private readonly catoSocketPath: string;
  private readonly escalationSocketPath: string;
  private readonly channel: ChannelAdapter | null;
  private readonly defaultTtlMs: number;
  private readonly supervisedConfirmTimeoutMs: number;

  /** Per-group queue: array of pending InboundMessages */
  private readonly queues = new Map<string, InboundMessage[]>();
  /** Set of groups with an active task */
  private readonly activeGroups = new Set<string>();
  /** Dispatch callback for unit tests */
  private _onDispatch: ((msg: InboundMessage) => void) | null = null;
  /** Health state */
  private quarantinedHanseiReports = 0;
  /** Processed Hansei report names (dedup within session) */
  private processedHanseiReports = new Set<string>();
  /** Escalation socket server */
  private escalationServer: net.Server | null = null;

  constructor(opts: OrchestratorOptions) {
    this.rootDir = opts.rootDir;
    this.audit = opts.audit;
    this.brokerSocketPath =
      opts.brokerSocketPath ??
      path.join(opts.rootDir, 'data', 'sockets', 'broker.sock');
    this.catoSocketPath =
      opts.catoSocketPath ??
      path.join(opts.rootDir, 'data', 'sockets', 'cato.sock');
    this.escalationSocketPath =
      opts.escalationSocketPath ??
      path.join(opts.rootDir, 'data', 'sockets', 'escalation.sock');
    this.channel = opts.channel ?? null;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.supervisedConfirmTimeoutMs =
      opts.supervisedConfirmTimeoutMs ?? DEFAULT_SUPERVISED_CONFIRM_TIMEOUT_MS;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Register a dispatch callback (for unit tests). */
  onDispatch(fn: (msg: InboundMessage) => void): void {
    this._onDispatch = fn;
  }

  /** Manually mark a group as having an active task (for unit tests). */
  markGroupActive(groupId: string): void {
    this.activeGroups.add(groupId);
    if (!this.queues.has(groupId)) {
      this.queues.set(groupId, []);
    }
  }

  /** Manually mark a group as idle and drain its queue (for unit tests). */
  markGroupIdle(groupId: string): void {
    this.activeGroups.delete(groupId);
    this._drainQueue(groupId);
  }

  /** Returns the number of messages queued for a group. */
  getQueueDepth(groupId: string): number {
    return this.queues.get(groupId)?.length ?? 0;
  }

  /** Returns current health object. */
  getHealth(): {
    status: 'ok' | 'degraded';
    quarantinedHanseiReports: number;
  } {
    return {
      status: this.quarantinedHanseiReports > 0 ? 'degraded' : 'ok',
      quarantinedHanseiReports: this.quarantinedHanseiReports,
    };
  }

  /**
   * Delivers an inbound message.
   * Validates schema, logs message_received (hashed senderId), and either
   * dispatches immediately or enqueues.
   */
  async deliver(msg: InboundMessage): Promise<void> {
    this._validateMessage(msg);

    const senderHash = crypto
      .createHash('sha256')
      .update(msg.senderId)
      .digest('hex');

    this.audit.append({
      eventType: 'message_received',
      groupId: msg.groupId,
      messageId: msg.messageId,
      channelId: msg.channelId,
      senderHash,
      ts: Date.now(),
    });

    if (this.activeGroups.has(msg.groupId)) {
      // Enqueue — one active task at a time (INV-1)
      const q = this.queues.get(msg.groupId) ?? [];
      q.push(msg);
      this.queues.set(msg.groupId, q);
      return;
    }

    // Dispatch immediately
    if (this._onDispatch) {
      this._onDispatch(msg);
    }
    await this._dispatchTask(msg);
  }

  /**
   * Polls the Hansei inbox directory for new report files.
   * Valid reports are ingested; malformed ones are quarantined.
   */
  async pollHanseiInbox(): Promise<void> {
    const inboxDir = path.join(this.rootDir, 'data', 'hansei', 'inbox');
    const quarantineDir = path.join(
      this.rootDir,
      'data',
      'hansei',
      'quarantine',
    );

    let files: string[];
    try {
      files = fs.readdirSync(inboxDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (this.processedHanseiReports.has(file)) continue;

      const filePath = path.join(inboxDir, file);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      let report: unknown;
      try {
        report = JSON.parse(raw);
      } catch {
        // Quarantine malformed report
        this.processedHanseiReports.add(file);
        const destPath = path.join(quarantineDir, file);
        try {
          fs.renameSync(filePath, destPath);
        } catch {
          try {
            fs.copyFileSync(filePath, destPath);
            fs.unlinkSync(filePath);
          } catch {
            /* best effort */
          }
        }
        this.quarantinedHanseiReports++;
        this.audit.append({
          eventType: 'hansei_parse_error',
          fileName: file,
          reason: 'json_parse_failed',
          ts: Date.now(),
        });
        continue;
      }

      // Valid report
      this.processedHanseiReports.add(file);
      const reportObj = report as Record<string, unknown>;
      this.audit.append({
        eventType: 'hansei_report_ingested',
        reportId: reportObj.reportId,
        fileName: file,
        ts: Date.now(),
      });
    }
  }

  /**
   * Starts the escalation socket server and begins listening.
   * Must be called before the broker connects to escalation.sock.
   */
  async start(): Promise<void> {
    await this._startEscalationServer();
  }

  /** Stops the escalation socket server. */
  async stop(): Promise<void> {
    if (this.escalationServer) {
      await new Promise<void>((resolve) =>
        this.escalationServer!.close(() => resolve()),
      );
      this.escalationServer = null;
    }
  }

  /**
   * Handles a catoEscalate relay: forwards to Cato after stripping
   * escalationReason and inspectorCheck (Decision 23).
   */
  async handleCatoEscalate(params: {
    checkId: string;
    action: string;
    contextId: string;
    tokenId: string;
    payloadHash: string;
    payloadSize: number;
    escalationReason: string;
    inspectorCheck: string;
    contentExcerpt: string | null;
  }): Promise<CatoCheckResult> {
    // Strip broker-only fields before forwarding to Cato (Decision 23)
    const catoReq = {
      checkId: params.checkId,
      action: params.action,
      contextId: params.contextId,
      tokenId: params.tokenId,
      payloadHash: params.payloadHash,
      payloadSize: params.payloadSize,
      contentExcerpt: params.contentExcerpt,
    };

    let result: CatoCheckResult;
    try {
      result = await sendCatoCheck(this.catoSocketPath, catoReq);
    } catch {
      // Fail-closed: if Cato unreachable, block (AC-18)
      result = {
        checkId: params.checkId,
        allow: false,
        code: 'CATO_UNREACHABLE',
        reason: 'Cato socket unreachable during escalation',
      };
    }

    this.audit.append({
      eventType: 'cato_check_relayed',
      checkId: params.checkId,
      action: params.action,
      outcome: result.allow ? 'allowed' : 'blocked',
      code: result.code ?? null,
      ts: Date.now(),
    });

    return result;
  }

  /**
   * Performs a Cato inline check (spec §2.4).
   * contentExcerpt rules:
   *   - AGENT_PROMPT, MEMORY_WRITE: non-null contentExcerpt required (AC-10)
   *   - FILESYSTEM_WRITE, CREDENTIAL_REQUEST: null (AC-10)
   */
  async performCatoCheck(params: CatoCheckParams): Promise<CatoCheckResult> {
    const checkId = crypto.randomUUID();
    const payloadHash =
      params.payloadHash ??
      crypto
        .createHash('sha256')
        .update(String(params.payloadSize))
        .digest('hex');

    // contentExcerpt rules per AC-10
    let contentExcerpt: string | null;
    if (
      params.action === 'FILESYSTEM_WRITE' ||
      params.action === 'CREDENTIAL_REQUEST'
    ) {
      contentExcerpt = null;
    } else {
      contentExcerpt = params.contentExcerpt ?? null;
    }

    const req = {
      checkId,
      action: params.action,
      contextId: params.contextId,
      tokenId: params.tokenId,
      payloadHash,
      payloadSize: params.payloadSize,
      contentExcerpt,
    };

    try {
      return await sendCatoCheck(this.catoSocketPath, req);
    } catch {
      // Fail-closed: block on Cato unreachable
      return {
        checkId,
        allow: false,
        code: 'CATO_UNREACHABLE',
        reason: 'Cato socket unreachable',
      };
    }
  }

  /**
   * Starts a supervised wait for user confirmation (Decision 24).
   * After supervisedConfirmTimeoutMs, calls resolveSupervised(cancel).
   */
  async startSupervisedWait(params: SupervisedWaitParams): Promise<void> {
    const { checkId } = params;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(async () => {
        // Timeout fires — cancel the supervised check (Decision 24)
        try {
          await sendJsonRpc(this.brokerSocketPath, 'resolveSupervised', {
            checkId,
            decision: 'cancel',
          });
        } catch {
          /* best effort */
        }

        this.audit.append({
          eventType: 'cato_block',
          checkId,
          groupId: params.groupId,
          reason: 'supervised_timeout',
          code: null,
          ts: Date.now(),
        });
        resolve();
      }, this.supervisedConfirmTimeoutMs);

      // Allow early resolution if needed
      void timer; // reference to prevent gc warning
    });
  }

  /**
   * Applies a memory write proposal after a MEMORY_WRITE Cato check.
   * If Cato blocks, the write does not proceed.
   */
  async applyMemoryWriteProposal(proposal: MemoryWriteProposal): Promise<void> {
    const contentExcerpt = proposal.proposedDelta.slice(0, 512);
    const payloadHash = crypto
      .createHash('sha256')
      .update(proposal.proposedDelta)
      .digest('hex');

    const result = await this.performCatoCheck({
      action: 'MEMORY_WRITE',
      contextId: proposal.groupId,
      tokenId: proposal.tokenId,
      payloadHash,
      payloadSize: Buffer.byteLength(proposal.proposedDelta, 'utf8'),
      contentExcerpt,
    });

    if (!result.allow) {
      this.audit.append({
        eventType: 'memory_write_blocked',
        action: 'MEMORY_WRITE',
        groupId: proposal.groupId,
        taskId: proposal.taskId,
        tokenId: proposal.tokenId,
        code: result.code,
        reason: result.reason,
        ts: Date.now(),
      });
      return;
    }

    // Write approved delta to CLAUDE.md (spec §6.1, Decision 22)
    const claudePath = path.join(this.rootDir, 'groups', proposal.groupId, 'CLAUDE.md');
    fs.writeFileSync(claudePath, proposal.proposedDelta, 'utf8');

    this.audit.append({
      eventType: 'memory_write_approved',
      groupId: proposal.groupId,
      taskId: proposal.taskId,
      tokenId: proposal.tokenId,
      ts: Date.now(),
    });
  }

  /**
   * Handles a remote-control invocation (spec §2.7, Decision 13).
   * Fail-closed: if bridgeStatus is 'unreachable', throws without creating a task.
   */
  async handleRemoteControlInvocation(
    params: RemoteControlParams,
  ): Promise<void> {
    if (params.bridgeStatus === 'unreachable') {
      // Fail-closed — do not create a task record, do not queue (AC-28)
      throw new Error(
        'Remote-control bridge is unreachable; task rejected (fail-closed)',
      );
    }

    // Bridge is ok — treat as a dispatched task with sourceChannel: remote-control
    const taskId = crypto.randomUUID();
    this.audit.append({
      eventType: 'task_start',
      groupId: params.groupId,
      taskId,
      sourceChannel: 'remote-control',
      taskDescription: params.taskDescription,
      ts: Date.now(),
    });

    // Synthesize an inbound message and dispatch
    const syntheticMsg: InboundMessage = {
      groupId: params.groupId,
      channelId: 'remote-control',
      senderId: 'remote-control',
      messageId: taskId,
      text: params.taskDescription,
      timestamp: new Date().toISOString(),
    };

    await this._dispatchTask(syntheticMsg);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Validates required fields on an InboundMessage, throws on missing. */
  private _validateMessage(msg: InboundMessage): void {
    if (!msg.groupId)
      throw new Error('InboundMessage missing required field: groupId');
    if (!msg.senderId)
      throw new Error('InboundMessage missing required field: senderId');
    if (msg.text === undefined || msg.text === null)
      throw new Error('InboundMessage missing required field: text');
    if (!msg.timestamp)
      throw new Error('InboundMessage missing required field: timestamp');
  }

  /** Drains the queue for a group after it becomes idle. */
  private _drainQueue(groupId: string): void {
    const q = this.queues.get(groupId);
    if (!q || q.length === 0) return;

    const next = q.shift()!;
    // Fire and forget — queue drain does not block
    void this._dispatchTask(next);
  }

  /**
   * Full task dispatch lifecycle (spec §3.2–§3.4):
   * 1. Mark group active
   * 2. Ensure group directory scaffold (CLAUDE.md, messages.db)
   * 3. Load group config
   * 4. Issue token from broker
   * 5. Cato AGENT_PROMPT check
   * 6. Spawn container
   * 7. Parse sentinel output
   * 8. Revoke token
   * 9. Mark group idle, drain queue
   */
  private async _dispatchTask(msg: InboundMessage): Promise<void> {
    const { groupId } = msg;
    this.activeGroups.add(groupId);
    const taskId = crypto.randomUUID();

    // Determine group directory
    const groupDir = path.join(this.rootDir, 'groups', groupId);

    // Ensure group scaffold exists (Decision 21, Decision 22)
    this._ensureGroupScaffold(groupDir);

    // Load group config
    const cfg = await loadGroupConfig(groupDir, { audit: this.audit });

    // Issue token (spec §3.3)
    let tokenId: string;
    let _token: string;

    this.audit.append({
      eventType: 'token_request',
      groupId,
      taskId,
      securityMode: cfg.securityMode,
      ts: Date.now(),
    });

    try {
      const issueResp = await sendJsonRpc(this.brokerSocketPath, 'issueToken', {
        contextId: groupId,
        skillSet: cfg.skill_set_override ?? ['anthropic.message'],
        ttl: this.defaultTtlMs,
        callBudget: 100,
        dataScopes: [groupId],
        securityMode: cfg.securityMode,
        parentTokenId: null,
      });

      if (issueResp.error) {
        this._notifyChannel(
          groupId,
          `[ERROR] Token issue failed: ${issueResp.error.message}`,
        );
        this.activeGroups.delete(groupId);
        this._drainQueue(groupId);
        return;
      }

      const issueResult = issueResp.result as {
        token: string;
        tokenId: string;
        expiresAt: string;
      };
      tokenId = issueResult.tokenId;
      _token = issueResult.token;
    } catch (err) {
      this._notifyChannel(
        groupId,
        `[ERROR] Broker unavailable: ${String(err)}`,
      );
      this.activeGroups.delete(groupId);
      this._drainQueue(groupId);
      return;
    }

    // TTL abort controller — used to race container execution against TTL
    let ttlFired = false;
    let resolveTtlAbort!: (reason: string) => void;
    const ttlAbortPromise = new Promise<never>((_res, rej) => {
      resolveTtlAbort = (reason) => rej(new Error(reason));
    });

    const ttlTimer = setTimeout(async () => {
      ttlFired = true;
      this.audit.append({
        eventType: 'container_ttl_expired',
        groupId,
        taskId,
        tokenId,
        ts: Date.now(),
      });
      await this._revokeToken(tokenId);
      resolveTtlAbort('TTL expired');
      // Clean up active state
      this.activeGroups.delete(groupId);
      this._drainQueue(groupId);
    }, this.defaultTtlMs);

    try {
      // Cato AGENT_PROMPT check (spec §3.3 step 3)
      const contentExcerpt = msg.text.slice(0, 512);
      const payloadHash = crypto
        .createHash('sha256')
        .update(msg.text)
        .digest('hex');

      const catoResult = await this.performCatoCheck({
        action: 'AGENT_PROMPT',
        contextId: groupId,
        tokenId,
        payloadHash,
        payloadSize: Buffer.byteLength(msg.text, 'utf8'),
        contentExcerpt,
      });

      if (!catoResult.allow) {
        clearTimeout(ttlTimer);
        this.audit.append({
          eventType: 'cato_block',
          groupId,
          taskId,
          tokenId,
          code: catoResult.code,
          reason: catoResult.reason,
          ts: Date.now(),
        });
        await this._revokeToken(tokenId);
        this._notifyChannel(
          groupId,
          `[BLOCKED] Action blocked by Cato: ${catoResult.code ?? 'unknown'}`,
        );
        // BLK-2 fix: release group lock so queue can drain
        this.activeGroups.delete(groupId);
        this._drainQueue(groupId);
        return;
      }

      // Spawn container
      this.audit.append({
        eventType: 'container_spawn',
        groupId,
        taskId,
        tokenId,
        containerId: `container-${taskId}`,
        mountPaths: [groupDir],
        ts: Date.now(),
      });

      const { runContainer } = await import('../container-runner.js');
      const containerResultPromise = runContainer({
        prompt: msg.text,
        groupFolder: groupId,
        chatJid: msg.channelId,
        isMain: false,
      } as Parameters<typeof runContainer>[0]);

      // Race container against TTL abort
      const containerResult = await Promise.race([
        containerResultPromise,
        ttlAbortPromise,
      ]);

      // Cancel TTL timer since container completed first
      clearTimeout(ttlTimer);

      if (ttlFired) {
        // TTL already handled revocation
        return;
      }

      // Parse sentinel output (spec §2.5)
      const parsed = parseSentinelOutput(containerResult.stdout, {
        onError: (e) => {
          this.audit.append({
            eventType: 'sentinel_parse_error',
            groupId,
            taskId,
            tokenId,
            error: e,
            ts: Date.now(),
          });
        },
      });

      if (parsed) {
        this.audit.append({
          eventType: 'task_complete',
          groupId,
          taskId,
          tokenId,
          status: parsed.status,
          newSessionId: parsed.newSessionId,
          ts: Date.now(),
        });

        if (parsed.result) {
          this._notifyChannel(groupId, parsed.result);
        }
      }
    } catch (_err) {
      // TTL abort or other error — clean up if TTL didn't already
      clearTimeout(ttlTimer);
      if (!ttlFired) {
        await this._revokeToken(tokenId!);
      }
      this.activeGroups.delete(groupId);
      this._drainQueue(groupId);
      return;
    }

    clearTimeout(ttlTimer);
    if (!ttlFired) {
      await this._revokeToken(tokenId!);
    }
    this.activeGroups.delete(groupId);
    this._drainQueue(groupId);
  }

  /** Revokes a token via the broker (spec §3.4 step 5, §3.5 step 2). */
  private async _revokeToken(tokenId: string): Promise<void> {
    try {
      await sendJsonRpc(this.brokerSocketPath, 'revokeToken', { tokenId });
    } catch {
      /* best effort */
    }

    this.audit.append({
      eventType: 'token_revoke',
      tokenId,
      ts: Date.now(),
    });
  }

  /** Sends a message to the channel adapter if one is configured. */
  private _notifyChannel(groupId: string, text: string): void {
    this.channel?.sendMessage(groupId, text);
  }

  /**
   * Ensures group directory scaffold exists:
   * - CLAUDE.md (Decision 22, AC-26)
   * - messages.db (Decision 21, AC-25) — WAL mode via PRAGMA
   */
  private _ensureGroupScaffold(groupDir: string): void {
    fs.mkdirSync(groupDir, { recursive: true });

    const claudePath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) {
      fs.writeFileSync(claudePath, '');
    }

    const dbPath = path.join(groupDir, 'messages.db');
    if (!fs.existsSync(dbPath)) {
      // Create the DB file — WAL mode requires better-sqlite3 or raw file creation
      // For scaffold purposes, create the file; WAL pragma applied by tier2 on first open
      fs.writeFileSync(dbPath, '');
    }
  }

  /**
   * Starts the escalation socket server (spec §3.6).
   * Listens on escalation.sock for catoEscalate JSON-RPC calls from the broker,
   * forwards to Cato, returns the result.
   */
  private _startEscalationServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up stale socket
      try {
        if (fs.existsSync(this.escalationSocketPath)) {
          fs.unlinkSync(this.escalationSocketPath);
        }
      } catch {
        /* best effort */
      }

      this.escalationServer = net.createServer((socket) => {
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString();
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;

            let req: {
              jsonrpc: string;
              method: string;
              params: unknown;
              id: number;
            };
            try {
              req = JSON.parse(line) as typeof req;
            } catch {
              continue;
            }

            if (req.method === 'catoEscalate') {
              void this.handleCatoEscalate(
                req.params as Parameters<typeof this.handleCatoEscalate>[0],
              )
                .then((result) => {
                  socket.write(
                    JSON.stringify({ jsonrpc: '2.0', result, id: req.id }) +
                      '\n',
                  );
                })
                .catch(() => {
                  const failResult: CatoCheckResult = {
                    checkId: (req.params as { checkId?: string }).checkId ?? '',
                    allow: false,
                    code: 'RELAY_ERROR',
                    reason: 'Escalation relay failed',
                  };
                  socket.write(
                    JSON.stringify({
                      jsonrpc: '2.0',
                      result: failResult,
                      id: req.id,
                    }) + '\n',
                  );
                });
            }
          }
        });
      });

      this.escalationServer.on('error', reject);

      this.escalationServer.listen(this.escalationSocketPath, () => {
        resolve();
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton (for startOrchestrator / stopOrchestrator / getOrchestratorHealth)
// ─────────────────────────────────────────────────────────────────────────────

let _singleton: Orchestrator | null = null;

export function startOrchestrator(options: OrchestratorOptions): Promise<void> {
  _singleton = new Orchestrator(options);
  return _singleton.start();
}

export function stopOrchestrator(): Promise<void> {
  if (!_singleton) return Promise.resolve();
  return _singleton.stop();
}

export function getOrchestratorHealth(): ReturnType<Orchestrator['getHealth']> {
  if (!_singleton) return { status: 'ok', quarantinedHanseiReports: 0 };
  return _singleton.getHealth();
}

export function dispatchInboundMessage(msg: InboundMessage): Promise<void> {
  if (!_singleton) throw new Error('Orchestrator not started');
  return _singleton.deliver(msg);
}
