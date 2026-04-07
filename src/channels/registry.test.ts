import { describe, it, expect } from 'vitest';

import {
  registerChannel,
  getChannelFactory,
  getRegisteredChannelNames,
} from './registry.js';
import type { ChannelFactory } from './registry.js';

// The registry is module-level state. Tests use distinct names to avoid
// collisions with each other or with channels registered by the channel modules
// themselves during import.

const uid = (label: string) =>
  `__cleanroom_${label}_${Math.random().toString(36).slice(2)}__`;

describe('registerChannel', () => {
  it('makes the factory retrievable by name', () => {
    const name = uid('store');
    const factory: ChannelFactory = () => null;
    registerChannel(name, factory);
    expect(getChannelFactory(name)).toBe(factory);
  });

  it('replaces a prior registration under the same name', () => {
    const name = uid('replace');
    const first: ChannelFactory = () => null;
    const second: ChannelFactory = () => null;
    registerChannel(name, first);
    registerChannel(name, second);
    expect(getChannelFactory(name)).toBe(second);
    expect(getChannelFactory(name)).not.toBe(first);
  });

  it('registers multiple channels independently without cross-contamination', () => {
    const nameA = uid('multi-a');
    const nameB = uid('multi-b');
    const nameC = uid('multi-c');
    const fa: ChannelFactory = () => null;
    const fb: ChannelFactory = () => null;
    const fc: ChannelFactory = () => null;
    registerChannel(nameA, fa);
    registerChannel(nameB, fb);
    registerChannel(nameC, fc);
    expect(getChannelFactory(nameA)).toBe(fa);
    expect(getChannelFactory(nameB)).toBe(fb);
    expect(getChannelFactory(nameC)).toBe(fc);
  });
});

describe('getChannelFactory', () => {
  it('returns undefined for a name that was never registered', () => {
    expect(getChannelFactory(uid('never-registered'))).toBeUndefined();
  });

  it('returns the exact function reference that was registered', () => {
    const name = uid('exact-ref');
    const factory: ChannelFactory = (_opts) => null;
    registerChannel(name, factory);
    const result = getChannelFactory(name);
    expect(result).toBe(factory);
  });
});

describe('getRegisteredChannelNames', () => {
  it('returns an Array', () => {
    expect(Array.isArray(getRegisteredChannelNames())).toBe(true);
  });

  it('contains a name after it is registered', () => {
    const name = uid('in-names');
    registerChannel(name, () => null);
    expect(getRegisteredChannelNames()).toContain(name);
  });

  it('contains all registered names', () => {
    const nameX = uid('names-x');
    const nameY = uid('names-y');
    registerChannel(nameX, () => null);
    registerChannel(nameY, () => null);
    const names = getRegisteredChannelNames();
    expect(names).toContain(nameX);
    expect(names).toContain(nameY);
  });

  it('does not return the internal map reference (mutations do not affect registry)', () => {
    const name = uid('snapshot');
    registerChannel(name, () => null);
    const snapshot = getRegisteredChannelNames();
    const lengthBefore = snapshot.length;
    snapshot.push('__injected__');
    // A second call should NOT include the injected value
    const fresh = getRegisteredChannelNames();
    expect(fresh).not.toContain('__injected__');
    expect(fresh.length).toBe(lengthBefore);
  });
});
