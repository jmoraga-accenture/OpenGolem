# Stream K — UX Review: Report Dashboard Skill (M5)
*Status: Awaiting PM approval | Produced: 2026-04-07*
*UX/Interaction Designer: Claude Code | Scope: Governance dashboard information architecture and oversight quality*

---

## Inputs Read

Before producing this review, the following documents were read in full:

- `docs/ARCHITECTURE.md` §5.4 (dashboard skill mandate), ADR-3 (no auto-recalibration), ADR-9 (audit log as source of truth)
- `docs/specs/cato-spec.md` §2.2 (hansei report schema), §3.5 (dao_score KPIs), §3.3 (PSYCHE.md criteria)
- `docs/specs/audit-log-spec.md` §3.2 (event type enumeration)
- `docs/ux/stream-j-cli-tui.md` — prior UX decisions, health panel design, `[FLAG]`/`[BLOCKED]` template decisions
- `docs/SECURITY_STRENGTHENING.md` — F-3 (audit log integrity), F-7 (self-hosted safety posture gap)
- `docs/ARCHITECTURE.md` ADR-1, ADR-4 (Cato is infrastructure; every block is explained)

---

## Scope and Method

This review covers the dashboard skill as the primary governance interface for human calibration (ADR-3). The dashboard is the mechanism through which administrators exercise judgment over Cato's outputs — what was blocked, whether it was appropriate, and whether thresholds need adjustment. Because this interface directly affects the quality of human oversight decisions, it has the highest responsible AI consequence of any UX surface in the system.

Findings are presented as: **information architecture decisions**, **user flows**, **friction and ambiguity points**, and **responsible AI framing**. The final section explicitly assesses whether the proposed design supports or undermines human oversight quality.

---

## 1. Information Architecture

### 1.1 Dashboard Mandate (from ARCHITECTURE.md §5.4)

The dashboard skill is mandated to surface:
- KPI trend surfaces (three dao_score metrics)
- Block history view
- Hansei report inbox display
- Threshold change recommendation flow
- False-positive signal capture path

These five surfaces have different information cadences, different user intents, and different responsible AI weights. Treating them as a flat list of features would produce a dashboard that is technically complete but operationally difficult to use. The architecture specifies them as a surface, not an interaction design. This review provides that design.

---

### 1.2 Primary Navigation: Two Modes

The dashboard serves two distinct use modes that require separate entry points:

**Mode 1 — Periodic review (scheduled)**
The administrator has received a notification that a new hansei report is available. They open the dashboard to read the report, understand the findings, decide whether to adjust thresholds, and record their decision.

**Mode 2 — Incident investigation (ad hoc)**
Something unexpected happened. The administrator opens the dashboard to look at block history, find the relevant events, and understand what Cato detected.

These two modes have different starting points and different completion criteria. The dashboard should open in **Periodic review mode by default** (because the primary governance workflow is report-driven, per ADR-3) with a clearly labeled path to **Incident investigation**.

**Recommended top-level structure:**

```
Dashboard
├── Reports (default view)
│   ├── Inbox — new hansei reports awaiting review
│   ├── Archive — previously reviewed reports with decisions
│   └── [current report detail view]
├── KPI Trends
│   ├── security_failures_per_call
│   ├── data_leaks_per_call
│   └── behavioral_change_rate
├── Block History
│   ├── Filtered by: period / group / risk code
│   └── [block detail view]
└── Threshold History
    └── PSYCHE.md change log with rationale records
```

The inbox count (number of unreviewed reports) should be visible on the top-level entry point before the administrator opens the dashboard. In the TUI health panel (Stream J §1.2), this maps to the GOVERNANCE section's "Last hansei report" line — if unreviewed reports exist, this line should show `[N unreviewed]` rather than just the last report date.

---

### 1.3 KPI Trend Surfaces

Cato computes three KPIs per scheduled audit period (cato-spec.md §3.5):

| KPI | Formula | What it measures |
|-----|---------|-----------------|
| `security_failures_per_call` | (hard_blocks + soft_blocks) / total proxied calls | Rate of suspicious call blocking |
| `data_leaks_per_call` | `MEMORY_SCOPE_VIOLATION` blocks / total proxied calls | Rate of out-of-scope memory access attempts |
| `behavioral_change_rate` | distinct block codes that did not re-fire within 10 subsequent calls / total distinct codes fired | Whether agents adjust after being blocked |

These are diagnostic KPIs. They have no inherent "good" or "bad" value — a high `security_failures_per_call` could mean the system is under attack or it could mean the thresholds are too sensitive. Presenting them as gauges with red/amber/green zones would be actively harmful: it would encourage threshold adjustment to improve a metric, which ADR-3 explicitly prohibits because it creates proxy optimization.

