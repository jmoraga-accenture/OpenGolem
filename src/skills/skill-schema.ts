/**
 * Skill Schema and Lifecycle
 *
 * Source of truth: docs/specs/skill-schema-spec.md
 *
 * Responsibilities:
 *   - Parse and validate .intent.md declarations
 *   - Apply/remove skills from the in-memory registry
 *   - Notify the Token Broker via JSON-RPC on the broker socket
 */

import fs from 'fs';
import net from 'net';
import path from 'path';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NetworkEndpoint {
  pattern: string;
  protocol: 'https' | 'wss';
  direction: 'outbound';
}

export interface McpServer {
  id: string;
  url: string;
  scopes: string[];
  min_permission_tier: 'viewer' | 'member' | 'owner' | 'admin';
}

export interface InstalledSkill {
  skillId: string;
  version: string;
  type: 'feature' | 'utility' | 'container';
  description: string;
  tokenScopes: string[];
  networkEndpoints: NetworkEndpoint[];
  mcpServers: McpServer[];
  applyPermission: 'admin' | 'power_user';
  /** Internal: broker socket path used at registration time. Used for per-context re-registration. */
  _registeredWith?: string | null;
}

export type SkillApplyResult =
  | { ok: true; skillId: string; version: string; warnings?: string[] }
  | { ok: false; field?: string; reason: string };

export type SkillRemoveResult =
  | { ok: true; skillId: string }
  | { ok: false; reason: string };

export interface SkillApplyOptions {
  /** Path to the broker Unix socket. null = skip broker I/O (unit test mode). */
  brokerSocketPath: string | null;
}

// ---------------------------------------------------------------------------
// Internal state (module-level in-memory registry)
// ---------------------------------------------------------------------------

const installedSkills = new Map<string, InstalledSkill>();

// ---------------------------------------------------------------------------
// Permitted mount roots for filesystem.container_mounts[].host_path
// These are the only directories from which skills may declare container mounts.
// ---------------------------------------------------------------------------
const PERMITTED_MOUNT_ROOTS = [
  process.env.HOME ?? '/home',
  '/tmp',
  '/var/lib/opengolem',
  '/workspace',
];

// ---------------------------------------------------------------------------
// YAML frontmatter parser (dependency-free)
// Extracts the content between the first --- and the second --- markers.
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const closeIdx = lines.slice(1).findIndex((l) => l.trim() === '---');
  if (closeIdx === -1) return null;
  const yamlBody = lines.slice(1, closeIdx + 1).join('\n');
  return parseYaml(yamlBody);
}

/**
 * Minimal YAML parser sufficient for .intent.md files.
 * Handles: strings, numbers, lists (- item), nested maps (key: value, indented).
 */
function parseYaml(text: string): Record<string, unknown> {
  // We need a proper YAML parser for nested structures.
  // Since no yaml dependency is available, implement a recursive descent parser.
  return parseYamlBlock(text.split('\n'), 0, 0).value as Record<
    string,
    unknown
  >;
}

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function parseYamlBlock(
  lines: string[],
  startLine: number,
  baseIndent: number,
): ParseResult {
  const result: Record<string, unknown> = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Skip empty lines and comments
    if (trimmed.trim() === '' || trimmed.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = trimmed.length - trimmed.trimStart().length;

    // If we've dedented past our base, return
    if (indent < baseIndent) {
      break;
    }

    // If we've indented more than base, skip (will be handled by recursive calls)
    if (indent > baseIndent) {
      i++;
      continue;
    }

    const lineContent = trimmed.trimStart();

    // Check if this is a list item
    if (lineContent.startsWith('- ')) {
      // This is a list at this level - shouldn't happen here (handled by parseList)
      break;
    }
    if (lineContent === '-') {
      break;
    }

    // Key: value
    const colonIdx = lineContent.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = lineContent.slice(0, colonIdx).trim();
    const rest = lineContent.slice(colonIdx + 1).trimStart();

    if (rest === '' || rest === '\r') {
      // Look ahead: next non-empty line determines if this is a map or list
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;

      if (j < lines.length) {
        const nextLine = lines[j];
        const nextIndent = nextLine.length - nextLine.trimStart().length;
        const nextContent = nextLine.trimStart();

        if (nextIndent > baseIndent && nextContent.startsWith('- ')) {
          // It's a list
          const listResult = parseYamlList(lines, j, nextIndent);
          result[key] = listResult.value;
          i = listResult.nextLine;
        } else if (nextIndent > baseIndent) {
          // It's a nested map
          const mapResult = parseYamlBlock(lines, j, nextIndent);
          result[key] = mapResult.value;
          i = mapResult.nextLine;
        } else {
          result[key] = null;
          i = j;
        }
      } else {
        result[key] = null;
        i = j;
      }
    } else {
      // Inline value
      result[key] = parseScalar(rest.trim());
      i++;
    }
  }

  return { value: result, nextLine: i };
}

