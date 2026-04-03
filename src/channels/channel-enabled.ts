/**
 * Which channel adapters participate at startup.
 *
 * Default is `tui` only so local/dev and systemd installs do not probe Telegram
 * or spam logs. Add external channels explicitly, e.g. OPENGOLEM_CHANNELS=tui,telegram
 *
 * process.env.OPENGOLEM_CHANNELS is populated from .env by src/bootstrap.ts
 * before this module loads.
 */
export function getEnabledChannelIds(): Set<string> {
  const raw = process.env.OPENGOLEM_CHANNELS ?? 'tui';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isChannelEnabled(id: string): boolean {
  return getEnabledChannelIds().has(id.toLowerCase());
}