**Recommendation 1.3a — KPI presentation without evaluative coloring:**

Each KPI should be presented as a time-series line chart spanning the last N audit periods (configurable; default: 30 days). No color-coded zones. No "target range" indicators. No trend arrows. No "good/bad" language.

```
security_failures_per_call
0.025 ─
0.020 ─         ●
0.015 ─   ●         ●
0.010 ─                   ●     ●
0.005 ─                               ●
      ─────────────────────────────────
      Apr 1  Apr 7  Apr 13  Apr 19  Apr 25

Period: Apr 1–Apr 25 | Audit intervals: 6h
```

No baseline is drawn. No threshold line is drawn (this is covered in PSYCHE.md; the dashboard reads reports, it does not expose PSYCHE.md directly). The chart shows what happened. The administrator decides what it means.

**Recommendation 1.3b — KPI to audit event linkage:**

Each data point on the KPI trend chart should be clickable (or, in a CLI context, selectable by index) to drill into the hansei report for that period. This makes the KPI trend a navigation surface into reports, not just a visualization.

**Recommendation 1.3c — `behavioral_change_rate` requires explanation at point of use:**

The `behavioral_change_rate` formula is not self-explanatory: "distinct code values that did not re-fire within 10 subsequent calls from the same contextId / total distinct code values fired." An administrator reading this number without context does not know whether 0.74 (the example value in the cato-spec) is high or low, or what direction is concerning.

The dashboard must include a fixed, one-time-readable explanation adjacent to this KPI's chart:

```
behavioral_change_rate: 0.74

What this measures: when the assistant is blocked for a specific reason,
does it adjust its behavior in subsequent calls? A rate of 0.74 means 74%
of block types did not re-occur within the next 10 calls from the same
context — suggesting the system or the agent adapted.

A consistently low rate (near 0) may indicate the agent is not adjusting
to blocks, which warrants investigation.
A high rate is generally expected; large swings warrant investigation.
```

This explanation is not evaluative — it does not say "0.74 is good." It gives the administrator the interpretive frame without making the calibration decision for them.

---

### 1.4 Block History View

**Data source:** `call_blocked` and `cato_block_applied` events from the audit log (audit-log-spec.md §3.2). Also `call_soft_blocked` for Supervised mode events.

**Recommended block history display structure:**

```
Block History | Group: [all ▼] | Period: [Last 30 days ▼] | Code: [all ▼]

 #    Time          Group      Code                   Action
 ─────────────────────────────────────────────────────────────────────
 4821  Apr 6 14:33  main       PROMPT_INJECTION        AGENT_PROMPT
 4820  Apr 6 14:31  work       OVERSIZED_PAYLOAD       OUTBOUND_API_CALL
 4815  Apr 5 09:12  main       PATH_TRAVERSAL          FILESYSTEM_WRITE
 ...

[Select entry to view detail]
```

**Detail view for a single block event:**

```
Block Event #4821
─────────────────────────────────────────────────────────────────────
Time:       2026-04-06 14:33:02 UTC
Group:      main
Risk code:  PROMPT_INJECTION
Action:     AGENT_PROMPT
Check ID:   3f7a2b1c-... (correlate: data/audit.db)

Cato reason: [risk class description — no payload content]

This event was reviewed as part of hansei report [2026-04-06-06:00].
Report finding: [link to finding in that report]

─────────────────────────────────────────────────────────────────────
Was this block appropriate?

  [A] Appropriate — leave threshold unchanged
  [F] False positive — flag for threshold review
  [S] Skip — decide later

Decision recorded: [none yet]
```

**Design rules for block detail:**

1. No payload content is shown. The `reason` field from Cato's response names the risk class; it does not reproduce what was in the payload. This is consistent with audit-log-spec.md §4.5 and ARCHITECTURE.md ADR-4's constraint.

2. The "Was this block appropriate?" prompt appears on every block detail view. It is the false-positive signal capture path (see §1.6). It is not optional to display — it is the mechanism by which the administrator exercises calibration judgment.

3. The prompt provides three options, not two. "Skip — decide later" is critical because forcing a binary decision on every block will lead to hasty or uninformed answers on blocks the administrator does not have enough context to evaluate yet. The Skip option records that the administrator saw the event but did not reach a conclusion.

4. The decision is recorded locally (in a dashboard state file, not in the audit log — the audit log is append-only and does not record administrator calibration decisions as events). This is the administrator's working record, separate from Cato's governance trail.

---

### 1.5 Hansei Report Inbox Display

