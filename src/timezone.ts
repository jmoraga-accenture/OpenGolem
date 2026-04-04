export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.trim() === '') {
    return false;
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

export function formatLocalTime(utcIso: string, timezone: string): string {
  const instant = new Date(utcIso);
  const zone = resolveTimezone(timezone);
  return instant.toLocaleString('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
