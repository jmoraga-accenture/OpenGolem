import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('assertiveness_level column is added and defaults to 10', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opengolem-db-assertiveness-'),
    );
    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      // Create legacy DB without assertiveness_level column
      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('tui:main', 'Main', 'main', '@Alef', '2026-01-01T00:00:00.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getRegisteredGroup, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const group = getRegisteredGroup('tui:main');
      expect(group).toBeDefined();
      // assertivenessLevel should default to 10 after migration
      expect(group?.assertivenessLevel).toBe(10);

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opengolem-db-test-'),
    );

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