**Data source:** `hansei_report_ready` events in the audit log; report JSON files in `data/hansei/inbox/`.

**Report inbox display:**

```
Reports
────────────────────────────────────────────────────────
  UNREVIEWED (1)

  ● 2026-04-07 06:00  Period: Apr 6 00:00 – Apr 7 00:00
    dao_score: failures 0.012 | leaks 0.003 | adaptation 0.74
    Findings: 2 anomalies (1 HIGH, 1 MEDIUM)
    Recommendations: 1 flag

  REVIEWED

  ✓ 2026-04-06 06:00  Period: Apr 5 00:00 – Apr 6 00:00  [reviewed Apr 6 08:14]
    dao_score: failures 0.009 | leaks 0.001 | adaptation 0.81
    Findings: 0 anomalies

────────────────────────────────────────────────────────
[Select report to open]
```

**Design rules for the inbox:**

1. Unreviewed reports are visually separated from reviewed reports. The visual weight goes to unreviewed (larger bullet, different marker). Reviewed reports are condensed — the administrator does not need to re-read them.

2. The dao_score values appear on the inbox summary line because they are the first triage signal. If all three KPIs are near zero and findings count is zero, the administrator knows they can review this quickly. If findings are non-zero, they know to read carefully.

3. The "reviewed" timestamp records when the administrator read and made decisions on the report, not just when they opened it. A report is marked reviewed when the administrator has made an A/F/S decision on all high-severity findings (or explicitly marked the report complete). It is not automatically marked reviewed on open.

**Report detail view structure:**

```
Hansei Report — 2026-04-07 06:00
Period: Apr 6 00:00 – Apr 7 00:00 UTC
Total calls in period: 834

dao_score
  security_failures_per_call:  0.012  (10 blocks / 834 calls)
  data_leaks_per_call:         0.003  ( 3 blocks / 834 calls)
  behavioral_change_rate:      0.74

Anomaly Findings
──────────────────────────────────────────────────────
[HIGH]   PROMPT_INJECTION — 3 occurrences in group: main
         Summary: [Cato's free-text description — risk class only]
         Affected period: Apr 6 09:00–14:00
         [View related block events]

[MEDIUM] RATE_ANOMALY — 1 occurrence in group: work
         Summary: [Cato's free-text description]
         [View related block events]

Recommendation Flags
──────────────────────────────────────────────────────
  FLAG-1: Consider reviewing the PROMPT_INJECTION threshold in PSYCHE.md
          for group: main — multiple occurrences in a short window.

          [Record decision] [View threshold change flow]

────────────────────────────────────────────────────────────────────
Report Status: UNREVIEWED
[Mark complete] [Save decisions]
```

---

### 1.6 False-Positive Signal Capture Path

ADR-3 states that the dashboard is the mechanism for capturing external calibration signals. The false-positive capture path is where those signals enter the record.

**Design principle:** false-positive flagging must be effortless but not automatic. A flag requires an administrator action; it is not inferred from behavior. A flag that is too laborious to record will be skipped; a flag that is automatic will not represent genuine administrator judgment.

**Recommended flow:**

When an administrator marks a block event as "F — False positive" in the block detail view:

```
Mark as false positive

Risk code: PROMPT_INJECTION
Block event: #4821

Optional note (50 char max): ____________________________

This flag will be saved in your calibration record.
It will not automatically adjust any threshold.
To propose a threshold change, use:
  [→ Threshold change flow]

[Confirm] [Cancel]
```

The optional note field (50 characters) is short by design. Long explanations belong in the threshold change flow, not the false-positive flag. The flag is a signal ("I think this was wrong"); the threshold change flow is where the administrator reasons about what to do about it.

The explicit statement "This flag will not automatically adjust any threshold" is mandatory. Without it, an administrator may believe that flagging blocks will fix the problem. It will not, and they need to know that before deciding whether to proceed to the threshold change flow.

---

### 1.7 Threshold Change Recommendation Flow

**Architecture constraint (ADR-3):** Threshold changes require deliberate administrator decision. They are committed to PSYCHE.md as code changes requiring a deploy cycle — not toggled at runtime.

The threshold change flow is therefore not a configuration UI. It is a **decision documentation flow** that:
1. Surfaces the evidence that suggests a threshold may need adjustment
2. Asks the administrator to articulate their reasoning
3. Produces a structured record of the decision
4. Tells the administrator what to actually do (edit PSYCHE.md)

**Recommended threshold change flow (step by step):**

