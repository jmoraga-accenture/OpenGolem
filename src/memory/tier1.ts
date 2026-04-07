/**
 * Tier 1 — Operational Memory
 *
 * Manages per-group CLAUDE.md files on the host filesystem.
 * Source of truth: docs/specs/memory-tiers-spec.md
 *
 * Rules:
 * - Write only after Cato inline check returns { allow: true }
 * - Auto-create empty CLAUDE.md on missing (no Cato check needed for empty creation)
 * - No cross-group path exposure: mount set for group A never includes group B paths
 * - CLAUDE.md persists across session boundaries (no deletion on session end)
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatoCheck = (params: {
  action: string;
  groupName: string;
  payloadHash?: string;
}) => Promise<{ allow: boolean; reason?: string; checkId?: string }>;

export interface WriteResult {
  status: 'written' | 'rejected' | 'socket_unreachable';
  checkId?: string;
  reason?: string;
  error?: string;
}

export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

// ---------------------------------------------------------------------------
// Internal state — last write result (for test observability)
// ---------------------------------------------------------------------------

let _lastWriteResult: WriteResult = { status: 'written' };

export function getLastWriteResult(): WriteResult {
  return _lastWriteResult;
}

// ---------------------------------------------------------------------------
// getMountsForGroup
//
// Returns the bind-mount set for a container spawned for the given group.
// The set includes only paths scoped to the named group — never another group.
// ---------------------------------------------------------------------------

export function getMountsForGroup(
  groupName: string,
  groupsDir: string,
): Mount[] {
  const groupDir = path.resolve(groupsDir, groupName);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');

  return [
    {
      hostPath: claudeMdPath,
      containerPath: '/workspace/group/CLAUDE.md',
      readOnly: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ensureClaudeMd
//
// Auto-creates an empty CLAUDE.md for the group if it does not exist.
// No Cato check is required — empty file creation carries no content risk.
// If the file already exists, it is left untouched.
// ---------------------------------------------------------------------------

export function ensureClaudeMd(params: {
  groupName: string;
  groupsDir: string;
  catoCheck?: CatoCheck;
}): void {
  const { groupName, groupsDir } = params;
  const groupDir = path.resolve(groupsDir, groupName);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');

  if (!fs.existsSync(claudeMdPath)) {
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(claudeMdPath, '', 'utf-8');
    // No catoCheck call — empty file creation requires no approval
  }
  // If file exists, leave it unchanged
}

// ---------------------------------------------------------------------------
// applyMemoryWriteProposal
//
// Submits a MEMORY_WRITE Cato inline check for the proposed new content.
// Writes to CLAUDE.md only if Cato returns { allow: true }.
// Fails closed on socket errors — file is never modified without approval.
// ---------------------------------------------------------------------------

export async function applyMemoryWriteProposal(params: {
  groupName: string;
  groupsDir: string;
  proposedContent: string;
  catoCheck: CatoCheck;
}): Promise<WriteResult> {
  const { groupName, groupsDir, proposedContent, catoCheck } = params;
  const groupDir = path.resolve(groupsDir, groupName);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');

  // Compute a simple payload descriptor (hash not required by spec for Phase 1)
  const payloadHash = Buffer.from(proposedContent).toString('base64');

  let catoResponse: { allow: boolean; reason?: string; checkId?: string };

  try {
    catoResponse = await catoCheck({
      action: 'MEMORY_WRITE',
      groupName,
      payloadHash,
    });
  } catch (err) {
    // Fail closed: socket unreachable or any error
    const result: WriteResult = {
      status: 'socket_unreachable',
      error: err instanceof Error ? err.message : String(err),
    };
    _lastWriteResult = result;
    return result;
  }

  if (!catoResponse.allow) {
    const result: WriteResult = {
      status: 'rejected',
      checkId: catoResponse.checkId,
      reason: catoResponse.reason,
    };
    _lastWriteResult = result;
    return result;
  }

  // Approved — write the file
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(claudeMdPath, proposedContent, 'utf-8');

  const result: WriteResult = {
    status: 'written',
    checkId: catoResponse.checkId,
  };
  _lastWriteResult = result;
  return result;
}

// ---------------------------------------------------------------------------
// onSessionEnd
//
// Called when a session ends. CLAUDE.md is intentionally NOT deleted.
// Tier 1 memory persists across session boundaries (T1-5).
// ---------------------------------------------------------------------------

export function onSessionEnd(params: {
  groupName: string;
  groupsDir: string;
}): void {
  // No-op: CLAUDE.md is persistent by design.
  // This function exists to make the lifecycle contract explicit and testable.
  void params;
}
