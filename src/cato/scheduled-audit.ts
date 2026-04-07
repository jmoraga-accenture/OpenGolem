/**
 * Cato — Scheduled audit runner.
 *
 * Every CATO_AUDIT_INTERVAL_MS (default 6h):
 *   1. Compute dao_score KPIs from audit.db
 *   2. Build a structured audit summary from recent calls and [FLAG] events
 *   3. Run a Cato LLM container with PSYCHE.md as its system prompt
 *   4. Parse the JSON findings and write atomically to data/hansei/inbox/
 *
 * Report filename: hansei-<ISO8601-compact>-<uuid>.json
 * Write protocol: write-to-temp-then-rename (atomic)
 *
 * Audit log writes:
 *   - cato_audit_start: at beginning of each run
 *   - cato_audit_complete + hansei_report_ready: after report written
 *   - cato_audit_error: if run fails or report cannot be written
 *
 * Cato's container is NOT registered in registeredGroups — it is not
 * addressable by any channel, agent, or task-level token.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  CATO_AUDIT_INTERVAL_MS,
  DATA_DIR,
  GROUPS_DIR,
  PSYCHE_MD_PATH,
} from '../config.js';
import { runContainerAgent } from '../container-runner.js';
import { getAuditDb } from '../inspector/audit.js';
import { logger } from '../logger.js';
import { openAuditLog, type AuditLog } from '../shared/audit/index.js';
import { RegisteredGroup } from '../types.js';
import { computeDaoScore, saveDaoScore } from './dao-score.js';

// ---------------------------------------------------------------------------
// Cato group config — not in registeredGroups, used only for container spawn
// ---------------------------------------------------------------------------

export const CATO_GROUP_FOLDER = 'cato';

export const CATO_GROUP: RegisteredGroup = {
  name: 'Cato',
  folder: CATO_GROUP_FOLDER,
  trigger: '@Cato',
  added_at: '2026-04-03T00:00:00.000Z',
  requiresTrigger: false,
  isMain: false,
  assertivenessLevel: 10,
};

/** Hansei report inbox directory (spec §2.2). */
const HANSEI_INBOX_DIR = path.join(DATA_DIR, 'hansei', 'inbox');

// ---------------------------------------------------------------------------
// Audit log singleton for the scheduled audit runner
// ---------------------------------------------------------------------------

let _schedAuditLog: AuditLog | null = null;

function getSchedAuditLog(): AuditLog | null {
  if (_schedAuditLog) return _schedAuditLog;
  try {
    const dbPath = path.join(DATA_DIR, 'audit.db');
    _schedAuditLog = openAuditLog(dbPath, 'cato');
    return _schedAuditLog;
  } catch (err) {
    logger.error({ err }, 'Cato scheduled audit: failed to open audit log');
    return null;
  }
}

/** For tests: inject a pre-initialised audit log. */
export function _setSchedAuditLog(log: AuditLog | null): void {
  _schedAuditLog = log;
}

// ---------------------------------------------------------------------------
// Group folder bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensure groups/cato/ exists with its own CLAUDE.md identity.
 * Called once at startup — Cato's folder is never registered in
 * registeredGroups, so it must be set up independently.
 */