function parseYamlList(
  lines: string[],
  startLine: number,
  baseIndent: number,
): ParseResult {
  const items: unknown[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    if (trimmed.trim() === '' || trimmed.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = trimmed.length - trimmed.trimStart().length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      i++;
      continue;
    }

    const lineContent = trimmed.trimStart();

    if (lineContent.startsWith('- ')) {
      const itemContent = lineContent.slice(2).trim();
      if (itemContent === '' || itemContent === '\r') {
        // Complex item (map): look ahead
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length) {
          const nextLine = lines[j];
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          if (nextIndent > baseIndent) {
            const mapResult = parseYamlBlock(lines, j, nextIndent);
            items.push(mapResult.value);
            i = mapResult.nextLine;
            continue;
          }
        }
        items.push(null);
        i++;
      } else if (itemContent.includes(':')) {
        // Inline map in list item: "- key: value"
        // Parse as a sub-block starting on this line but treating the item as a map
        const subLines = [' '.repeat(baseIndent + 2) + itemContent];
        // Also collect subsequent indented lines
        let j = i + 1;
        while (j < lines.length) {
          const nl = lines[j];
          const ni = nl.length - nl.trimStart().length;
          if (nl.trim() === '') {
            j++;
            continue;
          }
          if (ni > baseIndent) {
            subLines.push(nl);
            j++;
          } else break;
        }
        const mapResult = parseYamlBlock(subLines, 0, baseIndent + 2);
        items.push(mapResult.value);
        i = j;
      } else {
        items.push(parseScalar(itemContent));
        i++;
      }
    } else if (lineContent === '-') {
      items.push(null);
      i++;
    } else {
      break;
    }
  }

  return { value: items, nextLine: i };
}

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (t === '{}') return {};
  if (t === '[]') return [];
  // Quoted string
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;
const VALID_TYPES = new Set(['feature', 'utility', 'container']);
const VALID_PROVIDERS = new Set([
  'anthropic',
  'openrouter',
  'ollama',
  'any',
  'custom',
]);
const VALID_PROTOCOLS = new Set(['https', 'wss']);
const VALID_DIRECTIONS = new Set(['outbound']);
const VALID_ACCESS = new Set(['read', 'read-write']);
const VALID_PERMISSION_TIERS = new Set(['viewer', 'member', 'owner', 'admin']);
const VALID_APPLY_PERMISSIONS = new Set(['admin', 'power_user']);

interface ValidationError {
  field: string;
  reason: string;
}