```
Threshold Change Review
─────────────────────────────────────────────────────────────────────
Triggered by: 3 false-positive flags on PROMPT_INJECTION in the last 7 days

Evidence
  False positives flagged: 3
  Affected groups: main
  Block events: #4821, #4809, #4795
  Period: Apr 1–7

Cato's current threshold for PROMPT_INJECTION:
  PSYCHE.md criterion PSY-01: block_threshold_per_period = 1
  Meaning: any single confirmed block triggers a hansei finding.

Consideration
─────────────────────────────────────────────────────────────────────
Before changing a threshold, consider:
  - Were these blocks false positives (legitimate requests blocked)?
  - Or were they appropriate blocks of borderline content?
  - What is the risk of missing a genuine PROMPT_INJECTION event?

If these were false positives, raising the threshold reduces sensitivity.
This means future attempts may not be caught until they exceed the new limit.

─────────────────────────────────────────────────────────────────────
Decision

 [ ] I have reviewed the evidence and believe the threshold should change.
     My reasoning: ________________________________________________

 [ ] I have reviewed the evidence and believe the current threshold is correct.
     The false positives were edge cases; no change needed.

 [ ] I need more time. Return to this later.

─────────────────────────────────────────────────────────────────────
[Record decision]
```

After the administrator selects an option and records their decision:

If threshold change is warranted:

```
Decision recorded: PROMPT_INJECTION threshold change proposed.
Reasoning saved.

To apply this change:
  1. Open PSYCHE.md in your editor
  2. Locate: block_threshold_per_period for PSY-01
  3. Change the value from 1 to your intended value
  4. Commit the change and redeploy

The change takes effect at the next deploy. No runtime modification is possible.

Calibration record: saved to data/calibration/2026-04-07-prompt-injection.json
```

If no change:

```
Decision recorded: PROMPT_INJECTION threshold confirmed — no change.
Reasoning saved.

Calibration record: saved to data/calibration/2026-04-07-prompt-injection.json
```

**Design rules for the threshold change flow:**

1. The flow always surfaces the evidence (false-positive count, affected events, current PSYCHE.md value). The administrator is never asked to make a decision without seeing the data.

2. The flow always surfaces the risk of changing (reducing sensitivity, the possibility of future misses). It does not say "do not change" — it gives the information and lets the administrator decide.

3. The decision is recorded in a local calibration record file, separate from the audit log. This record serves the administrator's institutional memory ("why did we change this threshold in April?") and can be reviewed in the Threshold History view.

4. The flow ends with explicit instructions for what to actually do if a change is warranted. An administrator who says "yes, change the threshold" and then looks for a "Save" button will not find one — because no runtime configuration change exists. The explicit instructions prevent this confusion.

---

## 2. User Flow: Reviewing a Hansei Report → Deciding on Threshold Adjustment → Recording the Decision

This is the primary governance workflow. It maps directly to ADR-3's mandate.

---

**Step 1: Administrator is notified of a new report.**

Notification surface: TUI health panel GOVERNANCE section shows `[1 unreviewed]`. The `npm run status` output shows `Last report: 2026-04-07 06:00 [unreviewed]`. No push notification exists — the administrator checks on their schedule. This is correct per the architecture (no push channel).

**Friction point:** There is no push notification mechanism. An administrator who does not check the TUI or run `npm run status` does not know a report exists. For a solo user, this is acceptable. For an enterprise deployment, an operator may go days without checking. **Recommendation:** The `/health` endpoint (accessible via `npm run status`) should expose `pendingReportsCount` in its JSON response, so a monitoring system can alert on it: `"pendingReportsCount": 1`.

---

**Step 2: Administrator opens the dashboard and navigates to the inbox.**

```
npm run dashboard   # (or: opengolem> /dashboard in TUI)
```

The dashboard opens to the Reports view (default). The unreviewed report is highlighted.

**Friction point:** If the dashboard is a separate CLI command, the administrator switches context from whatever they were doing. If the dashboard is accessible from within the TUI (`/dashboard` command), context switching is lower. **Recommendation:** The dashboard should be accessible from the TUI as a first-class navigation action (Ctrl-G or `/dashboard`), not only as a separate binary, to reduce the activation cost for quick report checks.

---

**Step 3: Administrator reads the report.**

The administrator reads the hansei report in the dashboard's report detail view. They see the dao_score summary and two anomaly findings (1 HIGH: PROMPT_INJECTION, 1 MEDIUM: RATE_ANOMALY).

**Friction point:** The HIGH finding (3 PROMPT_INJECTION occurrences) links to related block events. The administrator clicks through to the block history and views the detail for event #4821. They read the risk class description (no payload content — this is correct and correct per architecture). They must decide whether the block was appropriate without seeing the blocked content.

**This is a fundamental UX constraint with a responsible AI dimension:** the administrator cannot see what was blocked. The audit log stores payload hashes, not payload content (by design — ADR-4). The administrator must judge appropriateness from the risk class description alone.

