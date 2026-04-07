# UX Review: Dashboard Skill — M5

**Date:** 2026-04-07
**Milestone:** M5 — UX Review: Report Dashboard Skill
**Author:** UX/Interaction Designer
**Inputs:** ARCHITECTURE.md §5.4, ADR-3, ADR-4, ADR-9; cato-spec.md §2.2; audit-log-spec.md §3.2; DECISIONS.md Decision 3, Decision 29

---

## Executive Summary

The dashboard skill is the sole mechanism by which the administrator exercises the judgment that ADR-3 preserves for humans. If the dashboard fails — if it overwhelms, misleads, or under-informs — the human oversight that the architecture depends on becomes nominal rather than real.

The overall assessment is that the dashboard is achievable and valuable, but carries three structural risks that must be designed against deliberately:

1. **KPI legibility failure.** The three dao_score metrics are technically coherent but non-intuitive to a non-expert. Without careful presentation, a high `behavioral_change_rate` reads as good news (agents are changing!) when it may signal low-quality blocks (agents stop triggering a check after one exposure — possibly because the check is too broad). Presenting numbers without interpretive context trains the administrator to watch the dashboard without understanding it.

2. **Automation seduction.** A dashboard that surfaces anomalies and then offers a "suggest threshold change" affordance — even labeled clearly as a suggestion — nudges the administrator toward rubber-stamping. The UX must make the deliberate decision feel deliberate, not like clicking "accept recommendation."

3. **False-positive capture is the system's external calibration signal.** ADR-3 explains precisely why the system cannot recalibrate itself: the only reliable signal comes from outside the loop. The false-positive capture path is therefore not a convenience feature — it is architecturally load-bearing. It must be visible, fast, and treated as a first-class citizen, not buried in a detail view.

The dashboard design proposed in this review supports genuine human oversight provided the recommendations below are followed. It is not a passive reporting surface. It is the interface through which the administrator keeps the system honest.

---

## Information Architecture

The dashboard operates in a CLI/TUI environment. The administrator encounters it either proactively (scheduled review) or reactively (something flagged in logs, a user reported a block). Both entry points must land the administrator in the same coherent hierarchy.

### Hierarchy and Rationale

```
Dashboard (top-level view)
├── 1. System Health Banner         [always visible, one line]
├── 2. Unread Hansei Reports        [count + age of oldest unread]
├── 3. KPI Summary Panel            [current-period values, trend arrows]
│   ├── security_failures_per_call
│   ├── data_leaks_per_call
│   └── behavioral_change_rate
├── 4. Recent Blocks                [last N cato_block_applied events, expandable]
├── 5. False-Positive Inbox         [pending administrator review items]
└── 6. Threshold Change Log         [decisions already recorded; read-only history]
```

**Rationale for this order:**

The health banner is not a KPI — it is a system-status signal: "Cato is running", "audit log is healthy", "last hansei report was N hours ago." It answers "is the system working?" before the administrator reads anything governance-related. If the system is unhealthy, the KPI data is unreliable and the administrator needs to know that first.

Unread hansei reports are surfaced second because they are the unit of governance work. A report represents Cato's completed analysis of a period. The administrator's job is to read it and make a decision, or consciously defer it. Leaving it unread is a decision — the dashboard should make that choice visible.

The KPI summary panel comes third, not first. KPIs are trend signals, not action items. An administrator who opens the dashboard and sees a KPI number without context (what changed? what triggered this?) is likely to misinterpret it. The KPI panel exists to answer the question raised by a hansei report: "how does this period compare to previous ones?" It is context for a decision already in progress, not the starting point.

Recent blocks and the false-positive inbox follow because they are the raw material for calibration decisions. A block history view is only useful after the administrator has understood the KPI trend. The false-positive inbox surfaces items where a user (or the administrator) has flagged that a block may have been wrong — these are the highest-value calibration signals in the system.

The threshold change log is last and read-only. It closes the loop: "here are the decisions I have already made." It is a record, not an action surface.

### Screen budget