function validateIntent(raw: Record<string, unknown>): ValidationError | null {
  // Required: skill
  if (
    !raw.skill ||
    typeof raw.skill !== 'string' ||
    !KEBAB_CASE.test(raw.skill)
  ) {
    return {
      field: 'skill',
      reason: 'skill must be a non-empty kebab-case string',
    };
  }

  // Required: version
  if (
    !raw.version ||
    typeof raw.version !== 'string' ||
    !SEMVER.test(String(raw.version))
  ) {
    return {
      field: 'version',
      reason: 'version must be a valid semantic version (MAJOR.MINOR.PATCH)',
    };
  }

  // Required: type
  if (!raw.type || !VALID_TYPES.has(String(raw.type))) {
    return {
      field: 'type',
      reason: 'type must be one of: feature, utility, container',
    };
  }

  // Required: description
  if (
    !raw.description ||
    typeof raw.description !== 'string' ||
    raw.description.trim() === ''
  ) {
    return {
      field: 'description',
      reason: 'description must be a non-empty single-line string',
    };
  }

  // Required: apply_permission
  if (
    !raw.apply_permission ||
    !VALID_APPLY_PERMISSIONS.has(String(raw.apply_permission))
  ) {
    return {
      field: 'apply_permission',
      reason: 'apply_permission must be one of: admin, power_user',
    };
  }

  // Required: providers.compatible (non-empty)
  const providers = raw.providers as Record<string, unknown> | undefined;
  if (
    !providers ||
    !Array.isArray(providers.compatible) ||
    providers.compatible.length === 0
  ) {
    return {
      field: 'providers.compatible',
      reason: 'providers.compatible must be a non-empty list',
    };
  }
  for (const p of providers.compatible) {
    if (!VALID_PROVIDERS.has(String(p))) {
      return {
        field: 'providers.compatible',
        reason: `unknown provider value: ${p}`,
      };
    }
  }

  // Optional: token_scopes.skills — each must be kebab-case
  const tokenScopes = raw.token_scopes as Record<string, unknown> | undefined;
  if (tokenScopes && tokenScopes.skills !== undefined) {
    if (!Array.isArray(tokenScopes.skills)) {
      return {
        field: 'token_scopes.skills',
        reason: 'token_scopes.skills must be a list',
      };
    }
    for (const s of tokenScopes.skills) {
      if (typeof s !== 'string' || !KEBAB_CASE.test(s)) {
        return {
          field: 'token_scopes.skills',
          reason: `invalid skill ID in token_scopes.skills: "${s}" — must be kebab-case`,
        };
      }
    }
  }

  // Optional: filesystem.container_mounts
  const filesystem = raw.filesystem as Record<string, unknown> | undefined;
  if (filesystem && Array.isArray(filesystem.container_mounts)) {
    for (let idx = 0; idx < filesystem.container_mounts.length; idx++) {
      const mount = filesystem.container_mounts[idx] as Record<string, unknown>;
      if (!mount) continue;

      const hostPath = String(mount.host_path ?? '');
      const containerPath = String(mount.container_path ?? '');
      const access = String(mount.access ?? '');

      // host_path must exist on the host (checked first for clearer error messages)
      if (!fs.existsSync(hostPath)) {
        return {
          field: `filesystem.container_mounts[${idx}].host_path`,
          reason: `host path does not exist: ${hostPath}`,
        };
      }

      // Canonicalize to defeat path traversal (e.g. /tmp/../etc/passwd satisfies
      // a /tmp/ prefix check but resolves outside the permitted root).
      let resolvedHostPath: string;
      try {
        resolvedHostPath = fs.realpathSync(hostPath);
      } catch {
        return {
          field: `filesystem.container_mounts[${idx}].host_path`,
          reason: `host path could not be resolved: ${hostPath}`,
        };
      }

      // host_path must be within permitted mount roots (checked against canonical path)
      const withinPermitted = PERMITTED_MOUNT_ROOTS.some(
        (root) =>
          resolvedHostPath === root || resolvedHostPath.startsWith(root + '/'),
      );
      if (!withinPermitted) {
        return {
          field: `filesystem.container_mounts[${idx}].host_path`,
          reason: `host path outside permitted mount roots: ${hostPath}`,
        };
      }

      // container_path must be absolute
      if (!path.isAbsolute(containerPath)) {
        return {
          field: `filesystem.container_mounts[${idx}].container_path`,
          reason: `container_path must be an absolute path`,
        };
      }

      // access must be valid
      if (!VALID_ACCESS.has(access)) {
        return {
          field: `filesystem.container_mounts[${idx}].access`,
          reason: `access must be one of: read, read-write`,
        };
      }
    }
  }

  // Optional: network.endpoints
  const network = raw.network as Record<string, unknown> | undefined;
  if (network && Array.isArray(network.endpoints)) {
    for (let idx = 0; idx < network.endpoints.length; idx++) {
      const ep = network.endpoints[idx] as Record<string, unknown>;
      if (!ep) continue;

      const pattern = String(ep.pattern ?? '');
      const protocol = String(ep.protocol ?? '');
      const direction = String(ep.direction ?? '');

      if (!pattern || pattern.trim() === '') {
        return {
          field: `network.endpoints[${idx}].pattern`,
          reason: `endpoint pattern must be a non-empty string`,
        };
      }
      if (!VALID_PROTOCOLS.has(protocol)) {
        return {
          field: `network.endpoints[${idx}].protocol`,
          reason: `protocol must be one of: https, wss`,
        };
      }
      if (!VALID_DIRECTIONS.has(direction)) {
        return {
          field: `network.endpoints[${idx}].direction`,
          reason: `direction must be: outbound`,
        };
      }
    }
  }

  // Optional: mcp.servers
  const mcp = raw.mcp as Record<string, unknown> | undefined;
  if (mcp && Array.isArray(mcp.servers)) {
    for (let idx = 0; idx < mcp.servers.length; idx++) {
      const srv = mcp.servers[idx] as Record<string, unknown>;
      if (!srv) continue;

      const id = String(srv.id ?? '');
      const url = String(srv.url ?? '');
      const scopes = srv.scopes;
      const minPermTier = srv.min_permission_tier;

      if (!id || !KEBAB_CASE.test(id)) {
        return {
          field: `mcp.servers[${idx}].id`,
          reason: `mcp server id must be kebab-case`,
        };
      }
      if (!url || url.trim() === '') {
        return {
          field: `mcp.servers[${idx}].url`,
          reason: `mcp server url must be a non-empty URL`,
        };
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return {
          field: `mcp.servers[${idx}].scopes`,
          reason: `mcp server scopes must be a non-empty list`,
        };
      }
      if (!minPermTier || !VALID_PERMISSION_TIERS.has(String(minPermTier))) {
        return {
          field: `mcp.servers[${idx}].min_permission_tier`,
          reason: `min_permission_tier must be one of: viewer, member, owner, admin`,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Intent parsing — extract a typed object from the raw YAML map
// ---------------------------------------------------------------------------

function extractIntent(raw: Record<string, unknown>): InstalledSkill {
  const tokenScopes = raw.token_scopes as Record<string, unknown> | undefined;
  const _filesystem = raw.filesystem as Record<string, unknown> | undefined;
  const network = raw.network as Record<string, unknown> | undefined;
  const mcp = raw.mcp as Record<string, unknown> | undefined;
  const _providers = raw.providers as Record<string, unknown>;

  const skillTokenScopes: string[] = [];
  if (tokenScopes && Array.isArray(tokenScopes.skills)) {
    for (const s of tokenScopes.skills) skillTokenScopes.push(String(s));
  }

  const networkEndpoints: NetworkEndpoint[] = [];
  if (network && Array.isArray(network.endpoints)) {
    for (const ep of network.endpoints) {
      const e = ep as Record<string, unknown>;
      networkEndpoints.push({
        pattern: String(e.pattern),
        protocol: String(e.protocol) as 'https' | 'wss',
        direction: 'outbound',
      });
    }
  }

  const mcpServers: McpServer[] = [];
  if (mcp && Array.isArray(mcp.servers)) {
    for (const srv of mcp.servers) {
      const s = srv as Record<string, unknown>;
      mcpServers.push({
        id: String(s.id),
        url: String(s.url),
        scopes: (s.scopes as string[]).map(String),
        min_permission_tier: String(
          s.min_permission_tier,
        ) as McpServer['min_permission_tier'],
      });
    }
  }

  return {
    skillId: String(raw.skill),
    version: String(raw.version),
    type: String(raw.type) as InstalledSkill['type'],
    description: String(raw.description),
    tokenScopes: skillTokenScopes,
    networkEndpoints,
    mcpServers,
    applyPermission: String(
      raw.apply_permission,
    ) as InstalledSkill['applyPermission'],
  };
}

// ---------------------------------------------------------------------------
// Broker notification
// ---------------------------------------------------------------------------

let _rpcIdCounter = 1;
function nextRpcId(): number {
  return _rpcIdCounter++;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
  id: number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: unknown;
  error?: { code: number; message: string };
  id: number | string;
}

/**
 * Send a single JSON-RPC request on a Unix socket and await the response.
 * Returns the parsed response or throws if the broker is unreachable or
 * responds with an error.
 */
function sendRpc(
  socketPath: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(err);
    };

    conn.on('error', (err) => fail(err));

    conn.on('connect', () => {
      conn.write(JSON.stringify(req) + '\n');
    });

    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const resp = JSON.parse(line) as JsonRpcResponse;
          if (!settled) {
            settled = true;
            conn.destroy();
            resolve(resp);
          }
        } catch (e) {
          fail(new Error(`Broker response parse error: ${e}`));
        }
      }
    });

    conn.on('timeout', () => fail(new Error('Broker connection timed out')));
    conn.setTimeout(5000);
  });
}

