import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id           INTEGER PRIMARY KEY,
  username        TEXT,
  address         TEXT,
  seed_enc        TEXT,
  slippage_bps    INTEGER NOT NULL DEFAULT 300,
  auto_trustline  INTEGER NOT NULL DEFAULT 1,
  referrer_id     INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id       INTEGER NOT NULL,
  kind        TEXT NOT NULL,           -- buy | sell | nft_buy | nft_offer
  asset       TEXT NOT NULL,           -- CODE.issuer  or  NFTokenID
  spent_xrp   REAL,
  received    REAL,
  tx_hash     TEXT,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id       INTEGER NOT NULL,
  asset       TEXT NOT NULL,
  target      REAL,
  direction   TEXT,                    -- above | below
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(tg_id, created_at DESC);
`);

// Older DBs won't have these columns yet — CREATE TABLE IF NOT EXISTS is a no-op on them.
{
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  const addCol = (name) => { if (!cols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT`); };
  addCol('social_x');
  addCol('social_telegram');
  addCol('social_discord');
  addCol('social_website');

  // watch started life as price-only; 'buys' rows track trade activity instead,
  // and need a high-water mark so a restart doesn't replay old fills as new.
  const wc = new Set(db.prepare('PRAGMA table_info(watch)').all().map((c) => c.name));
  if (!wc.has('kind')) db.exec("ALTER TABLE watch ADD COLUMN kind TEXT NOT NULL DEFAULT 'price'");
  if (!wc.has('last_seen')) db.exec('ALTER TABLE watch ADD COLUMN last_seen INTEGER');
  // Group buy-bot rows post into a chat rather than back to the person who set
  // them up, so the destination has to be stored separately from the owner.
  if (!wc.has('chat_id')) db.exec('ALTER TABLE watch ADD COLUMN chat_id INTEGER');
}

export const q = {
  getUser: db.prepare('SELECT * FROM users WHERE tg_id = ?'),

  upsertUser: db.prepare(`
    INSERT INTO users (tg_id, username, created_at) VALUES (@tg_id, @username, @created_at)
    ON CONFLICT(tg_id) DO UPDATE SET username = excluded.username
  `),

  setWallet: db.prepare('UPDATE users SET address = ?, seed_enc = ? WHERE tg_id = ?'),
  clearWallet: db.prepare('UPDATE users SET address = NULL, seed_enc = NULL WHERE tg_id = ?'),
  setSlippage: db.prepare('UPDATE users SET slippage_bps = ? WHERE tg_id = ?'),
  setAutoTrustline: db.prepare('UPDATE users SET auto_trustline = ? WHERE tg_id = ?'),
  setSocials: db.prepare(`
    UPDATE users SET social_x = @x, social_telegram = @telegram, social_discord = @discord, social_website = @website
    WHERE tg_id = @tg_id
  `),

  logTrade: db.prepare(`
    INSERT INTO trades (tg_id, kind, asset, spent_xrp, received, tx_hash, status, created_at)
    VALUES (@tg_id, @kind, @asset, @spent_xrp, @received, @tx_hash, @status, @created_at)
  `),
  recentTrades: db.prepare('SELECT * FROM trades WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?'),

  addWatch: db.prepare(`
    INSERT INTO watch (tg_id, asset, target, direction, created_at)
    VALUES (@tg_id, @asset, @target, @direction, @created_at)
  `),

  addBuyWatch: db.prepare(`
    INSERT INTO watch (tg_id, chat_id, asset, kind, last_seen, created_at)
    VALUES (@tg_id, @chat_id, @asset, 'buys', @last_seen, @created_at)
  `),
  setWatchSeen: db.prepare('UPDATE watch SET last_seen = ? WHERE id = ?'),

  /** One buy-bot feed per chat — re-running /settokenbot replaces it. */
  clearChatBuyWatch: db.prepare("DELETE FROM watch WHERE chat_id = ? AND kind = 'buys'"),
  listChatBuyWatch: db.prepare("SELECT * FROM watch WHERE chat_id = ? AND kind = 'buys'"),
  listWatch: db.prepare('SELECT * FROM watch WHERE tg_id = ?'),
  allWatch: db.prepare('SELECT * FROM watch'),
  deleteWatch: db.prepare('DELETE FROM watch WHERE id = ? AND tg_id = ?'),

};

export function ensureUser(ctx) {
  q.upsertUser.run({
    tg_id: ctx.from.id,
    username: ctx.from.username || null,
    created_at: Date.now(),
  });
  return q.getUser.get(ctx.from.id);
}