At any given moment, the TUI should fit the top three sections on a standard 80x24 terminal without scrolling. The administrator should be able to assess system health and pending work in a single screenful. Detail views (full hansei report, block audit trail, decision recording form) are subordinate screens, not part of the primary view.

---

## KPI Presentation Recommendations

### The legibility problem

The three KPIs require interpretation. They are not self-evident:

- `security_failures_per_call = 0.012` — Is that good or bad? Compared to what? What is the threshold that would concern Cato?
- `data_leaks_per_call = 0.003` — A very low number sounds reassuring. But if total calls are 40 in a quiet week, 0.003 means one event, which may be highly significant.
- `behavioral_change_rate = 0.74` — This is particularly counterintuitive. A high rate means agents are exposed to many distinct block codes that do not re-fire within 10 subsequent calls. This can mean the blocks are working (agents adjust) OR that the checks are too noisy (agents trigger one check, don't repeat the specific behavior that triggered it, but trigger new checks instead). A non-expert reading 74% will not know which interpretation applies.

### Recommendations for each KPI

**security_failures_per_call** — Display as a rate with two reference points: (a) the current PSYCHE.md `block_threshold_per_period` that would trigger a hansei anomaly finding for the most relevant PSY-nn criterion, and (b) the same-period rate from the previous two audit cycles. Trend arrows (up/down/flat) should be colored contextually: up is amber if the rate is approaching a threshold, red if it crosses one, green if it is declining from an elevated prior period. Never color a number green simply because it is low — a rate that has been low for six periods is just steady state.

**data_leaks_per_call** — Always display alongside the absolute count, not just the rate. `0.003 (2 events in 667 calls)` is dramatically different from `0.003 (1 event in 333 calls)`. Small absolute numbers matter here: MEMORY_SCOPE_VIOLATION is a high-signal event, not noise. If the absolute count is nonzero, surface the relevant block records directly below the KPI rather than requiring navigation to the block history.

**behavioral_change_rate** — This KPI requires the most interpretive scaffolding. Display it with a plain-language label instead of the raw field name: "Agent Adaptation Rate" is misleading; "Distinct block codes that did not recur" is accurate but dense. Recommended label: "Block pattern variation". Include a one-sentence explanation in the detail view: "This measures whether agents encounter a different set of block triggers each period. A high value may mean agents are adapting, or may mean the system is blocking many different things inconsistently. Compare with `security_failures_per_call` to distinguish."

### Absolute rule: never display a KPI in isolation from its trend

A single-period value is close to meaningless for calibration decisions. The KPI panel must always show the current value alongside the previous period's value and a directional indicator. If only one period of data exists, show the value with a label "First period — no trend available."

### Avoid traffic-light oversimplification

Do not reduce KPIs to red/yellow/green status indicators without preserving access to the underlying values. A red indicator triggers defensive action; a green indicator suppresses attention. The administrator's judgment depends on understanding the texture of the data, not on whether it crossed an arbitrary threshold. Traffic-light affordances may be used as secondary signals (e.g., a color border on a KPI card) but must never replace the numeric display.

---

## Calibration Decision Flow

This section traces the path from "I see a KPI anomaly" to "I have recorded a threshold change decision." Each step is annotated for friction (where the design must keep the administrator engaged) and risk (where the design could undermine the quality of the decision).

### Step 0: Entry — Anomaly Detection

**Trigger:** The administrator notices an elevated KPI value, or receives a notification that a new hansei report is available.

**Friction note:** The administrator is not monitoring the dashboard continuously. The dashboard must be usable reactively, not just in a dedicated review session. The system health banner should include "N unread hansei reports" as a persistent status line visible in any group's TUI output — so the administrator can spot a pending report without opening the dashboard.

**Risk:** If the notification is too noisy, the administrator will habituate and stop reading reports. If it is too sparse, reports will accumulate unread. The default notification posture should be "one notification per new hansei report, surfaced once, not repeated."

---

### Step 1: Open the Hansei Report

**Action:** `dashboard report <report-id>` or selecting a report from the unread queue in the TUI.

**What the administrator sees:**
- Period covered (start/end timestamps, human-readable: "Audit period: Monday 00:00 – Monday 08:00 UTC")
- Total calls in period (absolute number, not normalized)
- KPI values for the period, with comparison to previous period
- Anomaly findings (list, sorted by severity: high → low → info)
- Each finding: severity label, affected criterion ID (PSY-nn), risk class description, block count for the period, and threshold that was exceeded

**What the administrator does not see:**
- Raw payload content (by design — ADR-4 constraint: payload is not reproduced in reason fields)
- Specific user identities (sender identity is hashed in the audit log)
- Specific message text

**Friction note:** The absence of payload content is an intentional security constraint. The dashboard must explain this absence explicitly in the UI, not silently omit it. A note such as "Payload content is not shown to prevent injection of blocked content into the review interface" prevents the administrator from assuming the data is missing due to a bug.

**Risk:** A finding that names "PSY-02: Multi-turn prompt injection pattern" tells an expert something meaningful. A non-expert may not know what PSY-02 means. Each criterion ID must be displayed alongside its plain-language description from PSYCHE.md. The administrator must be able to understand what was blocked without consulting external documentation.

---

### Step 2: Examine the Block History for the Finding

**Action:** From a finding, select "View blocks for this finding" (or equivalent keybinding).

**What the administrator sees:**
- Chronologically ordered list of `cato_block_applied` events matching the finding's criterion
- Each block: timestamp, action type (AGENT_PROMPT / MEMORY_WRITE / etc.), context ID (anonymized), risk code, reason (risk class — not payload)
- Whether each block has an associated false-positive flag from a user or prior administrator review

**Friction note:** This is where the administrator makes the substantive judgment: "Do these blocks look correct, or does the pattern suggest the threshold is too tight?" The UI should not rush this step. A "continue to recommendation" button at this point is the primary automation-seduction risk — it implies the administrator should move on before they are ready.

**Risk:** Without payload content, the administrator is evaluating blocks by their metadata (action type, risk class, timing). This is intentional but limited. The administrator may not be able to determine whether a block was correct based on metadata alone. The dashboard must surface the path to the false-positive capture flow from this view, because the most valuable calibration signal is whether users reported that specific blocks felt wrong to them.

---

### Step 3: Review False-Positive Signals for the Relevant Criterion

**Action:** Filter the false-positive inbox to the criterion ID being reviewed. This step may be done concurrently with Step 2 or after it.

**What the administrator sees:**
- False-positive records associated with this criterion: the `check_id` of the block, the group ID (if disclosed), and the administrator's or user's signal text ("this block was wrong because...")
- Whether the false positive was previously reviewed and marked resolved

**Friction note:** If there are no false-positive signals, the administrator should see that clearly — "No false-positive reports for PSY-02 in this period" — not an empty list that could be confused with "I haven't loaded the data."

---

### Step 4: Form a Calibration Judgment

**Action:** The administrator decides one of:

a) **No change.** The blocks appear correct; thresholds are appropriate.
b) **Threshold adjustment warranted.** Too many false positives, or the rate is much lower than expected, suggesting the threshold is set too conservatively.
c) **Criterion review warranted.** The blocks suggest the criterion definition in PSYCHE.md is ambiguous or overly broad.
d) **Defer.** Insufficient data this period; wait for the next audit cycle.

