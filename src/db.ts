import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'tortuga.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS private_vc (
    channel_id  TEXT PRIMARY KEY,
    guild_id    TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    empty_since INTEGER
  );
  CREATE TABLE IF NOT EXISTS plays (
    key       TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    author    TEXT,
    uri       TEXT,
    count     INTEGER NOT NULL DEFAULT 0,
    last_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS news_seen (
    feed TEXT NOT NULL,
    guid TEXT NOT NULL,
    ts   INTEGER NOT NULL,
    PRIMARY KEY (feed, guid)
  );
`);

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
