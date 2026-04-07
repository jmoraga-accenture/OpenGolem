# Dashboard Skill — Behavioral Specification (M29)

*Produced: 2026-04-07 | Spec Writer: Claude Code | Stream: C (sub-item)*
*Source: ARCHITECTURE.md §5.4, ADR-3, ADR-4, ADR-9; DECISIONS.md Decision 3, Decision 29; cato-spec.md §2.2–§2.4; audit-log-spec.md §3.1–§3.4; skill-schema-spec.md §2; soul-psyche-spec.md §Alert Thresholds; ux-review-dashboard.md (Status: Approved by Jim 2026-04-07)*

---

## 1. Responsibilities

The dashboard skill is the governance interface between the system's automated oversight layer (Cato) and the administrator who is ultimately responsible for calibrating it. It provides:

1. **KPI trend display** — surfacing dao_score values from hansei reports, alongside absolute call counts and period-over-period trends, so the administrator can understand posture changes in context (R-1 per Jim's approval).
2. **Hansei report inbox management** — tracking the full lifecycle of every Cato report from unread through decision-recorded, with a persistent age indicator to prevent silent accumulation of unreviewed governance work (R-6 per Jim's approval).
3. **Block history examination** — a navigable view of `cato_block_applied` and related audit events, queryable by criterion and time period.
4. **Calibration decision recording** — a structured form for recording `no_change`, `threshold_adjust`, `criterion_review`, and `defer` decisions, with mandatory rationale and PSYCHE.md diff preview for threshold changes. Default/recommended threshold targets are provided per criterion as reference points (Jim's R-4 override: "we need some default values or at least recommended targets").
5. **False-positive capture** — a three-keystroke path from any block detail view to the flag submission form, treating false-positive signals as architecturally load-bearing calibration inputs (ADR-3, R-8).
6. **Open decision surfacing** — persistent visibility of `threshold_adjust` decisions not yet applied to PSYCHE.md, escalating after 3 days (R-7).

**What the dashboard skill does not do:**

- Write to, edit, or modify PSYCHE.md. The separation between recording a decision and applying it is the mechanism that makes threshold changes deliberate rather than runtime toggles (ADR-3).
- Write to `data/audit.db` or `data/dao_score.db`. It is a read-only consumer of those data sources.
- Perform Cato inline checks or modify Cato's runtime behavior in any way.
- Auto-apply threshold recommendations. Cato does not recalibrate itself (ADR-3); neither does the dashboard act as a proxy for auto-recalibration.
- Issue or hold credentials of any kind. The skill has no entries in `token_scopes`.
- Declare MCP servers. The dashboard does not declare MCP servers and is not affected by Decision 29's Phase 1 interim control (confirmed in DECISIONS.md Decision 29).
- Present raw payload content at any level of the UI. Payload content is never reproduced in Cato responses or audit records (ADR-4); the dashboard inherits that constraint.

---

## 2. Skill Identity

### 2.1 `.intent.md` Declaration

```yaml
---
skill: dashboard
version: 1.0.0
type: container
description: Governance interface — KPI trends, hansei reports, block history, threshold calibration decisions, false-positive capture

token_scopes:
  # No token scope additions — the dashboard holds no credentials and makes no LLM calls on behalf of users.

filesystem:
  host_reads:
    - data/audit.db
    - data/dao_score.db
    - data/hansei/inbox/
    - data/calibration-decisions/
    - runtime/PSYCHE.md
  host_writes:
    - data/calibration-decisions/
  container_mounts:
    - host_path: data/audit.db
      container_path: /workspace/audit.db
      access: read
    - host_path: data/dao_score.db
      container_path: /workspace/dao_score.db
      access: read
    - host_path: data/hansei/inbox
      container_path: /workspace/hansei/inbox
      access: read
    - host_path: data/calibration-decisions
      container_path: /workspace/calibration-decisions
      access: read-write
    - host_path: runtime/PSYCHE.md
      container_path: /workspace/PSYCHE.md
      access: read

network:
  # No network endpoints declared. The dashboard is a local read surface only.

mcp:
  # No MCP servers declared.

providers:
  compatible:
    - any

apply_permission: admin
---
```

### 2.2 `.intent.md` — Design Notes

**Why `apply_permission: admin`:** The dashboard exposes governance data derived from audit records across all groups. It is an administrator-only surface. No power-user path is appropriate.

**Why no `token_scopes`:** The dashboard skill does not add any capability to agent tokens. Its container reads from bound filesystem paths. It writes only to `data/calibration-decisions/` — a local decisions log that is not part of the audit log and does not feed Cato at runtime.

**Why `runtime/PSYCHE.md` is read-only mounted:** The dashboard needs to read current threshold values to compare them against recorded `threshold_adjust` decisions (R-7) and to generate diff previews. It never writes to this file.

**Why `data/dao_score.db` is listed separately:** The dao_score database is the materialized KPI history computed by Cato from the audit log. It provides efficient per-period trend queries without requiring the dashboard to re-derive KPIs from the full audit log on every open. If `data/dao_score.db` does not exist (early deployment), the dashboard falls back to computing KPIs directly from `data/audit.db` for the current and previous period only, and displays a note indicating that historical trend data is limited.

---

## 3. Commands

The dashboard skill exposes five commands. All commands run in a transient container with the bind mounts declared in §2.1.

### 3.1 `dashboard open`

**Mode:** Interactive TUI.

**Entry points:**
- `dashboard open` — opens the full dashboard TUI.
- `Ctrl-D` from the TUI channel — toggles the split-pane health panel (Decision 4), which includes the system health banner and unread report count. The full dashboard TUI is a deeper view; the split-pane panel is a persistent ambient indicator.

**Screen hierarchy (standard 80×24 terminal):**

The top three sections fit on a standard 80×24 terminal without scrolling. Detail views are subordinate screens.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SYSTEM HEALTH                                                                │
│  Cato: OK  |  Audit log: OK  |  Last report: 2h ago  |  1 unread (oldest: 3d)│
│  2 unreviewed false-positive flags  |  1 open calibration decision (4d pending)│
├─────────────────────────────────────────────────────────────────────────────┤
│ HANSEI REPORTS                                                               │
│  [UNREAD]  hansei-20260406-abc1def2  Mon 00:00–08:00 UTC  2h ago            │
│            KPIs: sec ↑  leaks =  adapt ↓  |  2 high, 1 medium findings      │
│  [READ]    hansei-20260405-11223344  Sun 00:00–08:00 UTC  26h ago            │
│            KPIs: sec =  leaks =  adapt =  |  0 findings  |  no decision      │
├─────────────────────────────────────────────────────────────────────────────┤
│ KPI SUMMARY — current period vs. prior                                       │
│  security_failures_per_call   0.023 ↑  (prior: 0.014)  watch threshold: 0.05│
│  data_leaks_per_call          0.003 =  (prior: 0.003)   2 events in 667 calls│
│  Block pattern variation      0.74  ↓  (prior: 0.81)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ RECENT BLOCKS  (last 10)                                  [e] expand  [f] flag│
│ ...                                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ FALSE-POSITIVE INBOX           [r] review  [a] archive                        │
│ ...                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

**System health banner fields (always visible, one line):**

| Field | Display | Absent when |
|-------|---------|-------------|
| Cato socket status | `Cato: OK` / `Cato: UNREACHABLE` | Never absent |
| Audit log status | `Audit log: OK` / `Audit log: ERROR` | Never absent |
| Last hansei report age | `Last report: Nh ago` / `No reports yet` | Never absent |
| Unread report summary | `N unread (oldest: Xd)` | Absent only when N = 0 |
| Unreviewed FP flags | `N unreviewed false-positive flags` | Absent only when N = 0 |
| Open calibration decisions | `N open calibration decision (Nd pending)` | Absent only when N = 0 |

When an unread report is older than 7 days, the age indicator is displayed with a warning prefix: `WARNING: 1 unread — oldest: 8d ago`.

**KPI display rules:**

- Every KPI is displayed with: current period value, trend arrow (↑ ↓ =), prior period value, and absolute event count where applicable.
- `data_leaks_per_call` always displays the absolute count inline: `0.003 = (2 events in 667 calls)`.
- `behavioral_change_rate` is labeled "Block pattern variation" in the display. Its detail view includes a one-sentence explanation: "This measures whether agents encounter a different set of block triggers each period. A high value may mean agents are adapting, or may mean the system is blocking many different things inconsistently. Compare with security_failures_per_call to distinguish."
- KPI threshold reference lines are shown from PSYCHE.md: `watch threshold: 0.05` and `alert threshold: 0.15` for `security_failures_per_call`.
- Color is used as a secondary signal only (amber border when approaching a threshold; red border when exceeding). Numeric values are always present and never replaced by color alone (R-9).
- If only one period of data exists, display the value with label "First period — no trend available."

### 3.2 `dashboard report-summary`

**Mode:** Non-interactive (single-pass output). Suitable for restricted SSH sessions, scripted monitoring, or bandwidth-constrained use.

**Output format:**

```
OpenGolem Dashboard Summary — 2026-04-07 14:32 UTC
  Hansei reports: 3 total, 1 unread (oldest: 3d ago)
  KPI direction (current period): sec_failures ↑  data_leaks =  adapt ↓
  Unreviewed false-positive flags: 2
  Open calibration decisions (not applied): 1 (4d since recorded)
  System: Cato OK, Audit log OK
```

This command does not open a TUI and does not require terminal capabilities. All output goes to stdout. Exit code 0 on success; non-zero if any data source is unreachable.

### 3.3 `dashboard review <report-id>`

**Mode:** Interactive — opens a single hansei report in the review flow.

`<report-id>` may be the full UUID or the first 8 characters (short form shown in the inbox list). If the short form is ambiguous, an error is returned listing the matching full IDs.

**Report detail view contents:**

- Report ID (full UUID)
- Period covered: human-readable date range (`Audit period: Monday 00:00 – Monday 08:00 UTC`)
- Total calls in period (absolute number)
- KPI values for the period with comparison to prior period (per §3.1 KPI display rules)
- Anomaly findings, sorted by severity (high → medium → low → info):
  - Finding ID (short form)
  - Severity label
  - Criterion ID (PSY-nn) alongside its plain-language description loaded from PSYCHE.md cache (R-2)
  - Risk class description
  - Block count for the period
  - Threshold that was exceeded
  - Whether any false-positive flags are associated with this criterion in this period
- Recommendation flags from the report's `recommendationFlags` array

**Payload content note (R-3):** At the block detail level, the dashboard displays: "Payload content is not shown — this prevents blocked content from being injected into the review interface." This note appears inline; the absence of payload content is never silent.

**State transition:** When the administrator exits the review view, the dashboard prompts: "Mark this report as read? (y/n)". Selecting yes transitions the report to `read-no-action`. The administrator is not required to record a calibration decision to advance the read state. Not responding does not advance the state — the report remains `unread`.

**Navigation from report to decision form:** `[d]` at any point in the review view opens the calibration decision form (§3.4) pre-populated with the report ID and current period dates. The criterion field is not pre-populated.

**Navigation from finding to block history:** `[b]` on a finding line opens the block history filtered to that criterion ID.

### 3.4 `dashboard calibrate <criterion>`

**Mode:** Interactive — opens the calibration decision recording form for a specific criterion.

`<criterion>` is a PSY-nn identifier (e.g. `PSY-02`). If the criterion is not found in PSYCHE.md, an error is returned with the list of valid criterion IDs.

**Decision recording form fields:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `decision_type` | enum | yes | `no_change` \| `threshold_adjust` \| `criterion_review` \| `defer` |
| `criterion_id` | string | yes | PSY-nn, pre-filled from command argument |
| `report_id` | string | no | UUID of the hansei report this decision relates to (optional link) |
| `current_threshold` | number | if `threshold_adjust` | Read from PSYCHE.md at form open time; displayed read-only |
| `proposed_threshold` | number | if `threshold_adjust` | Administrator-entered; no default value pre-populated |
| `threshold_target_reference` | display-only | n/a | See §4.2 — the recommended target range for this criterion is shown as a reference, not pre-populated as the proposed value |
| `rationale` | text | yes | Minimum 20 characters; prompt reads "What evidence supports this decision?" (R-5) |
| `expected_review_date` | date | if `defer` | Optional; ISO-8601 date |

**Threshold target reference (Jim's R-4 override):** The form displays, below the `proposed_threshold` input, a reference block that the administrator must not confuse with a recommendation:

```
  Reference targets (from PSYCHE.md defaults):
    PSY-02  watch threshold: 2 blocks/period  |  alert threshold: 5 blocks/period
  These are the canonical deployment defaults. Enter a value based on your review.
```

The administrator types their own value. The reference block is informational only. If the administrator cannot arrive at a value, the correct action is `defer` — the reference block includes this prompt: "If you cannot determine an appropriate value, select 'defer'."

**PSYCHE.md diff preview (for `threshold_adjust` decisions, R-11):** After the form is submitted, the dashboard displays the exact edit required to PSYCHE.md in unified diff format:

```
--- runtime/PSYCHE.md (current)
+++ runtime/PSYCHE.md (proposed)
@@ -42,7 +42,7 @@
 | PSY-02 | ... | AGENT_PROMPT, MEMORY_WRITE | 2 |
+| PSY-02 | ... | AGENT_PROMPT, MEMORY_WRITE | 4 |
```

Below the diff: "To apply this change, edit `runtime/PSYCHE.md` and restart Cato. The proposed edit is shown above. This dashboard does not apply edits to PSYCHE.md."

**Post-submission confirmation:** "Decision recorded: `threshold_adjust` for PSY-02. Rationale: [first 100 chars of rationale]. This does not change PSYCHE.md. Report will be marked as reviewed."

**What happens at submission:**
- Decision is appended to `data/calibration-decisions/` as a JSON record (see §5.2).
- If a `report_id` was linked, that report transitions to `reviewed-decision-recorded` state.
- The PSYCHE.md diff preview is displayed.
- The running Cato threshold is not modified.

**What does not happen:**
- PSYCHE.md is not written, touched, or staged.
- No Cato reconfiguration occurs.
- No runtime threshold value changes.

### 3.5 `dashboard false-positive <block-id>`

**Mode:** Interactive — opens the false-positive capture form for a specific `check_id` from the audit log.

`<block-id>` is the `check_id` UUID of a `cato_block_applied` event. Short form (first 8 characters) is accepted if unambiguous.

**Three-keystroke path from block history (R-8):**

From any block detail view in the TUI:
1. `[f]` — opens the false-positive flag form with the `check_id` pre-filled.
2. `[1]` / `[2]` / `[3]` — selects classification (`user-reported` / `administrator-reviewed` / `pattern-observed`).
3. After typing the description (minimum 10 characters), `[Enter]` submits. Confidence defaults to `uncertain` and can be changed inline before submit.

**False-positive capture form fields:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `check_id` | string | yes | Pre-filled from argument or TUI context; UUID |
| `classification` | enum | yes | `user-reported` \| `administrator-reviewed` \| `pattern-observed` |
| `description` | text | yes | Minimum 10 characters; prompt reads "What should have happened?" |
| `confidence` | enum | yes | `definite` \| `probable` \| `uncertain` (default: `uncertain`) |

**Post-capture confirmation:** "Flag recorded for check `<short-id>`. This will appear in your next calibration review. It does not change the running configuration."

**Storage:** False-positive records are appended to `data/calibration-decisions/fp-<YYYYMMDD>-<uuid>.json`. They are linked by `check_id` to the underlying `cato_block_applied` audit event. They are surfaced in the false-positive inbox panel, the block history detail view, and the calibration decision form.

---

## 4. Data Sources and Access Model

### 4.1 Read-Only Data Sources

| Source | Path | What the dashboard reads |
|--------|------|--------------------------|
| Audit log | `data/audit.db` (bind-mounted at `/workspace/audit.db`) | `cato_block_applied`, `cato_check`, `cato_audit_complete`, `hansei_report_ready`, `hansei_report_ingested` events — read-only SQLite queries |
| dao_score database | `data/dao_score.db` (bind-mounted at `/workspace/dao_score.db`) | Per-period KPI values and trend history — read-only |
| Hansei report files | `data/hansei/inbox/` (bind-mounted at `/workspace/hansei/inbox`) | Report JSON files matching `hansei-*.json` — read-only |
| PSYCHE.md | `runtime/PSYCHE.md` (bind-mounted at `/workspace/PSYCHE.md`) | PSY-nn criterion definitions, current threshold values, recommended targets — read-only |

**The dashboard never writes to any of these sources.** SQLite connections to `audit.db` and `dao_score.db` are opened with `PRAGMA query_only = ON`. Any write attempt against these databases from dashboard code is a bug.

### 4.2 KPI Data Flow

Cato computes KPI values per audit period and records them in each hansei report's `daoScore` object. The dashboard reads these values directly from the report files. Cato sends counts per period; the dashboard calculates cumulative values when displaying trends across multiple periods (R-1 as clarified by Jim: "Cato sends counts per period, interfaces do the cumulative calculations").

```
Cato scheduled audit
    │
    ▼
Writes hansei-<timestamp>-<uuid>.json to data/hansei/inbox/
  ├── totalCallsInPeriod: 834            ← absolute count, per period
  └── daoScore:
        security_failures_per_call: 0.023  ← rate, per period
        data_leaks_per_call: 0.003          ← rate, per period
        behavioral_change_rate: 0.74        ← rate, per period
    │
    ▼
Dashboard reads report files
  ├── Displays per-period values from each report directly
  └── Calculates cumulative totals and trends across reports
        totalCallsCumulative = sum(totalCallsInPeriod) over N periods
        KPI trend = current_period_value vs. prior_period_value
```

The dashboard never re-derives KPI formulas. It reads the values Cato computed. If a report's `daoScore` is missing a KPI field, that field is displayed as "unavailable" with a note: "This field was not present in the report. Check Cato version compatibility."

### 4.3 Recommended Threshold Targets

Per Jim's R-4 override: default/recommended threshold targets are provided in the calibration decision form as reference points, not as pre-populated values. These targets are read from PSYCHE.md at dashboard startup and cached for the session.

**Canonical deployment defaults (from soul-psyche-spec.md):**

| KPI | Watch threshold | Alert threshold |
|-----|----------------|-----------------|
| `security_failures_per_call` | > 0.05 | > 0.15 |
| `data_leaks_per_call` | — | > 0.01 |
| `behavioral_change_rate` | — | < 0.5 |

**Per-criterion thresholds (from cato-spec.md §3.3):**

| Criterion | Default `block_threshold_per_period` |
|-----------|-------------------------------------|
| PSY-01 | 1 |
| PSY-02 | 2 |
| PSY-03 | 1 |
| PSY-04 | 1 |
| PSY-05 | 3 |

These values are displayed as reference in the calibration form. They are not inserted as proposed values. If PSYCHE.md has been edited to change any threshold from its default, the current PSYCHE.md value is shown alongside the original default.

### 4.4 Write Surface

The dashboard's sole write surface is `data/calibration-decisions/`. It writes two types of records:

1. **Calibration decisions** (`cd-<YYYYMMDD>-<uuid>.json`) — records from `dashboard calibrate`.
2. **False-positive flags** (`fp-<YYYYMMDD>-<uuid>.json`) — records from `dashboard false-positive` or the TUI flag form.

Both are append-only JSON files. Existing files are never modified. The directory is created by the dashboard on first write if it does not exist.

The `data/calibration-decisions/` directory is **not** the audit log and is **not** the hansei inbox. It is a local administrator decisions log. It is not read by Cato. It does not feed into dao_score computation. It is not audited by the Call Inspector.

---

## 5. Data Schemas

### 5.1 Hansei Report State

The dashboard tracks the state of each hansei report independently of the report file itself. State is stored in `data/calibration-decisions/report-state.json` (a single JSON object keyed by report ID).

| State | Meaning |
|-------|---------|
| `unread` | Report has been ingested by the orchestrator but not yet opened by the administrator |
| `read-no-action` | Administrator opened and acknowledged the report; no calibration decision was recorded |
| `reviewed-decision-recorded` | Administrator recorded a calibration decision linked to this report |

State transitions:
```
unread
  → read-no-action       (administrator marks report as read, or records no-decision)
  → reviewed-decision-recorded  (administrator submits a calibration decision linked to this report)
```

`read-no-action` may transition to `reviewed-decision-recorded` at any time — the administrator can record a decision for a previously read report.

**Reports never automatically leave the unread state.** An unread report that is not acted upon remains visible and accumulates an age indicator (R-6). After 7 days in `unread` state, the system health banner displays a warning-level indicator.

**Default sort order:** Unread reports first, then read-no-action, then reviewed-decision-recorded. Within each group, newest first.

### 5.2 Calibration Decision Record Schema

```json
{
  "recordId": "<uuid>",
  "recordType": "calibration_decision",
  "recordedAt": "<ISO8601>",
  "criterionId": "PSY-02",
  "decisionType": "no_change | threshold_adjust | criterion_review | defer",
  "reportId": "<uuid | null>",
  "currentThreshold": 2,
  "proposedThreshold": 4,
  "rationale": "Three false positives in period for multi-turn pattern. All were legitimate multi-message task continuations, not injection attempts. Current threshold of 2 is too tight for this group's typical interaction style.",
  "expectedReviewDate": "<ISO8601 | null>",
  "psycheMdDiffPreview": "<unified diff string | null>"
}
```

`psycheMdDiffPreview` is populated only for `threshold_adjust` decisions. It is the exact diff text shown in the form. It is stored so the administrator can retrieve it later without re-opening the form.

### 5.3 False-Positive Flag Record Schema

```json
{
  "recordId": "<uuid>",
  "recordType": "false_positive_flag",
  "recordedAt": "<ISO8601>",
  "checkId": "<uuid>",
  "blockEventId": "<audit log event id>",
  "classification": "user-reported | administrator-reviewed | pattern-observed",
  "description": "User reported that the agent was blocked during a legitimate multi-document review task. The flagged action was a normal MEMORY_WRITE for context preservation.",
  "confidence": "definite | probable | uncertain",
  "status": "open | reviewed"
}
```

`status` starts as `open`. The administrator may mark it `reviewed` from the false-positive inbox panel. Reviewed flags remain in the record; they are never deleted.

---

## 6. Hansei Report Lifecycle

### 6.1 States and Transitions

```
[Cato writes report to data/hansei/inbox/]
         │
         ▼
    UNREAD ──────────────────────────────────────────────────────►  age indicator accrues
         │                                                          after 7 days: WARNING banner
         │  administrator opens report (dashboard review <id>)
         ▼
    READ-NO-ACTION
         │
         │  administrator records decision (dashboard calibrate)
         ▼
    REVIEWED-DECISION-RECORDED
```

Reports never age off or disappear. The administrator must actively advance the state.

### 6.2 Escalation Behavior

| Age of unread report | System behavior |
|---------------------|-----------------|
| 0–6 days | Standard display in health banner: "N unread (oldest: Xd ago)" |
| 7+ days | Warning-level prefix in health banner: "WARNING: 1 unread — oldest: 8d ago" |
| Any age, `read-no-action` with a linked `threshold_adjust` decision older than 3 days not applied to PSYCHE.md | Open decision indicator in health banner: "1 open calibration decision (Nd pending)" |

The 7-day escalation threshold and 3-day open-decision threshold are deployment defaults. They are not configurable at runtime (consistent with ADR-3's "deliberate administrator decisions" principle), but may be set as environment variables documented as non-secret config vars in `bootstrap.ts` per Decision 9.

---

## 7. Calibration Decision Flow

This section describes the complete flow from anomaly observation to recorded decision. The UX design is for calm review, not fast completion — no progress bars, auto-advance, or "next step" affordances (R-10).

### Step 1: Entry

The administrator opens the dashboard (proactively or after noticing the health banner indicator). The health banner is visible in the TUI split-pane without opening the full dashboard.

### Step 2: Open Hansei Report

`dashboard review <report-id>` or selecting a report from the inbox in the TUI (`dashboard open`).

The administrator sees the period, total calls, KPI values with comparison, anomaly findings with PSY-nn criterion IDs and their plain-language descriptions from PSYCHE.md (R-2), block counts, and exceeded thresholds.

Payload content is never displayed. The absence is explained inline (R-3).

### Step 3: Examine Block History

From a finding: `[b]` opens the block history filtered to that criterion. The administrator sees chronologically ordered `cato_block_applied` events: timestamp, action type, context ID (anonymized), risk code, reason (risk class, not payload), and whether any false-positive flag exists for that block.

The false-positive capture path (`[f]`) is available from any block row in this view (R-8).

### Step 4: Review False-Positive Signals

From the block history, or from the false-positive inbox panel: filter to the criterion under review. If no false-positive flags exist for the criterion in this period, the view displays "No false-positive reports for PSY-nn in this period" — not a blank view (R-6 clarity principle applied to FP display).

### Step 5: Record Calibration Decision

`[d]` from the report view, or `dashboard calibrate PSY-nn` directly.

The decision form (§3.4) requires:
- Decision type (no_change / threshold_adjust / criterion_review / defer)
- Rationale (minimum 20 characters, mandatory regardless of decision type)

For `threshold_adjust`:
- Administrator enters their proposed value. The reference block shows canonical defaults for context (Jim's R-4 override). No value is pre-populated.
- The form surfaces: "If you cannot determine an appropriate value, select 'defer'."

For `defer`:
- Optional expected review date is prompted.

### Step 6: Receive Confirmation and Diff Preview

On submission, the dashboard displays:
- Confirmation summary with rationale preview
- For `threshold_adjust`: PSYCHE.md diff preview (R-11)
- Statement that PSYCHE.md has not been modified

### Step 7: Mark Report Reviewed

If a `report_id` was linked in the decision form, the report transitions to `reviewed-decision-recorded`. If the administrator exits the review view after reading without submitting a decision, they are prompted to mark the report `read-no-action`.

### Step 8: Apply Change (Out of Dashboard Scope)

The administrator copies the diff preview, edits `runtime/PSYCHE.md`, and restarts Cato. This step is outside the dashboard skill's scope — the dashboard provides the diff and documents the separation, but takes no action.

If the `threshold_adjust` decision is not applied within 3 days (verified by comparing the recorded `proposedThreshold` against the current PSYCHE.md value), the open decision indicator appears in the health banner (R-7).

---

## 8. False-Positive Capture Path

### 8.1 Entry Points

The false-positive capture path is reachable from three surfaces:

1. **Block history view** — `[f]` on any `cato_block_applied` row (one key to open the form with context pre-filled).
2. **Hansei report finding detail** — `[f]` on a finding to flag all blocks associated with that criterion in the period.
3. **Direct command** — `dashboard false-positive <check-id>` for administrators relaying a user report without opening the full TUI.

### 8.2 Three-Keystroke Path (R-8)

From any block detail view:
1. `[f]` — opens flag form; `check_id` and criterion are pre-filled.
2. `[1]` / `[2]` / `[3]` — selects classification (`user-reported` / `administrator-reviewed` / `pattern-observed`).
3. After typing description (≥10 characters), `[Enter]` submits. Confidence defaults to `uncertain`; `[tab]` toggles to `probable` or `definite` before submit if desired.

Maximum three keystrokes if description is not required to be typed (e.g., paste from clipboard). The form does not navigate away from the block history view after submission — the administrator returns to the same block list.

### 8.3 Visibility

The running count of unreviewed false-positive flags is shown in the system health banner whenever the count is nonzero. The most recent unreviewed flags are surfaced in the false-positive inbox panel on the main dashboard view.

After capture, the confirmation reads: "Flag recorded for check `<short-id>`. This will appear in your next calibration review."

False-positive records are linked by `check_id` to the underlying audit event. They appear in the block history detail for the flagged block, in the false-positive inbox, and in the calibration decision form when the administrator is recording a threshold adjustment for the relevant criterion.

---

## 9. Security Constraints

### 9.1 Read-Only Audit and dao_score Access

The dashboard opens `data/audit.db` and `data/dao_score.db` with `PRAGMA query_only = ON`. It does not issue INSERT, UPDATE, or DELETE statements against either database. Violation of this constraint is a bug, not a configuration risk.

### 9.2 No PSYCHE.md Writes

The dashboard reads `runtime/PSYCHE.md` to display current threshold values and generate diff previews. It has no write access to this file. The bind mount declared in `.intent.md` is `access: read`. Any attempt to write `runtime/PSYCHE.md` from within the dashboard container fails at the OS level.

The separation between recording a calibration decision (dashboard) and applying a threshold change (administrator editing PSYCHE.md + deploying) is architecturally intentional (ADR-3). The dashboard must not provide any affordance — even a "staged change" or "pending apply" mode — that blurs this separation.

### 9.3 No Credentials in Scope

The dashboard declares no `token_scopes`. It holds no derivative tokens. It makes no LLM API calls. It does not contact the Token Broker, Cato's inline socket, or any external endpoint. The Call Inspector has no surface to inspect for this skill.

### 9.4 No Payload Reproduction

The dashboard never displays payload content. Audit log records contain only `payload_hash` and `payload_size` — not payload content — and the dashboard does not attempt to reconstruct content from these fields. When the administrator reaches the block detail view, the dashboard displays the explanation required by R-3.

### 9.5 Trust Domain Placement

The dashboard skill container is a member of TD-CONTAINER[n] during its execution. It receives no inbound connections. Its only outbound activities are read queries to the bind-mounted SQLite files and writes to `data/calibration-decisions/`. It does not contact Cato, the Token Broker, or any channel. It is the administrator's read surface, not a runtime component.

---

## 10. Acceptance Criteria

### 10.1 Skill Identity and Installation

| AC | Description |
|----|-------------|
| AC-1 | The skill's `.intent.md` declares `skill: dashboard`, `version: 1.0.0`, `type: container`, `apply_permission: admin`. |
| AC-2 | The skill declares no `token_scopes`, no `network.endpoints`, and no `mcp.servers`. |
| AC-3 | All five bind mounts are declared with correct `access` values: `audit.db` → read, `dao_score.db` → read, `hansei/inbox` → read, `calibration-decisions` → read-write, `PSYCHE.md` → read. |
| AC-4 | Applying the skill with a user whose role is not `admin` fails with a validation error; the skill is not applied. |
| AC-5 | Applying the skill with a malformed `.intent.md` fails with an error naming the specific failing field; the skill is not applied. |

### 10.2 `dashboard open`

| AC | Description |
|----|-------------|
| AC-6 | The TUI fits the system health banner, hansei report inbox, and KPI summary panel on a standard 80×24 terminal without scrolling. |
| AC-7 | The system health banner always displays Cato socket status and audit log status, regardless of other panel content. |
| AC-8 | When at least one unread hansei report exists, the health banner displays the count and the age of the oldest unread report. |
| AC-9 | When an unread report is older than 7 days, the health banner displays a warning-level prefix. |
| AC-10 | When unreviewed false-positive flags exist, the health banner displays the count. |
| AC-11 | When a `threshold_adjust` decision is more than 3 days old and has not been applied to PSYCHE.md, the health banner displays an open decision indicator. |
| AC-12 | All three KPI values are displayed with: current period value, trend indicator (↑ ↓ =), prior period value, and PSYCHE.md threshold reference lines. |
| AC-13 | `data_leaks_per_call` always displays the absolute event count inline alongside the rate. |
| AC-14 | `behavioral_change_rate` is labeled "Block pattern variation" in the TUI display. |
| AC-15 | When only one period of data exists, the KPI panel displays "First period — no trend available" instead of a trend indicator. |
| AC-16 | KPI color encoding (border color, status indicators) is used as a secondary signal only; numeric values and reference thresholds are always present. |

### 10.3 `dashboard report-summary`

| AC | Description |
|----|-------------|
| AC-17 | The command produces output on stdout without opening a TUI and without requiring terminal capabilities. |
| AC-18 | The output includes: report count, unread count with oldest age, KPI direction for current period, unreviewed FP flag count, and system health status. |
| AC-19 | Exit code is 0 on success; non-zero if any data source is unreachable. |

### 10.4 `dashboard review <report-id>`

| AC | Description |
|----|-------------|
| AC-20 | The report detail view displays: report ID, human-readable period, total calls in period, KPI values with prior-period comparison, and anomaly findings sorted high → medium → low → info. |
| AC-21 | Each anomaly finding displays the PSY-nn criterion ID alongside its plain-language description read from PSYCHE.md. The administrator is not required to consult PSYCHE.md separately. |
| AC-22 | No payload content is displayed at any level of the report view. The block detail level displays the explanation: "Payload content is not shown — this prevents blocked content from being injected into the review interface." |
| AC-23 | `[b]` from a finding opens the block history filtered to that criterion. |
| AC-24 | `[d]` from the report view opens the calibration decision form with the report ID linked. |
| AC-25 | On exit from the report view, the administrator is prompted to mark the report as read if it is still in `unread` state. |
| AC-26 | Short-form `<report-id>` (first 8 characters) is accepted. If ambiguous, an error is returned listing the matching full IDs. |

### 10.5 `dashboard calibrate <criterion>`

| AC | Description |
|----|-------------|
| AC-27 | The calibration form requires: decision type, rationale (≥20 characters), and — for `threshold_adjust` — proposed threshold. |
| AC-28 | The `proposed_threshold` field is empty by default. No system-suggested value is pre-populated. |
| AC-29 | The form displays a reference block showing the canonical deployment defaults and the current PSYCHE.md value for the criterion. The reference block is labeled to distinguish it from a recommendation. |
| AC-30 | The rationale field prompt reads "What evidence supports this decision?" and a minimum of 20 characters is enforced. |
| AC-31 | On submission of a `threshold_adjust` decision, the dashboard displays a PSYCHE.md diff preview in unified diff format. |
| AC-32 | The diff preview is accompanied by a statement that PSYCHE.md has not been modified and that the administrator must apply the edit manually. |
| AC-33 | After submission, the decision record is written to `data/calibration-decisions/cd-<YYYYMMDD>-<uuid>.json` with all required fields including `psycheMdDiffPreview`. |
| AC-34 | PSYCHE.md is not modified at any point during or after the calibration flow. |
| AC-35 | The running Cato threshold is not modified at any point during or after the calibration flow. |
| AC-36 | For `defer` decisions, an optional expected review date is prompted. |
| AC-37 | If the criterion argument is not found in PSYCHE.md, an error is returned listing valid criterion IDs. |

### 10.6 `dashboard false-positive <block-id>`

| AC | Description |
|----|-------------|
| AC-38 | The false-positive flag form is openable from the block history view with a single keystroke (`[f]`), with `check_id` and criterion pre-filled. |
| AC-39 | Classification can be selected with a single keystroke (`[1]` / `[2]` / `[3]`). |
| AC-40 | The description field requires a minimum of 10 characters; the prompt reads "What should have happened?" |
| AC-41 | After submission, the administrator returns to the same block list view — the form does not navigate away. |
| AC-42 | The confirmation after capture reads "Flag recorded for check `<short-id>`. This will appear in your next calibration review." |
| AC-43 | The flag record is written to `data/calibration-decisions/fp-<YYYYMMDD>-<uuid>.json` with all required fields. |
| AC-44 | The false-positive flag is surfaced in the block history detail view for the flagged block. |
| AC-45 | The running count of unreviewed false-positive flags is updated in the health banner after capture. |

### 10.7 Data Access and Security

| AC | Description |
|----|-------------|
| AC-46 | All SQLite connections to `data/audit.db` and `data/dao_score.db` are opened with `PRAGMA query_only = ON`. No INSERT, UPDATE, or DELETE is issued against either database. |
| AC-47 | PSYCHE.md is never written to by any dashboard code path. The bind mount access is `read`; the OS rejects any write attempt. |
| AC-48 | No payload content is reconstructed or displayed from `payload_hash` or `payload_size` fields. |
| AC-49 | The dashboard makes no outbound network calls, no LLM API calls, and does not contact Cato's inline socket or the Token Broker socket. |
| AC-50 | No credential material is present in the dashboard container environment. No `token_scopes` are declared in `.intent.md`. |

### 10.8 KPI Data Flow

| AC | Description |
|----|-------------|
| AC-51 | Per-period KPI values are read from hansei report files' `daoScore` objects, not re-derived from audit log data (except as fallback when `data/dao_score.db` is absent). |
| AC-52 | Cumulative totals (e.g., total calls across N periods) are calculated by the dashboard from per-period `totalCallsInPeriod` values. |
| AC-53 | If `data/dao_score.db` does not exist, the dashboard falls back to direct audit log computation for current and prior period only, and displays a note indicating limited historical trend data. |
| AC-54 | If a hansei report's `daoScore` is missing a KPI field, the dashboard displays "unavailable" for that field with a note about version compatibility. |

### 10.9 Hansei Report Lifecycle

| AC | Description |
|----|-------------|
| AC-55 | Reports default to `unread` state and remain `unread` until explicitly advanced by the administrator. |
| AC-56 | An unread report that is opened and exited without a decision recorded transitions to `read-no-action` only after the administrator responds "yes" to the transition prompt. |
| AC-57 | The default sort order places unread reports first, read-no-action second, reviewed-decision-recorded third; within each group, newest first. |
| AC-58 | Reports are never automatically removed, archived, or aged out of the inbox. |
| AC-59 | After 7 days in `unread` state, the health banner displays a warning-level prefix for that report. |
| AC-60 | A `threshold_adjust` decision more than 3 days old that has not been reflected in the current PSYCHE.md threshold value triggers the open decision indicator in the health banner. |

---

## 11. Design Rationale Notes

### 11.1 Why the dashboard is a container skill, not a host process

The dashboard is a `container` skill (ARCHITECTURE.md §5.1). It runs in an ephemeral container with explicitly declared read mounts. This means:
- No persistent state is held by the dashboard itself (state lives in `data/calibration-decisions/`).
- The dashboard's access to audit and governance data is governed by the same bind-mount model as all other skills.
- Restart cycles do not affect governance state.
- The administrator's interaction is explicit and bounded — the dashboard does not run continuously in the background.

### 11.2 Why the dashboard never auto-applies PSYCHE.md changes

ADR-3 states that threshold changes require deliberate administrator decisions. The dashboard is the interface through which that deliberateness is exercised. If the dashboard could apply a PSYCHE.md change — even with a confirmation prompt — it would collapse the multiple-step requirement into a single session. The multiple-step requirement (record decision → review diff → edit file → commit → restart Cato) is the mechanism that makes threshold changes feel consequential and auditable. The dashboard's responsibility ends at producing the diff and recording the decision.

### 11.3 Why false-positive capture is a first-class command

ADR-3 explains that the only reliable calibration signal comes from outside the feedback loop: user false-positive reports, actual incident outcomes, administrator judgment. The dashboard skill is the mechanism through which that external signal enters the system. If the false-positive capture path is buried, ADR-3's design intent is undermined regardless of what the governance data shows. The three-keystroke path (R-8) is not a usability nicety — it is the architectural guarantee that the calibration loop can be closed.

### 11.4 Why recommended targets are provided (Jim's R-4 override)

The UX reviewer's original recommendation was to never pre-populate a suggested threshold value. Jim's override introduced a distinction between pre-populating the proposed value (which remains prohibited) and displaying reference targets (which is required). The reference block shows what the canonical deployment defaults are, labeled explicitly as reference material, alongside the current PSYCHE.md value. The administrator must still reason to their own proposed value. If they cannot, `defer` is the correct path. Providing no reference at all risks administrators entering arbitrary values without understanding the system's baseline calibration expectations.

---

*This document is the normative behavioral specification for the dashboard skill (M29). Implementation must satisfy all acceptance criteria in §10. Any divergence from the security constraints in §9 is a defect, not a design choice.*
