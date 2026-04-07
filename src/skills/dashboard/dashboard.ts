/**
 * Dashboard Skill — M30 Stub Implementation
 *
 * All exports are typed stubs that throw 'not implemented'.
 * M31 replaces these with real implementations.
 *
 * Spec: docs/specs/dashboard-skill-spec.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KpiValues {
  security_failures_per_call: number;
  data_leaks_per_call: number;
  behavioral_change_rate: number;
}

export interface KpiTrend {
  current: KpiValues;
  prior: KpiValues | null;
  trend: {
    security: '↑' | '↓' | '=';
    leaks: '↑' | '↓' | '=';
    behavioral: '↑' | '↓' | '=';
  } | null;
  firstPeriod: boolean;
  /** Absolute count of data_leak events in the current period */
  dataLeakAbsoluteCount?: number;
  /** Total calls in the current period */
  totalCallsInPeriod?: number;
}

export type HanseiReportState =
  | 'unread'
  | 'read-no-action'
  | 'reviewed-decision-recorded';

export interface HanseiReportSummary {
  id: string;
  period: string;
  state: HanseiReportState;
  arrivedAt: Date;
  /** true if report is unread and older than 7 days */
  ageWarning: boolean;
}

export interface BlockEvent {
  checkId: string;
  occurredAt: Date;
  containerId: string | null;
  outcome: string;
  riskCode: string | null;
  criterion: string | null;
}

export type DecisionType =
  | 'no_change'
  | 'threshold_adjust'
  | 'criterion_review'
  | 'defer';

export interface CalibrationDecision {
  type: DecisionType;
  criterion: string;
  rationale: string;
  proposedThreshold?: number;
  deferUntil?: string;
  reportId?: string;
}

export interface CalibrationDecisionResult {
  filePath: string;
  psycheMdDiffPreview?: string;
}

export interface FalsePositiveCapture {
  checkId: string;
  criterion: string;
  classification: 1 | 2 | 3;
  description: string;
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  catoSocketPresent: boolean;
  auditLogReachable: boolean;
  unreadReportCount: number;
  oldestUnreadAgeDays: number | null;
  unreviewedFpCount: number;
  openDecisionCount: number;
  ageWarning: boolean;
}

// ---------------------------------------------------------------------------
// Stub functions — M31 implements these
// ---------------------------------------------------------------------------

/**
 * Compute KPI trend from the audit database.
 *
 * Reads per-period KPI values from hansei report files. Falls back to
 * direct audit log computation if dao_score.db is absent (AC-53).
 *
 * @param auditDbPath  Path to data/audit.db (or bind-mount equivalent)
 * @param daoScoreDbPath  Optional path to data/dao_score.db; omit to force fallback
 */
export function computeKpiTrend(
  auditDbPath: string,
  daoScoreDbPath?: string,
): KpiTrend {
  void auditDbPath;
  void daoScoreDbPath;
  throw new Error('not implemented');
}

/**
 * List all hansei reports from the inbox directory, sorted by default order:
 * unread first → read-no-action → reviewed-decision-recorded;
 * newest first within each group (AC-57).
 *
 * @param inboxDir  Path to data/hansei/inbox/
 */
export function listHanseiReports(inboxDir: string): HanseiReportSummary[] {
  void inboxDir;
  throw new Error('not implemented');
}

/**
 * Query block history from the audit events table.
 *
 * Returns events WHERE outcome IN ('block', 'soft_block').
 * Optionally filters by criterion (check_id pattern match).
 * Sorted newest first (AC-53 block history spec).
 *
 * @param auditDbPath  Path to audit.db
 * @param criterion    Optional PSY-nn criterion to filter by
 * @param limit        Max rows to return (default: 50)
 */
export function queryBlockHistory(
  auditDbPath: string,
  criterion?: string,
  limit?: number,
): BlockEvent[] {
  void auditDbPath;
  void criterion;
  void limit;
  throw new Error('not implemented');
}

/**
 * Record a calibration decision to data/calibration-decisions/.
 *
 * Writes cd-<YYYYMMDD>-<uuid>.json.
 * For threshold_adjust: generates and stores psycheMdDiffPreview.
 * PSYCHE.md is never modified (AC-34).
 * Rejects rationale shorter than 20 characters (AC-30).
 *
 * @param decisionsDir  Path to data/calibration-decisions/
 * @param psycheMdPath  Path to runtime/PSYCHE.md (read-only)
 * @param decision      Decision data
 */
export function recordCalibrationDecision(
  decisionsDir: string,
  psycheMdPath: string,
  decision: CalibrationDecision,
): CalibrationDecisionResult {
  void decisionsDir;
  void psycheMdPath;
  void decision;
  throw new Error('not implemented');
}

/**
 * Record a false-positive flag to data/calibration-decisions/.
 *
 * Writes fp-<YYYYMMDD>-<uuid>.json.
 * Rejects description shorter than 10 characters (AC-40).
 * Returns a confirmation message including the short check_id (AC-42).
 *
 * @param decisionsDir  Path to data/calibration-decisions/
 * @param capture       False-positive capture data
 */
export function recordFalsePositive(
  decisionsDir: string,
  capture: FalsePositiveCapture,
): { filePath: string; confirmationMessage: string } {
  void decisionsDir;
  void capture;
  throw new Error('not implemented');
}

/**
 * Build the current system health status from all data sources.
 *
 * Checks cato socket presence, audit log reachability, unread report count
 * and age, open calibration decisions, and unreviewed FP flags.
 *
 * Status is 'degraded' when catoSocketPresent = false (AC-7).
 *
 * @param opts  Paths to all data sources
 */
export function buildHealthStatus(opts: {
  catoSocketPath: string;
  auditDbPath: string;
  inboxDir: string;
  decisionsDir: string;
  psycheMdPath: string;
}): HealthStatus {
  void opts;
  throw new Error('not implemented');
}