**What the dashboard provides:** A decision recording form with the following fields:
- Decision type: `no_change` | `threshold_adjust` | `criterion_review` | `defer`
- For `threshold_adjust`: current `block_threshold_per_period` value, proposed new value, and a free-text rationale field (mandatory)
- For `criterion_review`: free-text description of the observed problem (mandatory)
- For `defer`: expected review date (optional, but prompted)

**Friction note — this is the most critical UX moment.** The form must not pre-populate a suggested threshold value. Pre-population implies the system has a recommendation and the administrator is accepting or rejecting it. The administrator must reason to a value from the evidence they have reviewed. If they cannot arrive at a value, that is diagnostic: the evidence base (the hansei report) may be insufficient, in which case "defer" is the correct choice.

**Risk:** A mandatory rationale field is friction — and that friction is intentional. The decision is consequential. An administrator who cannot write two sentences explaining their rationale is an administrator who has not made a considered decision. The dashboard should make this expectation explicit: "This decision will be recorded and used to track calibration changes over time. The rationale is required and will be visible in the threshold change log."

---

### Step 5: Record the Decision

**Action:** The administrator submits the decision form.

**What happens:**
- The decision is written to a local decisions log (e.g., `data/calibration-decisions/`), in an append-only JSON format similar to the audit log schema
- The dashboard displays a confirmation summary: "Decision recorded: no_change for PSY-02. Rationale: [first 100 chars]. This does not change PSYCHE.md."
- The report is marked as read and the decision reference is linked to the report ID

