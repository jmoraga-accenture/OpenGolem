import { describe, it, expect } from 'vitest';

import {
  isValidTimezone,
  resolveTimezone,
  formatLocalTime,
} from './timezone.js';

describe('isValidTimezone', () => {
  it('accepts well-known IANA region/city identifiers', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Pacific/Auckland')).toBe(true);
  });

  it('accepts UTC', () => {
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidTimezone('')).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(isValidTimezone('   ')).toBe(false);
  });

  it('rejects POSIX-style offset strings that are not IANA', () => {
    expect(isValidTimezone('IST-2')).toBe(false);
    expect(isValidTimezone('XYZ+3')).toBe(false);
  });

  it('rejects arbitrary garbage strings', () => {
    expect(isValidTimezone('NotATimezone')).toBe(false);
    expect(isValidTimezone('foo/bar/baz')).toBe(false);
    expect(isValidTimezone('12345')).toBe(false);
  });
});

describe('resolveTimezone', () => {
  it('returns the input when it is a valid IANA timezone', () => {
    expect(resolveTimezone('America/Chicago')).toBe('America/Chicago');
    expect(resolveTimezone('UTC')).toBe('UTC');
  });

  it('falls back to UTC for an invalid timezone string', () => {
    expect(resolveTimezone('IST-2')).toBe('UTC');
    expect(resolveTimezone('garbage')).toBe('UTC');
  });

  it('falls back to UTC for an empty string', () => {
    expect(resolveTimezone('')).toBe('UTC');
  });
});

describe('formatLocalTime', () => {
  // 2026-02-04T18:30:00Z
  //   America/New_York is UTC-5 in February (EST) => 1:30 PM local
  it('converts a winter UTC timestamp to Eastern Standard Time', () => {
    const result = formatLocalTime(
      '2026-02-04T18:30:00.000Z',
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  // 2026-06-15T12:00:00Z
  //   America/New_York is UTC-4 in June (EDT) => 8:00 AM
  //   Asia/Tokyo is UTC+9 => 9:00 PM
  it('produces different local times for the same UTC instant across timezones', () => {
    const utc = '2026-06-15T12:00:00.000Z';
    const nyResult = formatLocalTime(utc, 'America/New_York');
    const tokyoResult = formatLocalTime(utc, 'Asia/Tokyo');
    expect(nyResult).toContain('8:00');
    expect(tokyoResult).toContain('9:00');
  });

  it('includes the day, month abbreviation, and year in output', () => {
    const result = formatLocalTime('2026-03-20T10:00:00.000Z', 'UTC');
    expect(result).toContain('2026');
    expect(result).toContain('Mar');
    expect(result).toContain('20');
  });

  it('falls back to UTC when an invalid timezone is provided', () => {
    // 2026-01-01T12:00:00Z in UTC = 12:00 PM
    const result = formatLocalTime('2026-01-01T12:00:00.000Z', 'NotAZone');
    expect(result).toContain('12:00');
    expect(result).toContain('PM');
  });

  it('does not throw for an invalid timezone', () => {
    expect(() =>
      formatLocalTime('2026-07-04T00:00:00.000Z', 'BADZONE'),
    ).not.toThrow();
  });
});
