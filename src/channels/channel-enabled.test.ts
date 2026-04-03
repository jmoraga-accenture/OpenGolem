import { describe, it, expect, afterEach } from 'vitest';

import { getEnabledChannelIds } from './channel-enabled.js';

describe('channel-enabled', () => {
  const orig = process.env.OPENGOLEM_CHANNELS;

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.OPENGOLEM_CHANNELS;
    } else {
      process.env.OPENGOLEM_CHANNELS = orig;
    }
  });

  it('defaults to tui only', () => {
    delete process.env.OPENGOLEM_CHANNELS;
    expect([...getEnabledChannelIds()].sort()).toEqual(['tui']);
  });

  it('parses comma-separated list', () => {
    process.env.OPENGOLEM_CHANNELS = 'telegram, tui ';
    const s = getEnabledChannelIds();
    expect(s.has('telegram')).toBe(true);
    expect(s.has('tui')).toBe(true);
  });
});
