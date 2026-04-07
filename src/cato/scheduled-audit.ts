/**
 * Cato — Scheduled audit runner.
 *
 * Every CATO_AUDIT_INTERVAL_MS (default 6h):
 *   1. Compute dao_score KPIs from audit.db → write to dao_score.db
 *   2. Build a structured audit summary from recent calls and [FLAG] events
 *   3. Run a Cato LLM container with PSYCHE.md as its system prompt
 *   4. Parse the JSON findings and write to reports/cato-<timestamp>.json
 *
 * Cato's container is NOT registered in registeredGroups — it is not
 * addressable by any channel, agent, or task-level token.
 */
import fs from 'fs';
import path from 'path';

import {
  CATO_AUDIT_INTERVAL_MS,
  GROUPS_DIR,
  PSYCHE_MD_PATH,
} from '../config.js';
import { runContainerAgent } from '../container-runner.js';
import { getAuditDb } from '../inspector/audit.js';
import { logger } from '../logger.js';
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

const REPORTS_DIR = path.join(process.cwd(), 'reports');

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
// Main audit runner
// ---------------------------------------------------------------------------

export async function runCatoAudit(): Promise<void> {
  logger.info('Cato: starting scheduled audit');

  const windowMs = CATO_AUDIT_INTERVAL_MS;

  // Step 1: Compute and persist dao_score
  const auditDb = getAuditDb();
  const score = computeDaoScore(auditDb, windowMs);
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
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORTS_DIR, `cato-${ts}.json`);

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
    computed_at: new Date().toISOString(),
    dao_score: score,
    agent_status: agentResult.status,
    findings: parsedFindings,
    raw_output: parsedFindings ? undefined : agentResult.result,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const reportStatus =
    parsedFindings && typeof parsedFindings === 'object'
      ? (parsedFindings as Record<string, unknown>).status
      : 'unknown';

  logger.info({ reportPath, status: reportStatus }, 'Cato: audit complete');

  if (reportStatus === 'alert') {
    logger.warn(
      { reportPath },
      'Cato: ALERT status — review reports directory',
    );
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