**What does not happen:**
- PSYCHE.md is not modified automatically
- No threshold value changes in the running system
- No Cato reconfiguration occurs

**For `threshold_adjust` decisions specifically:** The dashboard generates a diff preview showing the proposed change to PSYCHE.md in the exact edit required. It does not apply the edit. It displays: "To apply this change, edit PSYCHE.md and redeploy. The proposed edit is shown below." The administrator copies, applies, commits, and deploys — deliberately. The multiple-step requirement is not a bug; it is the mechanism that makes threshold changes feel consequential.

**Risk:** If the multi-step process to apply a threshold change feels bureaucratic without explanation, administrators will skip the decision recording step entirely and just edit PSYCHE.md directly. The dashboard must explain why the separation matters: "Recording your decision separately from the edit creates an auditable calibration history. It lets you compare threshold values to the evidence that justified them, months later."

---

### Step 6: Close the Loop — Mark Report Reviewed

**Action:** The administrator marks the hansei report as reviewed (whether or not they recorded a calibration decision).

**What happens:** The report moves from "unread" to "reviewed" in the dashboard queue. The review event is written to the calibration decisions log.

**Friction note:** An administrator who reads a report and takes no action should still mark it reviewed. An unread report is a different state from "read, no action needed." The dashboard must enforce this distinction by not allowing a report to silently age off the unread queue.

---

## Hansei Report Inbox UX

### What metadata is essential

For each report in the inbox list:

| Field | Display format | Why essential |
|---|---|---|
| Report ID | Short (first 8 chars of UUID) | Reference for decision linking |
| Period covered | Human-readable date range | Establishes temporal context |
| Age | "3 hours ago" / "2 days ago" | Signals urgency — old unread reports are a governance gap |
| KPI delta vs. prior period | Up/down/flat for each of three KPIs | Answers "is this worth reading now?" |
| Anomaly count by severity | "2 high, 1 medium" | Summary of work to be done |
| Read status | Unread / Read-no-action / Reviewed-decision-recorded | Full state, not just binary |

### What is noise

- Full JSON report content in the list view — belongs in the detail view only
- Raw KPI values in the list view — delta and anomaly count are sufficient; exact values belong in the detail view
- Technical metadata (run ID, path hash) — belongs in the detail view for auditability, not in the inbox list
- Cato audit run timestamps — the period covered is more useful than when Cato ran

### Report expiry and retention

Reports should never automatically disappear from the inbox. "Unread" reports that are not acted upon should remain visible and accumulate an age indicator. The administrator must actively choose to archive or dismiss a report. Automatic aging-off creates a mechanism to ignore governance work without a visible record of having done so.

### Ordering

Default sort: newest report at the top. Unread reports surfaced before read-no-action, which are surfaced before reviewed. Within each status group, newest first. The administrator should always see their highest-priority work at the top.

---

## False-Positive Capture Path

### What a false positive is in this context

A false positive is any instance where Cato blocked an action that the administrator, upon review, determines was not a genuine risk. The signals that constitute a false-positive report are:

1. A user tells the administrator "the agent said [BLOCKED] but I don't know why, and it seems wrong"
2. The administrator reviews a block in the dashboard and judges it was triggered incorrectly
3. A pattern in the block history suggests the criterion is firing on legitimate use cases

