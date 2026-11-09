import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'harmony.sqlite'));
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) { db.close(); throw new Error('数据库版本较新，请使用最新和音客户端'); }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('local','qq','netease')),
      provider_id TEXT, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,
      file_name TEXT, mime TEXT, bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, provider, provider_id)
    );
    CREATE INDEX IF NOT EXISTS tracks_user ON tracks(user_id);
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'sage',
      source TEXT NOT NULL DEFAULT 'own', version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS playlists_user ON playlists(user_id);
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY(playlist_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, PRIMARY KEY(user_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS recent_tracks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      played_at INTEGER NOT NULL, PRIMARY KEY(user_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS provider_connections (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('qq','netease')),
      profile_id TEXT NOT NULL, nickname TEXT NOT NULL, credential TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected', updated_at INTEGER NOT NULL, synced_at INTEGER,
      PRIMARY KEY(user_id, provider)
    );
  `);
  const playlistColumns = new Set(db.prepare('PRAGMA table_info(playlists)').all().map(column => column.name));
  transaction(db, () => {
    if (!playlistColumns.has('remote_id')) db.exec('ALTER TABLE playlists ADD COLUMN remote_id TEXT');
    if (!playlistColumns.has('track_count')) db.exec('ALTER TABLE playlists ADD COLUMN track_count INTEGER NOT NULL DEFAULT 0');
    if (!playlistColumns.has('loaded_at')) db.exec('ALTER TABLE playlists ADD COLUMN loaded_at INTEGER');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS playlist_remote ON playlists(user_id, source, remote_id) WHERE remote_id IS NOT NULL; PRAGMA user_version = 2;');
  });
  if (!db.prepare('PRAGMA table_info(tracks)').all().some(c => c.name === 'cover_url'))
    db.exec("ALTER TABLE tracks ADD COLUMN cover_url TEXT NOT NULL DEFAULT ''");
  const trackColumns = new Set(db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name));
  transaction(db, () => {
    if (!trackColumns.has('release_date')) db.exec("ALTER TABLE tracks ADD COLUMN release_date TEXT NOT NULL DEFAULT ''");
    if (!trackColumns.has('play_count')) db.exec('ALTER TABLE tracks ADD COLUMN play_count INTEGER');
    if (!trackColumns.has('favorite_count')) db.exec('ALTER TABLE tracks ADD COLUMN favorite_count INTEGER');
  });
  db.exec(`CREATE TABLE IF NOT EXISTS playlist_layouts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    layout TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS local_profiles (
    device TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
  )`);
  if (!db.prepare('PRAGMA table_info(playlists)').all().some(c => c.name === 'preview_cover'))
    db.exec("ALTER TABLE playlists ADD COLUMN preview_cover TEXT NOT NULL DEFAULT ''");
  return db;
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