export function ensureCatoGroupFolder(): void {
  const groupDir = path.join(GROUPS_DIR, CATO_GROUP_FOLDER);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(
      claudeMd,
      `# Cato\n\nYou are Cato, OpenGolem's hard oversight layer.\nYour operating contract is in PSYCHE.md.\nProduce only the JSON report format specified there.\n`,
    );
  }

  // Ensure hansei inbox exists at startup
  fs.mkdirSync(HANSEI_INBOX_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Audit summary builder
// ---------------------------------------------------------------------------

function buildAuditSummary(windowMs: number): string {
  const db = getAuditDb();
  const now = Date.now();
  const since = now - windowMs;

  const calls = db
    .prepare(
      'SELECT id, ts, container, skill, outcome, block_rule FROM calls WHERE ts >= ? ORDER BY ts DESC LIMIT 200',
    )
    .all(since) as Array<{
    id: number;
    ts: number;
    container: string;
    skill: string;
    outcome: string;
    block_rule: string | null;
  }>;

  const flags = db
    .prepare(
      'SELECT ts, group_jid, assertiveness_level, response_snippet FROM flag_events WHERE ts >= ? ORDER BY ts DESC LIMIT 30',
    )
    .all(since) as Array<{
    ts: number;
    group_jid: string;
    assertiveness_level: number;
    response_snippet: string;
  }>;

  const blocks = calls.filter((c) => c.outcome !== 'pass');

  let s = `## Audit window\n`;
  s += `Start: ${new Date(since).toISOString()}\n`;
  s += `End:   ${new Date(now).toISOString()}\n\n`;
  s += `Total calls inspected: ${calls.length}\n`;
  s += `Blocks: ${blocks.length}\n`;
  s += `[FLAG] assertiveness events: ${flags.length}\n\n`;

  if (blocks.length > 0) {
    s += `### Recent blocked calls (up to 15):\n`;
    for (const b of blocks.slice(0, 15)) {
      s += `- [${new Date(b.ts).toISOString()}] container=${b.container} skill=${b.skill} outcome=${b.outcome} rule=${b.block_rule ?? 'n/a'}\n`;
    }
    s += '\n';
  }

  if (flags.length > 0) {
    s += `### Recent [FLAG] events (up to 10):\n`;
    for (const f of flags.slice(0, 10)) {
      s += `- [${new Date(f.ts).toISOString()}] chat=${f.group_jid} assertiveness=${f.assertiveness_level}: ${f.response_snippet.slice(0, 120)}\n`;
    }
    s += '\n';
  }

  return s;
}

// ---------------------------------------------------------------------------
// PSYCHE.md loader
// ---------------------------------------------------------------------------

function loadPsycheMd(): string {
  const p = PSYCHE_MD_PATH;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    logger.warn(
      'Cato: PSYCHE.md not found — audit container will run without it',
    );
    return '';
  }
}

// ---------------------------------------------------------------------------
// ISO8601 compact timestamp for filenames (e.g. 20260407T120000Z)
// ---------------------------------------------------------------------------