### The capture interface

The false-positive capture path must be accessible from three points:

- From the block history view: a "Flag as false positive" action on any individual `cato_block_applied` event
- From the hansei report's anomaly finding detail: a "Flag finding for review" action that applies to all blocks associated with a criterion in the report period
- From a direct command: `dashboard flag-block <check-id>` for administrators who are relaying a user report

Each capture action prompts for:
- **Classification** (required): `user-reported` | `administrator-reviewed` | `pattern-observed`
- **Description** (required): free text, minimum 10 characters — "this seems wrong" is not sufficient; the prompt should ask "what should have happened?"
- **Confidence** (required): `definite` | `probable` | `uncertain` — an uncertain flag is still valuable; it signals "I want to revisit this"

### What happens after capture

False-positive records are stored locally and linked by `check_id` to the underlying `cato_block_applied` audit event. They are surfaced in:
- The false-positive inbox panel on the dashboard
- The block history detail view for any block that has been flagged
- The calibration decision form when the administrator is making a threshold adjustment

False-positive records are never automatically acted upon. They are inputs to human judgment.

### Visibility is the mechanism

The effectiveness of the false-positive capture path depends on the administrator knowing it exists and trusting that flagging a block will have an effect. The dashboard must:
- Show a running count of unreviewed false-positive flags in the system health banner
- Surface the most recent unflagged false-positive signals prominently in the dashboard summary
- Confirm after each capture: "Flag recorded. This will appear in your next calibration review."

---

## Responsible AI Assessment

### The question

Does the proposed dashboard structure support genuine human oversight, or does it create the appearance of oversight without the substance?

### Assessment

The architecture as designed is structurally sound for genuine oversight, but the dashboard UX is capable of either enabling or undermining that soundness depending on specific implementation choices. The assessment below evaluates each dimension.

**Strengths of the proposed structure:**

The dashboard correctly positions the administrator as the decision-maker, not a reviewer of system recommendations. ADR-3's rationale — that a system optimizing against its own safety metrics will drift toward proxy optimization — is directly reflected in the decision recording flow: the system does not pre-populate a suggested threshold value, and the administrator must arrive at one through their own reasoning. This is a meaningful design constraint, not cosmetic.

The false-positive capture path is architecturally load-bearing, not a convenience feature. The design proposed here makes this explicit. The administrator who uses the false-positive path correctly is providing the external calibration signal that the system cannot generate for itself. If this path is buried, the oversight loop is broken — the administrator can approve of a system that is producing more and more false positives without any mechanism to register that judgment.

The mandatory rationale field for calibration decisions is a substantive safeguard. It prevents rubber-stamping. It also creates an auditable history that future administrators (or the same administrator, six months later) can consult to understand why a threshold was set where it is.

**Risks that the dashboard design must actively resist:**

*Risk 1: Status indicators replace reasoning.* If the dashboard uses traffic-light status indicators without preserving access to underlying values and trends, the administrator's effective decision-making surface collapses to three colored dots. An administrator who can report "everything is green" but cannot explain what that means has nominal oversight, not genuine oversight.

*Risk 2: The confirmation prompt is too short.* If the time between opening a hansei report and recording a decision is 90 seconds, something has gone wrong. A hansei report for a period with high anomaly activity may require 15-30 minutes of review. The dashboard must not be designed for speed. There should be no loading indicator, no progress bar, nothing that communicates "finish reviewing this quickly." The UX of the review flow should be calm and linear.

*Risk 3: Unread reports accumulate without consequence.* If reports can age silently, the administrator can maintain the appearance of oversight by not acknowledging reports. The system health banner should surface the age of the oldest unread hansei report as a persistent signal. After a configurable period (default: 7 days), an unread report should produce a warning-level alert, not as blame but as a prompt: "Report from 8 days ago has not been reviewed."