This constraint is intentional and correct. Exposing blocked payload content would create an injection surface. But it means that the calibration judgment is necessarily made with incomplete information. The dashboard must make this constraint explicit, not hide it.

**Recommended advisory in the block detail view:**

```
Note: Payload content is not stored. This is by design.
The risk class description above is derived from Cato's structural analysis,
not from the payload text. Your calibration judgment is based on pattern
and context, not on the specific content of the blocked request.
```

This note is not a caveat that undermines confidence — it is a transparency statement that makes the basis of the decision legible.

---

**Step 4: Administrator records decisions on each high-severity finding.**

For the PROMPT_INJECTION finding, the administrator reviews all three related block events (#4821, #4809, #4795) and marks two as "F — False positive" and one as "A — Appropriate."

**Friction point:** Moving between block events within a finding requires navigating back and forth between the finding view and the block detail view. In a CLI dashboard, this means multiple keystrokes per event. If there are ten related events, reviewing all of them is tedious.

**Recommendation:** The report finding detail view should include an inline block event list with the A/F/S decision prompt accessible without navigating away:

```
PROMPT_INJECTION — 3 occurrences
──────────────────────────────────────────────────────────────────
  #4821  Apr 6 14:33  main  [Decision: F - False positive ✓]
  #4809  Apr 6 11:20  main  [Decision: A - Appropriate ✓]
  #4795  Apr 6 09:45  main  [Decision: not yet]

  [↑/↓ navigate events] [A/F/S decide] [Enter: view detail]
──────────────────────────────────────────────────────────────────
```

This keeps all three decisions visible simultaneously and makes the decision action a single keypress.

---

**Step 5: Administrator decides whether to pursue a threshold change.**

After marking two of three PROMPT_INJECTION blocks as false positives, the dashboard shows:

```
2 false positives flagged for PROMPT_INJECTION in this report.
→ Consider threshold review  [T] to begin
```

The administrator presses T and enters the threshold change flow (§1.7).

They review the evidence, see the current PSYCHE.md threshold (PSY-01 block_threshold_per_period = 1), and read the risk consideration ("raising the threshold means future attempts may not be caught until they exceed the new limit").

They decide: yes, the threshold of 1 is too sensitive for this deployment; they want to raise it to 2.

**Friction point:** The administrator cannot apply the threshold change from the dashboard. They must open PSYCHE.md in an editor, find the specific parameter, change it, commit, and redeploy. For an enterprise operator with a deployment pipeline, this is a normal change management flow. For a solo non-expert user, this is a significant context switch with multiple manual steps.

**Recommendation:** The dashboard's threshold change completion screen should include a copy-ready PSYCHE.md snippet showing the specific line to change:

```
To apply your decision, change this line in PSYCHE.md:

  BEFORE:  block_threshold_per_period: 1   # PSY-01
  AFTER:   block_threshold_per_period: 2   # PSY-01  [raised Apr 7 — 2/3 FP in period]

(The inline comment is a suggestion; record your rationale as you prefer.)

Then commit and redeploy.
```

The suggested inline comment is a design nudge: it encourages the administrator to document their rationale at the point of change, not just in the dashboard's calibration record. This makes PSYCHE.md itself a readable history of calibration decisions.

---

**Step 6: Administrator marks the report as reviewed.**

After making A/F/S decisions on all HIGH-severity findings and completing the threshold change flow, the administrator marks the report as reviewed.

```
Mark report 2026-04-07 06:00 as reviewed?

  Decisions recorded:
    HIGH: PROMPT_INJECTION — 2 false positives, 1 appropriate [threshold change proposed]
    MEDIUM: RATE_ANOMALY — skipped (decided later)

  Incomplete: RATE_ANOMALY has no decision.
  Mark complete anyway? [Y/N]
```

The "incomplete" warning exists because "skip" is a valid decision state but should not silently mark a report as complete. The administrator must explicitly choose to mark a report complete with outstanding skipped findings. This preserves the ability to return later without losing track of what remains.

---

## 3. Friction and Ambiguity Points in the "Anomaly → Calibration Decision" Path

The following are specific points in the governance workflow where friction or ambiguity can degrade the quality of human oversight decisions. They are ordered by impact on oversight quality.

---

**F1 — No payload content limits calibration judgment (inherent constraint)**

The administrator judges calibration with risk class descriptions only, not payload content. This is correct by design. But it means that for ambiguous risk codes (e.g. PROMPT_INJECTION on a message that was legitimately asking about AI safety), the administrator has no way to confirm whether the block was accurate.

**Impact on oversight quality:** High. An administrator who cannot verify whether blocks are accurate will either trust Cato uncritically (weakening oversight) or dismiss all blocks as probably false positives (undermining safety).

**Recommendation:** The Threshold History view should track the ratio of A/F/S decisions per risk code over time. If an administrator consistently marks a particular code's blocks as false positives, this is a signal that the threshold or the symbolic rule needs re-evaluation. This is not automatic recalibration (ADR-3) — it is a trend signal that the administrator can act on.

---

**F2 — The gap between "flag as false positive" and "threshold changes" is a dead end without the flow**

A user can flag false positives without ever opening the threshold change flow. The calibration record accumulates flags, but nothing happens. There is no reminder, no escalation path, no time-bound prompt.

**Impact on oversight quality:** Medium. The governance mechanism exists but can be bypassed through inaction.

**Recommendation:** After 3 false-positive flags for the same risk code in a 30-day window, the next time the administrator opens the dashboard, the opening screen should surface: "You have flagged 3 PROMPT_INJECTION blocks as false positives this month. No threshold review has been started. → Start review [T] | Dismiss [D]." This is not a nag; it is a governance prompt that the dashboard shows once per threshold per 30-day window.

---

**F3 — `behavioral_change_rate` is unintuitive without context**

As noted in §1.3c, the behavioral_change_rate formula is not self-explanatory. But the deeper problem is that it measures system behavior, not safety behavior: whether agents adjust after blocks is an emergent property of the interaction between Cato's thresholds and the agent runtime. A low rate could mean the agent keeps attempting blocked things (concerning) or it could mean the tasks in question always involve the same operations and the block is recurring for structural reasons (not concerning at all).

**Impact on oversight quality:** Medium. An administrator who misreads `behavioral_change_rate` as "how often agents are non-compliant" may make calibration decisions based on a misunderstanding of what the metric measures.

**Recommendation:** Add a formula disclosure link next to the chart title that opens a modal explanation of the formula with concrete examples. The explanation in §1.3c (above) is the content for that modal. Do not put the formula on the chart itself — it is too technical. Put it behind a deliberate "learn more" action so it is available to administrators who want to understand it, without cluttering the view for those who have already read it.

---

**F4 — PSYCHE.md is a code file that non-expert administrators cannot safely edit**

The threshold change flow concludes with "open PSYCHE.md in your editor and change this line." PSYCHE.md is a YAML/markdown configuration file that, if malformed, could break Cato's startup. A non-expert user who introduces a YAML syntax error while changing a threshold will cause Cato to fail closed at the next restart — a significant failure mode.

**Impact on oversight quality:** High for non-expert administrators. The human oversight mechanism (threshold calibration) fails closed if the configuration file is malformed, which means the act of exercising oversight can create a failure that eliminates oversight entirely.

**Recommendation:** Two mitigations are required:

(a) The dashboard's threshold change flow should produce a validated diff — a snippet that the administrator can paste into PSYCHE.md without needing to navigate the file structure. The snippet should be valid YAML by construction. This reduces the error surface to "paste in the right place."

(b) The orchestrator's startup validation for PSYCHE.md should produce a specific, actionable error when PSYCHE.md is malformed:
```
OpenGolem: PSYCHE.md configuration is invalid (YAML parse error on line 42).
  Cato will not start until this is corrected.
  
  To restore the previous configuration:
    git diff PSYCHE.md       # see what changed
    git checkout PSYCHE.md   # restore last good version
```

This gives the administrator a recovery path when the edit goes wrong.

---

**F5 — The dashboard has no concept of "review history" per administrator**

If multiple operators share access to the system (an enterprise scenario), the dashboard's A/F/S decisions and threshold change records do not identify which administrator made them. The calibration record is an anonymous file.

**Impact on oversight quality:** Low in Phase 1 (solo use is the primary target), but becomes important for enterprise deployments where accountability for calibration decisions matters.

**Recommendation:** The calibration record files (in `data/calibration/`) should include an optional `reviewer_id` field. The dashboard should prompt for a reviewer identifier on first use (or read it from configuration). For solo deployments this can be the local username. For enterprise deployments, this becomes the accountability field for governance audits.

---

## 4. Responsible AI Framing

### 4.1 Does the Dashboard Support Human Oversight Quality?

The dashboard, as specified in this review, is designed around the following responsible AI principles. This section explicitly assesses each.

---

**Principle: Human judgment is not automated away.**

Assessment: **Supported.** The A/F/S decision on each block event requires an explicit administrator action. The threshold change flow requires an explicit administrator decision and concludes with a manual file edit and deploy. No calibration decision is inferred from behavior or applied automatically. ADR-3 (no auto-recalibration) is respected throughout the design.

Risk: the Skip option (S) allows indefinite deferral of calibration decisions. The governance prompt (Recommendation F2) partially mitigates this. Full mitigation would require a policy-level commitment from the operator to review reports on a schedule — the dashboard cannot enforce this.

---

**Principle: The basis for decisions is transparent.**

Assessment: **Partially supported, with an inherent constraint.** The evidence surfaces (false-positive count, block event list, Cato reason description, KPI trends) provide the administrator with the information Cato had. But the administrator cannot see the payload content that was blocked. The transparency advisory in the block detail view (§2, Step 3) makes this constraint explicit rather than hiding it.

Risk: an administrator who does not read the transparency advisory may believe they have more information than they actually do. The advisory should be formatted to be noticed, not easy to skip (e.g. a fixed banner, not inline text).

---

**Principle: The dashboard does not make safety decisions for the administrator.**

Assessment: **Supported.** The KPI trend charts have no evaluative coloring (no red/green zones per Recommendation 1.3a). The threshold change flow presents evidence and risk considerations but does not recommend a specific threshold value. The "Recommendation Flags" in hansei reports flag anomaly patterns but do not state what action to take. The decision belongs to the administrator at every step.

Risk: the governance prompt (Recommendation F2: "you have flagged 3 false positives, start a review?") could be read as the system urging the administrator toward a specific action. The framing is "start a review" (a process), not "raise the threshold" (a conclusion). This distinction must be preserved in the implementation.

---

**Principle: The audit trail for calibration decisions is separate from the operational audit log.**

Assessment: **Supported.** The calibration record files (`data/calibration/`) are distinct from `data/audit.db`. The operational audit log records what Cato did; the calibration record records what the administrator decided about what Cato did. These are different things and must not be conflated.

Risk: the calibration record files have no integrity protection in Phase 1. An administrator (or any process with filesystem access) can modify them. For Phase 1 this is acceptable — the audit log itself is the ground truth for what Cato did; the calibration record is the administrator's working file. In Phase 2, calibration records should be signed or stored in a tamper-evident store to support compliance audits.

---

**Principle: The dashboard surfaces safety posture implications of calibration decisions.**

Assessment: **Partially supported.** The threshold change flow presents the risk consideration ("raising the threshold means future attempts may not be caught"). The self-hosted provider safety disclosure (Security Strengthening F-7) is not currently surfaced in the dashboard.

**Recommendation 4.1 — Self-hosted safety posture disclosure:** If the system is configured with a local model (Ollama or `custom` provider), the dashboard's KPI trend view should include a persistent advisory:

```
Note: This deployment uses a self-hosted model. Cato's checks are the
only active safety filter — no upstream provider safety layer applies.
Calibration decisions have higher consequence in this configuration.
See: docs/SECURITY_STRENGTHENING.md F-7
```

This advisory is pinned, not dismissible. It is a responsible AI disclosure that must be present whenever the operator is making calibration decisions that affect the sole safety layer.

---

**Principle: The governance mechanism is not gameable by the system being governed.**

Assessment: **Supported by architecture.** The dashboard reads from the audit log (ADR-9: ground truth is the audit log, not agent self-reports). Cato writes the audit log; agents do not. The hansei reports are produced by Cato from audit log data; agents cannot influence what Cato writes. The dashboard is therefore not gameable by agents in the containers — it reflects what the enforcement layer recorded, not what agents claim.

Risk (F-3 from Security Strengthening): the audit log has no cryptographic integrity protection in Phase 1. A process with host filesystem access could modify the SQLite file directly. The dashboard's governance quality depends on the audit log being trustworthy. The dashboard should display the audit log's integrity status — in Phase 1, this is a sequence ID gap check (audit-log-spec.md §3.7); in Phase 2, it is the HMAC chain.

**Recommendation 4.2 — Audit log integrity indicator:** The dashboard should include a one-line audit log integrity status in its header:

```
Audit log: ✓ integrity check passed (2026-04-07 05:58, 4,821 events)
```

If the sequence ID gap check detects a dropped row:

```
Audit log: ⚠ integrity warning — sequence gap detected for 'broker'
  Events may be missing. See: data/audit.db inspector.
```

In Phase 1, this check is best-effort (sequence ID gap detection). It is more a reminder of the governance dependency on audit log integrity than a security guarantee. In Phase 2, the HMAC chain replaces it with a cryptographic check.

---

### 4.2 Overall Assessment

The dashboard skill as specified here supports human oversight quality under the following conditions:

1. The administrator reviews reports on a regular schedule. The dashboard cannot enforce this — it can only facilitate it by reducing the activation cost and making the unreviewed report count visible.

2. The administrator understands that calibration decisions are made with incomplete information (no payload content). The transparency advisory makes this explicit, but it requires the administrator to read it.

3. PSYCHE.md edits are made carefully. The diff snippet in the threshold change flow and the PSYCHE.md validation error at restart reduce (but do not eliminate) the risk of governance failure from malformed configuration.

4. The audit log is not tampered with. In Phase 1 this is enforced by application-layer policy; in Phase 2 it requires the HMAC chain specified in ADR-33.

The primary risk to oversight quality is not in the dashboard design — it is in the activation cost. If reviewing a hansei report takes 30 minutes and produces no actionable output on most normal runs, administrators will delay reviews or mark reports reviewed without thorough examination. The design recommendations above (inline A/F/S decisions, summarized inbox, governance prompts) are specifically aimed at reducing the per-report overhead so that thorough review remains within the practical time budget of an administrator who has other responsibilities.

---

## Summary of Recommendations

| # | Area | Recommendation | Priority |
|---|------|---------------|----------|
| 1.3a | KPI trends | Time-series only; no red/amber/green zones; no baseline or threshold lines | High |
| 1.3b | KPI drill-down | Each KPI data point links to the hansei report for that period | Medium |
| 1.3c | `behavioral_change_rate` | Fixed adjacent explanation (non-evaluative) with concrete interpretation guidance | High |
| 1.4 | Block detail | Inline A/F/S decision prompt on every block event; "Skip" is a first-class option | High |
| 1.5 | Report inbox | Unreviewed/reviewed visual separation; "mark complete" requires explicit action; dao_score on summary line | High |
| 1.6 | False-positive flag | Flag confirmation explicitly states "will not automatically adjust threshold" | High |
| 1.7 | Threshold change | Flow produces copy-ready PSYCHE.md diff snippet; risk consideration is mandatory display | High |
| 2 | Notification | Health endpoint exposes `pendingReportsCount` for external monitoring integration | Medium |
| 2 | Dashboard access | `/dashboard` accessible from TUI as first-class navigation (Ctrl-G or command) | Medium |
| F1 | Calibration trend | A/F/S decision ratio per risk code tracked in Threshold History view | Medium |
| F2 | Governance prompt | After 3 FP flags for same code in 30 days, dashboard surfaces one-time review prompt | Medium |
| F3 | `behavioral_change_rate` | Formula explanation behind deliberate "learn more" action, not on chart | Medium |
| F4a | PSYCHE.md edit safety | Threshold change flow produces validated YAML snippet; reduce edit-error surface | High |
| F4b | PSYCHE.md validation | Startup error for malformed PSYCHE.md with `git checkout` recovery instruction | High |
| F5 | Multi-operator support | Optional `reviewer_id` in calibration records; read from config or prompted on first use | Low |
| 4.1 | Self-hosted disclosure | Persistent (non-dismissible) advisory in KPI view when using local model provider | High |
| 4.2 | Audit log integrity | One-line integrity status in dashboard header; sequence ID gap check in Phase 1 | Medium |

---

## Open Questions for PM

1. **Dashboard implementation form:** Is the dashboard a separate CLI binary (`npm run dashboard`), a skill accessible from the TUI (`/dashboard`), or both? The recommendation is both (separate binary for standalone access, TUI command for in-context access), but this has implementation cost implications.

2. **Calibration record storage:** The `data/calibration/` directory is proposed as the store for A/F/S decisions and threshold change records. This is separate from `data/audit.db`. Should calibration records eventually be included in the audit log as a distinct event type (`admin_calibration_decision`), or kept separate? Including them in the audit log would make them tamper-evident but changes the audit log's scope from "what the enforcement layer did" to "what the administrator decided about what the enforcement layer did."

3. **Governance prompt frequency:** The recommendation is one governance prompt per risk code per 30-day window after 3 false-positive flags. Is 3 flags the right threshold, and is 30 days the right window? These are deployment policy questions as much as UX questions.

4. **PSYCHE.md edit assistance:** The validated YAML snippet in the threshold change flow assumes the dashboard knows the structure of PSYCHE.md. This requires the dashboard skill to include a PSYCHE.md schema parser. Is this within scope for M5, or should the snippet be a plain-text "here is the line to change" rather than a validated diff?

5. **Multi-group governance:** All the above assumes a single administrator reviewing all groups. If different administrators are responsible for different groups, the dashboard needs a per-group filter on the inbox and a per-group A/F/S record. Is this a M5 requirement or a future enhancement?

---

*Produced: 2026-04-07 | Awaiting PM approval*
