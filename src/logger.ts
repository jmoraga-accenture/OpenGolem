import { getEnabledChannelIds } from './channels/channel-enabled.js';

// ---------------------------------------------------------------------------
// ANSI color codes
// ---------------------------------------------------------------------------
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const WHITE_ON_RED = '\x1b[37;41m';

// ---------------------------------------------------------------------------
// Level definitions
// ---------------------------------------------------------------------------
const LEVELS = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

type LevelName = keyof typeof LEVELS;

const LEVEL_COLOR: Record<LevelName, string> = {
  debug: BLUE,
  info: GREEN,
  warn: YELLOW,
  error: RED,
  fatal: WHITE_ON_RED,
};

// ---------------------------------------------------------------------------
// Resolve active threshold
// ---------------------------------------------------------------------------
function resolveThreshold(): number {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVELS) {
    return LEVELS[raw as LevelName];
  }
  // Unset or invalid: TUI-only → warn, otherwise → info
  const enabled = getEnabledChannelIds();
  const tuiOnly = enabled.size === 1 && enabled.has('tui');
  return tuiOnly ? LEVELS.warn : LEVELS.info;
}

// ---------------------------------------------------------------------------
// Format timestamp HH:MM:SS.mmm
// ---------------------------------------------------------------------------
function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// ---------------------------------------------------------------------------
// Format an Error object for the `err` key
// ---------------------------------------------------------------------------
function formatError(e: unknown): string {
  if (e instanceof Error) {
    const name = e.constructor.name;
    const lines = [`${name}: ${e.message}`];
    if (e.stack) {
      // Skip the first line of stack (already captured above) and indent the rest
      const stackLines = e.stack.split('\n').slice(1);
      lines.push(...stackLines);
    }
    return lines.join('\n    ');
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------
function emit(
  level: LevelName,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  const threshold = resolveThreshold();
  if (LEVELS[level] < threshold) return;

  const color = LEVEL_COLOR[level];
  const prefix = `[${timestamp()}] ${color}${level.toUpperCase().padEnd(5)}${RESET} (${process.pid}): `;

  if (typeof dataOrMsg === 'string') {
    process.stderr.write(`${prefix}${CYAN}${dataOrMsg}${RESET}\n`);
    return;
  }

  // Object + optional message
  const message = msg ?? '';
  const lines: string[] = [`${prefix}${CYAN}${message}${RESET}`];

  for (const [key, value] of Object.entries(dataOrMsg)) {
    const formattedValue = key === 'err' ? formatError(value) : String(value);
    lines.push(`  ${MAGENTA}${key}${RESET}: ${formattedValue}`);
  }

  process.stderr.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Public logger interface
// ---------------------------------------------------------------------------
export const logger = {
  debug(dataOrMsg: Record<string, unknown> | string, msg?: string): void {
    emit('debug', dataOrMsg, msg);
  },
  info(dataOrMsg: Record<string, unknown> | string, msg?: string): void {
    emit('info', dataOrMsg, msg);
  },
  warn(dataOrMsg: Record<string, unknown> | string, msg?: string): void {
    emit('warn', dataOrMsg, msg);
  },
  error(dataOrMsg: Record<string, unknown> | string, msg?: string): void {
    emit('error', dataOrMsg, msg);
  },
  fatal(dataOrMsg: Record<string, unknown> | string, msg?: string): void {
    emit('fatal', dataOrMsg, msg);
  },
};

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err: Error) => {
  logger.fatal({ err }, 'uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
