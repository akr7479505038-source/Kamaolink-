/**
 * ============================================================================
 * SQLITE DATABASE SETUP (server/db.ts)
 * ============================================================================
 *
 * Stores all users, links, India-verified clicks, encrypted bank details,
 * payouts, and anti-skip visitor sessions inside `data/linkmint.db`.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'linkmint.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pending_balance_paise INTEGER NOT NULL DEFAULT 0,
    total_earned_paise INTEGER NOT NULL DEFAULT 0,
    total_paid_paise INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    admin_email TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL UNIQUE,
    original_url TEXT NOT NULL,
    clicks INTEGER NOT NULL DEFAULT 0,
    paid_clicks INTEGER NOT NULL DEFAULT 0,
    earnings_paise INTEGER NOT NULL DEFAULT 0,
    count_views INTEGER NOT NULL DEFAULT 1,
    total_link_clicks INTEGER NOT NULL DEFAULT 0,
    ad_impressions INTEGER NOT NULL DEFAULT 0,
    ad_started INTEGER NOT NULL DEFAULT 0,
    ad_completed INTEGER NOT NULL DEFAULT 0,
    ad_skipped INTEGER NOT NULL DEFAULT 0,
    ad_failed INTEGER NOT NULL DEFAULT 0,
    valid_ad_views INTEGER NOT NULL DEFAULT 0,
    invalid_views INTEGER NOT NULL DEFAULT 0,
    duplicate_views INTEGER NOT NULL DEFAULT 0,
    bot_detections INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS visitor_sessions (
    token TEXT PRIMARY KEY,
    link_id INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    ua_hash TEXT NOT NULL,
    country_code TEXT NOT NULL DEFAULT 'XX',
    current_stage TEXT NOT NULL,
    ads_watched_on_page INTEGER NOT NULL DEFAULT 0,
    stage_started_at INTEGER NOT NULL,
    view_counted INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS verified_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    country_code TEXT NOT NULL DEFAULT 'XX',
    earned_paise INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ad_attempts (
    id TEXT PRIMARY KEY,
    session_token TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    ad_source TEXT NOT NULL,
    provider_name TEXT,
    ip_hash TEXT NOT NULL,
    ua_hash TEXT NOT NULL,
    required_watch_ms INTEGER NOT NULL,
    impression_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    skipped_at INTEGER,
    failed_at INTEGER,
    final_status TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ad_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ad_attempt_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    session_token TEXT NOT NULL,
    event_type TEXT NOT NULL,
    ad_source TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    ip_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_events_unique_attempt_event
    ON ad_events(ad_attempt_id, event_type);

  CREATE TABLE IF NOT EXISTS valid_ad_views_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    ad_attempt_id TEXT NOT NULL UNIQUE,
    ip_hash TEXT NOT NULL,
    ua_hash TEXT NOT NULL,
    stage TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    ad_source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS bank_accounts (
    user_id INTEGER PRIMARY KEY,
    account_holder_name TEXT NOT NULL,
    account_number_encrypted TEXT NOT NULL,
    account_last4 TEXT NOT NULL,
    ifsc_code TEXT NOT NULL,
    upi_id_encrypted TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount_paise INTEGER NOT NULL,
    status TEXT NOT NULL,
    window_label TEXT NOT NULL,
    bank_masked TEXT NOT NULL,
    reference_note TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
  CREATE INDEX IF NOT EXISTS idx_links_code ON links(code);
  CREATE INDEX IF NOT EXISTS idx_verified_clicks_dedup ON verified_clicks(link_id, ip_hash, created_at);
  CREATE INDEX IF NOT EXISTS idx_ad_attempts_session ON ad_attempts(session_token, stage, slot_index);
  CREATE INDEX IF NOT EXISTS idx_ad_events_link_created ON ad_events(link_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_valid_ad_views_dedup ON valid_ad_views_log(link_id, ip_hash, stage, slot_index, created_at);
  CREATE INDEX IF NOT EXISTS idx_payouts_user_id ON payouts(user_id, created_at);
`);

// Safe incremental column migrations if upgrading an existing database file
function ensureColumn(tableName: string, columnName: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

const userColsBefore = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
const hadPendingBalanceCol = userColsBefore.some((c) => c.name === 'pending_balance_paise');

ensureColumn('users', 'google_uid', 'TEXT');
ensureColumn('users', 'pending_balance_paise', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'total_earned_paise', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'total_paid_paise', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_google_uid ON users(google_uid);');

if (!hadPendingBalanceCol) {
  db.exec(`
    UPDATE users
    SET
      pending_balance_paise = MAX(0, total_earned_paise - total_paid_paise),
      total_earned_paise = total_paid_paise
    WHERE (total_earned_paise - total_paid_paise) > 0;
  `);
}
ensureColumn('links', 'paid_clicks', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'earnings_paise', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'count_views', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('links', 'total_link_clicks', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'ad_impressions', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'ad_started', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'ad_completed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'ad_skipped', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'ad_failed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'valid_ad_views', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'invalid_views', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'duplicate_views', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('links', 'bot_detections', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('visitor_sessions', 'country_code', "TEXT NOT NULL DEFAULT 'XX'");
ensureColumn('visitor_sessions', 'view_counted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('verified_clicks', 'country_code', "TEXT NOT NULL DEFAULT 'XX'");
ensureColumn('verified_clicks', 'earned_paise', 'INTEGER NOT NULL DEFAULT 0');

// Remove obsolete NOT NULL earned_micros column from legacy verified_clicks tables
const verifiedClickCols = db
  .prepare('PRAGMA table_info(verified_clicks)')
  .all() as Array<{ name: string }>;
if (verifiedClickCols.some((c) => c.name === 'earned_micros')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;
    CREATE TABLE verified_clicks_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL,
      ip_hash TEXT NOT NULL,
      country_code TEXT NOT NULL DEFAULT 'XX',
      earned_paise INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE
    );
    INSERT INTO verified_clicks_new (id, link_id, ip_hash, country_code, earned_paise, created_at)
    SELECT id, link_id, ip_hash, COALESCE(country_code, 'XX'), COALESCE(earned_paise, 0), created_at
    FROM verified_clicks;
    DROP TABLE verified_clicks;
    ALTER TABLE verified_clicks_new RENAME TO verified_clicks;
    CREATE INDEX IF NOT EXISTS idx_verified_clicks_dedup ON verified_clicks(link_id, ip_hash, created_at);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