async function notifyBrokerRegister(
  socketPath: string,
  skill: InstalledSkill,
): Promise<void> {
  const req: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'registerSkillScope',
    params: {
      skillId: skill.skillId,
      tokenScopes: skill.tokenScopes,
      networkEndpoints: skill.networkEndpoints,
    },
    id: nextRpcId(),
  };

  const resp = await sendRpc(socketPath, req);
  if (resp.error) {
    throw new Error(`Broker error: ${resp.error.message}`);
  }
}

async function notifyBrokerDeregister(
  socketPath: string,
  skillId: string,
): Promise<void> {
  const req: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'deregisterSkillScope',
    params: { skillId },
    id: nextRpcId(),
  };

  const resp = await sendRpc(socketPath, req);
  if (resp.error) {
    throw new Error(`Broker error: ${resp.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a skill from the given directory.
 *
 * 1. Reads and parses the .intent.md in skillDir.
 * 2. Validates all fields.
 * 3. Checks for ID collision.
 * 4. Registers in the in-memory registry.
 * 5. Notifies the Token Broker (if brokerSocketPath is non-null).
 * 6. Rolls back registry entry if broker notification fails.
 */
export async function applySkill(
  skillDir: string,
  options: SkillApplyOptions,
): Promise<SkillApplyResult> {
  const intentPath = path.join(skillDir, '.intent.md');

  // Check .intent.md exists
  if (!fs.existsSync(intentPath)) {
    return {
      ok: false,
      reason: 'no .intent.md found; skill not applied',
    };
  }

  // Parse
  let raw: Record<string, unknown>;
  try {
    const content = fs.readFileSync(intentPath, 'utf-8');
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      return { ok: false, reason: '.intent.md has no valid YAML frontmatter' };
    }
    raw = parsed;
  } catch (err) {
    return { ok: false, reason: `Failed to read .intent.md: ${err}` };
  }

  // Validate
  const validationError = validateIntent(raw);
  if (validationError) {
    logger.debug('skill validation failed', {
      field: validationError.field,
      reason: validationError.reason,
    });
    return {
      ok: false,
      field: validationError.field,
      reason: validationError.reason,
    };
  }

  // Check skill ID collision
  // A skill can be re-registered if the broker context (socketPath) has changed —
  // this allows the same test to run multiple times across different broker stubs
  // without requiring explicit cleanup between describe blocks.
  const skillId = String(raw.skill);
  const existing = installedSkills.get(skillId);
  if (existing) {
    const sameContext = existing._registeredWith === options.brokerSocketPath;
    if (sameContext) {
      return {
        ok: false,
        field: 'skill',
        reason: `skill ID collision: '${skillId}' is already installed`,
      };
    }
    // Different broker context → treat as re-registration (remove old entry)
    installedSkills.delete(skillId);
  }

  // Extract typed object
  const skill = extractIntent(raw);
  skill._registeredWith = options.brokerSocketPath;

  // Register in memory
  installedSkills.set(skillId, skill);

  // Notify broker (if socket provided)
  if (options.brokerSocketPath !== null) {
    try {
      await notifyBrokerRegister(options.brokerSocketPath, skill);
    } catch (err) {
      // Rollback
      installedSkills.delete(skillId);
      logger.error(
        'broker notification failed; rolling back skill registration',
        {
          skillId,
          err: String(err),
        },
      );
      return {
        ok: false,
        reason: `broker unavailable: ${err}`,
      };
    }
  }

  logger.info('skill applied', { skillId, version: skill.version });
  return { ok: true, skillId, version: skill.version };
}

/**
 * Remove an installed skill by skill ID.
 *
 * 1. Removes from in-memory registry.
 * 2. Notifies the Token Broker to deregister the scope.
 * 3. If broker notification fails, re-adds to registry and returns an error.
 */
export async function removeSkill(
  skillId: string,
  options: SkillApplyOptions,
): Promise<SkillRemoveResult> {
  const skill = installedSkills.get(skillId);
  if (!skill) {
    return { ok: false, reason: `skill not found: '${skillId}'` };
  }

  // Remove from registry
  installedSkills.delete(skillId);

  // Notify broker
  if (options.brokerSocketPath !== null) {
    try {
      await notifyBrokerDeregister(options.brokerSocketPath, skillId);
    } catch (err) {
      // Rollback
      installedSkills.set(skillId, skill);
      logger.error('broker deregistration failed; rolling back skill removal', {
        skillId,
        err: String(err),
      });
      return {
        ok: false,
        reason: `broker unavailable: ${err}`,
      };
    }
  }

  logger.info('skill removed', { skillId });
  return { ok: true, skillId };
}

/**
 * Return the current list of installed skills.
 */
export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  return Array.from(installedSkills.values());
}