*Risk 4: The PSYCHE.md edit is the accountability gap.* The dashboard records the decision; the administrator makes the edit; the edit is committed to version control. But if the edit is never made (the administrator records a `threshold_adjust` decision and then does not update PSYCHE.md), the system drifts: the calibration history says one thing, the running configuration says another. The dashboard should surface open `threshold_adjust` decisions that have not been followed by a PSYCHE.md redeploy (detected by checking whether the running threshold matches the last recorded decision). This closes the accountability gap.

**Net verdict:** The proposed design supports genuine oversight if and only if the recommendations below are implemented. The four risks above are not theoretical — they are predictable failure modes for a non-expert administrator using a governance dashboard. The design must engineer against each of them deliberately.

---

## Recommendations

**R-1: Display absolute call counts alongside KPI rates.**
`data_leaks_per_call = 0.003 (2 events in 667 calls)` communicates meaningfully. `data_leaks_per_call = 0.003` does not. Implement this for all three KPIs in both the summary panel and the detail view.

**R-2: Provide plain-language descriptions for all criterion IDs.**
Every PSY-nn criterion referenced in the dashboard must be displayed with its plain-language description from PSYCHE.md. Do not require the administrator to consult PSYCHE.md separately during a review session. Cache criterion descriptions at dashboard startup.

**R-3: Explain the absence of payload content explicitly in the UI.**
Do not silently omit payload content. Display a note at the block detail level: "Payload content is not shown — this prevents blocked content from being injected into the review interface." One sentence is sufficient; absence without explanation looks like a bug.

**R-4: Never pre-populate a suggested threshold value in the calibration decision form.**
The administrator must reason to a value. Pre-population implies the system has a recommendation. If the administrator cannot arrive at a value, the correct action is `defer`, not accepting a system-suggested number.

**R-5: Make the rationale field mandatory and set a minimum quality floor.**
Minimum 20 characters, with a prompt ("What evidence supports this decision?") rather than a generic "Add notes" placeholder. Surface the rationale in the threshold change log to make the quality of past decisions visible.

**R-6: Surface the age of the oldest unread hansei report in the system health banner.**
This should be a persistent one-line indicator visible without opening the dashboard. Example: "1 hansei report unread — oldest: 3d ago". After 7 days, escalate to a warning.

**R-7: Surface open threshold_adjust decisions not yet applied to PSYCHE.md.**
Compare recorded decisions to the running configuration. If a `threshold_adjust` decision was recorded more than N days ago (default: 3 days) and the corresponding PSYCHE.md value has not changed, surface this as an open item: "Calibration decision from 2026-04-03 has not been applied to PSYCHE.md."

**R-8: The false-positive capture path must be reachable in three keystrokes from the block history view.**
It should not require navigating to a separate section and re-entering context. From a block detail view: one key to open the flag form, one key to select classification, one key to submit (after typing rationale). Test this with a user who has never used the dashboard before.

**R-9: Do not use red/green status colors as the primary encoding for KPI health.**
Use them as secondary signals only. The primary display must be the numeric value with context. An administrator who can see "KPI is green" but not explain what it means has not exercised oversight.

**R-10: Design the calibration decision flow for calm review, not fast completion.**
Remove any UX affordances that suggest the administrator should move through the flow quickly (progress bars, "next step" prompts, auto-advance on timeout). The review session is a judgment activity. The interface should not communicate impatience.

**R-11: Generate a PSYCHE.md diff preview for threshold_adjust decisions, but never auto-apply it.**
After the administrator records a `threshold_adjust` decision, display the exact edit required in PSYCHE.md in a diff format. Include the command they would run to verify the change. Do not apply the edit. The separation between recording a decision and applying a threshold change is load-bearing — it is the mechanism by which threshold changes require a deployment, not a runtime toggle.

**R-12: Add a `dashboard report-summary` command for non-interactive contexts.**
For administrators who access the system over restricted channels (e.g., a low-bandwidth SSH session), provide a one-command summary: report count, oldest unread age, current-period KPI direction, and a count of unreviewed false-positive flags. This enables lightweight monitoring without requiring a full TUI session.