function toIso8601Compact(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Main audit runner
// ---------------------------------------------------------------------------

export async function runCatoAudit(): Promise<void> {
  logger.info('Cato: starting scheduled audit');

  const runId = crypto.randomUUID();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - CATO_AUDIT_INTERVAL_MS);
  const windowMs = CATO_AUDIT_INTERVAL_MS;

  // Write cato_audit_start event
  const auditLog = getSchedAuditLog();
  if (auditLog) {
    try {
      auditLog.writeEvent({
        event_type: 'cato_audit_start',
        outcome: 'started',
        details: {
          run_id: runId,
          period_start: periodStart.toISOString(),
          period_end: periodEnd.toISOString(),
        },
      });
    } catch (err) {
      logger.error({ err, runId }, 'Cato: failed to write cato_audit_start');
    }
  }

  // Step 1: Compute and persist dao_score
  const legacyAuditDb = getAuditDb();
  const score = computeDaoScore(legacyAuditDb, windowMs);
  saveDaoScore(score);

  logger.info(
    {
      security_failures_per_call: score.security_failures_per_call.toFixed(4),
      data_leaks_per_call: score.data_leaks_per_call.toFixed(4),
      behavioral_change_rate: score.behavioral_change_rate.toFixed(4),
    },
    'Cato: dao_score computed',
  );

  // Log threshold alerts
  if (score.security_failures_per_call > 0.15) {
    logger.warn(
      { value: score.security_failures_per_call },
      'Cato: security_failures_per_call CRITICAL (>0.15)',
    );
  } else if (score.security_failures_per_call > 0.05) {
    logger.warn(
      { value: score.security_failures_per_call },
      'Cato: security_failures_per_call elevated (>0.05)',
    );
  }
  if (score.data_leaks_per_call > 0.01) {
    logger.warn(
      { value: score.data_leaks_per_call },
      'Cato: data_leaks_per_call elevated (>0.01)',
    );
  }
  if (score.behavioral_change_rate < 0.5) {
    logger.warn(
      { value: score.behavioral_change_rate },
      'Cato: behavioral_change_rate low (<0.5) — agent may not be adjusting after blocks',
    );
  }

  // Step 2: Build audit summary
  const auditSummary = buildAuditSummary(windowMs);
  const psycheMd = loadPsycheMd();

  // Step 3: Compose prompt for Cato container
  const prompt =
    `${auditSummary}\n` +
    `## Current dao_score KPIs\n` +
    `- security_failures_per_call: ${score.security_failures_per_call.toFixed(6)}\n` +
    `- data_leaks_per_call: ${score.data_leaks_per_call.toFixed(6)}\n` +
    `- behavioral_change_rate: ${score.behavioral_change_rate.toFixed(6)}\n\n` +
    `Produce the JSON audit report as specified in your operating contract (PSYCHE.md). ` +
    `Output only the JSON — no prose before or after.`;

  // Step 4: Run Cato container
  let agentResult: { status: string; result: string | null } = {
    status: 'skipped',
    result: null,
  };

  try {
    ensureCatoGroupFolder();

    const output = await runContainerAgent(
      CATO_GROUP,
      {
        prompt,
        groupFolder: CATO_GROUP_FOLDER,
        chatJid: 'cato:audit',
        isMain: false,
        isScheduledTask: true,
        assistantName: 'Cato',
        soulMd: psycheMd || undefined, // PSYCHE.md overrides SOUL.md for Cato
      },
      () => {}, // no-op: Cato container not tracked in GroupQueue
    );

    agentResult = { status: output.status, result: output.result };
  } catch (err) {
    logger.error({ err }, 'Cato: audit container failed');
    agentResult = { status: 'error', result: String(err) };
  }

  // Step 5: Parse and write report
  const reportId = crypto.randomUUID();
  let parsedFindings: unknown = null;
  if (agentResult.status === 'success' && agentResult.result) {
    // Strip markdown fences if the model wrapped the JSON
    const raw = agentResult.result
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      parsedFindings = JSON.parse(raw);
    } catch {
      logger.warn(
        { snippet: raw.slice(0, 120) },
        'Cato: audit response was not valid JSON — saving raw',
      );
    }
  }

  const report = {
    reportId,
    generatedAt: new Date().toISOString(),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    daoScore: {
      security_failures_per_call: score.security_failures_per_call,
      data_leaks_per_call: score.data_leaks_per_call,
      behavioral_change_rate: score.behavioral_change_rate,
    },
    anomalyFindings: [],
    recommendationFlags: [],
    reportVersion: '1.0',
    // Extended fields for compatibility
    agent_status: agentResult.status,
    findings: parsedFindings,
    raw_output: parsedFindings ? undefined : agentResult.result,
  };

  // Ensure inbox directory exists
  fs.mkdirSync(HANSEI_INBOX_DIR, { recursive: true });

  // Build filename: hansei-<ISO8601-compact>-<uuid>.json
  const tsCompact = toIso8601Compact(new Date(report.generatedAt));
  const filename = `hansei-${tsCompact}-${reportId}.json`;
  const finalPath = path.join(HANSEI_INBOX_DIR, filename);
  const tmpPath = finalPath + '.tmp';

  // Atomic write: write to temp then rename
  fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2));
  fs.renameSync(tmpPath, finalPath);

  const reportStatus =
    parsedFindings && typeof parsedFindings === 'object'
      ? (parsedFindings as Record<string, unknown>).status
      : 'unknown';

  logger.info({ reportPath: finalPath, status: reportStatus }, 'Cato: audit complete');

  if (reportStatus === 'alert') {
    logger.warn(
      { reportPath: finalPath },
      'Cato: ALERT status — review hansei inbox',
    );
  }

  // Write audit events: cato_audit_complete + hansei_report_ready
  if (auditLog) {
    try {
      auditLog.writeEvent({
        event_type: 'cato_audit_complete',
        outcome: 'completed',
        details: {
          run_id: runId,
          report_id: reportId,
        },
      });
    } catch (err) {
      logger.error({ err, runId }, 'Cato: failed to write cato_audit_complete');
    }

    // reportPath hash (spec §2.4: store hash, not raw path)
    const reportPathHash = crypto
      .createHash('sha256')
      .update(finalPath, 'utf8')
      .digest('hex');

    try {
      auditLog.writeEvent({
        event_type: 'hansei_report_ready',
        outcome: 'completed',
        details: {
          run_id: runId,
          report_id: reportId,
          report_path_hash: reportPathHash,
        },
      });
    } catch (err) {
      logger.error({ err, runId }, 'Cato: failed to write hansei_report_ready');
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let auditTimer: ReturnType<typeof setInterval> | null = null;

export function startCatoScheduledAudit(): void {
  if (auditTimer) return;

  logger.info(
    { intervalMs: CATO_AUDIT_INTERVAL_MS },
    'Cato: scheduled audit armed',
  );

  // Run first audit after one full interval (not immediately on startup)
  auditTimer = setInterval(() => {
    runCatoAudit().catch((err) =>
      logger.error({ err }, 'Cato: scheduled audit threw unexpectedly'),
    );
  }, CATO_AUDIT_INTERVAL_MS);

  // Allow the process to exit even if the timer is pending
  auditTimer.unref();
}

export function stopCatoScheduledAudit(): void {
  if (auditTimer) {
    clearInterval(auditTimer);
    auditTimer = null;
  }
}
