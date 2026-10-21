import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

type Bar = { time: number; open: number; high: number; low: number; close: number; volume?: number | null };
type BarRow = { time: number; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null };

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SERVER_DIR, '..', '..', '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const DB_FILE = path.join(CACHE_DIR, 'bars.sqlite');

const TF_MS_UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 2_592_000_000 };
const tfToMs = (tf: string): number => parseInt(tf, 10) * (TF_MS_UNIT[tf.slice(-1)] ?? 60_000);

// Versioned migrations keep the local cache schema reproducible across upgrades.
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS bars (
      symbol TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL,
      PRIMARY KEY (symbol, tf, time));`);
    db.exec(`CREATE TABLE IF NOT EXISTS meta (
      symbol TEXT NOT NULL, tf TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY (symbol, tf));`);
  },
  (db) => {
    const cols = (db.prepare('PRAGMA table_info(meta)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('covered_from')) db.exec('ALTER TABLE meta ADD COLUMN covered_from INTEGER');
  },
];

function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[version](db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
migrate(db);

const qCount = db.prepare('SELECT COUNT(*) AS n FROM bars WHERE symbol=? AND tf=?');
const qFetchedAt = db.prepare('SELECT fetched_at, covered_from FROM meta WHERE symbol=? AND tf=?');
const qGet = db.prepare(
  'SELECT time,open,high,low,close,volume FROM bars WHERE symbol=? AND tf=? ORDER BY time DESC LIMIT ?',
);
const qGetWindow = db.prepare(
  `SELECT time,open,high,low,close,volume FROM bars
   WHERE symbol=? AND tf=? AND (? IS NULL OR time<=?) AND (? IS NULL OR time>=?)
   ORDER BY time DESC LIMIT ?`,
);
const qPutBar = db.prepare(
  `INSERT INTO bars (symbol,tf,time,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?,?)
   ON CONFLICT(symbol,tf,time) DO UPDATE SET open=excluded.open,high=excluded.high,
     low=excluded.low,close=excluded.close,volume=excluded.volume`,
);
const qPutMeta = db.prepare('INSERT OR REPLACE INTO meta (symbol,tf,fetched_at,covered_from) VALUES (?,?,?,?)');
const qGetCovered = db.prepare('SELECT covered_from FROM meta WHERE symbol=? AND tf=?');

export function cacheCount(symbol: string, tf: string): number {
  return (qCount.get(symbol, tf) as { n: number }).n;
}

export function cacheFetchedAt(symbol: string, tf: string): number {
  const row = qFetchedAt.get(symbol, tf) as { fetched_at: number } | undefined;
  return row ? row.fetched_at : 0;
}

export function cacheCoveredFrom(symbol: string, tf: string): number | null {
  const row = qGetCovered.get(symbol, tf) as { covered_from: number | null } | undefined;
  return row ? row.covered_from : null;
}

const toBar = (row: BarRow): Bar => ({
  time: row.time,
  open: row.open ?? 0,
  high: row.high ?? 0,
  low: row.low ?? 0,
  close: row.close ?? 0,
  volume: row.volume ?? undefined,
});

export function cacheGet(symbol: string, tf: string, count: number): Bar[] {
  return (qGet.all(symbol, tf, count) as BarRow[]).reverse().map(toBar);
}

export function cacheGetWindow(symbol: string, tf: string, from: number | null, to: number | null, limit: number): Bar[] {
  return (qGetWindow.all(symbol, tf, to, to, from, from, limit) as BarRow[]).reverse().map(toBar);
}

export function cachePut(symbol: string, tf: string, bars: Bar[], { hitGenesis = false }: { hitGenesis?: boolean } = {}): void {
  // Coverage is the OLDEST open-time down to which we have a CONTIGUOUS run ending at
  // "now" (0 = the source itself is exhausted). We only extend it for a chunk that
  // CONNECTS to what we already had — a disjoint island (e.g. a request.security range
  // in the distant past) must not widen the claim.
  const prev = cacheCoveredFrom(symbol, tf);
  const asc = [...bars].sort((a, b) => a.time - b.time);
  let next = prev;
  if (asc.length > 0) {
    const newest = asc[asc.length - 1].time;
    const tolerance = tfToMs(tf) * 3;
    const connects = prev == null || prev === 0 || newest >= prev - tolerance;
    if (prev === 0) next = 0;
    else if (connects) next = hitGenesis ? 0 : prev == null ? asc[0].time : Math.min(prev, asc[0].time);
  } else if (hitGenesis && prev == null) {
    next = prev;
  }

  db.exec('BEGIN');
  try {
    for (const bar of bars) {
      qPutBar.run(symbol, tf, bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null);
    }
    qPutMeta.run(symbol, tf, Date.now(), next);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function closeDb(): void {
  db.close();
}
