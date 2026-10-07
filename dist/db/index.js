import { mkdirSync } from "node:fs";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { CATEGORIES, } from "../types.js";
const SCHEMA_VERSION = 1;
const CATEGORY_LIST = CATEGORIES.map((c) => `'${c}'`).join(", ");
const MIGRATIONS = [
    `
  CREATE TABLE IF NOT EXISTS intelligence_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    target_url TEXT NOT NULL,
    competitor_name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN (${CATEGORY_LIST})),
    payload TEXT NOT NULL,
    metrics TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_events_competitor ON intelligence_events (competitor_name);
  CREATE INDEX IF NOT EXISTS idx_events_category ON intelligence_events (category);
  CREATE INDEX IF NOT EXISTS idx_events_created_at ON intelligence_events (created_at);
  CREATE INDEX IF NOT EXISTS idx_events_competitor_category
    ON intelligence_events (competitor_name, category, created_at DESC);
  `,
];
let dbPromise = null;
/** Absolute path of the SQLite database in use (resolved lazily). */
export function resolveDbPath() {
    const fromEnv = process.env["INTEL_DB_PATH"];
    const dbPath = fromEnv && fromEnv.trim().length > 0
        ? path.resolve(fromEnv)
        : path.join(process.cwd(), "data", "intelligence.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    return dbPath;
}
async function createConnection() {
    const dbPath = resolveDbPath();
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec("PRAGMA journal_mode = WAL;");
    await db.exec("PRAGMA foreign_keys = ON;");
    await runMigrations(db);
    return db;
}
async function runMigrations(db) {
    await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
    const row = await db.get("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations");
    const current = row?.version ?? 0;
    for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
        const migration = MIGRATIONS[version - 1];
        if (!migration)
            continue;
        await db.exec("BEGIN");
        try {
            await db.exec(migration);
            await db.run("INSERT INTO schema_migrations (version) VALUES (?)", version);
            await db.exec("COMMIT");
        }
        catch (error) {
            await db.exec("ROLLBACK");
            throw error;
        }
    }
}
/** Returns the shared, lazily-initialised database connection. */
export function getDb() {
    if (!dbPromise) {
        dbPromise = createConnection().catch((error) => {
            dbPromise = null;
            throw error;
        });
    }
    return dbPromise;
}
function rowToEvent(row) {
    return {
        id: row.id,
        createdAt: row.created_at,
        targetUrl: row.target_url,
        competitorName: row.competitor_name,
        category: row.category,
        payload: row.payload,
        metrics: row.metrics,
    };
}
/** Persists a scraped intelligence event and returns its row id. */
export async function insertEvent(event) {
    const db = await getDb();
    const result = await db.run(`INSERT INTO intelligence_events (target_url, competitor_name, category, payload, metrics)
     VALUES (?, ?, ?, ?, ?)`, event.targetUrl, event.competitorName, event.category, JSON.stringify(event.payload), JSON.stringify(event.metrics));
    return result.lastID ?? 0;
}
function buildEventQuery(filters) {
    const conditions = [];
    const params = [];
    if (filters.competitorName && filters.competitorName.trim().length > 0) {
        conditions.push("competitor_name LIKE ?");
        params.push(`%${filters.competitorName.trim()}%`);
    }
    if (filters.category) {
        conditions.push("category = ?");
        params.push(filters.category);
    }
    if (filters.startDate && filters.startDate.trim().length > 0) {
        conditions.push("created_at >= ?");
        params.push(filters.startDate.trim());
    }
    if (filters.endDate && filters.endDate.trim().length > 0) {
        const raw = filters.endDate.trim();
        conditions.push("created_at <= ?");
        params.push(raw.includes("T") ? raw : `${raw}T23:59:59.999Z`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
    return {
        sql: `SELECT id, created_at, target_url, competitor_name, category, payload, metrics
          FROM intelligence_events ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        params: [...params, limit],
    };
}
/** Queries stored intelligence events with optional filters (newest first). */
export async function queryEvents(filters = {}) {
    const db = await getDb();
    const { sql, params } = buildEventQuery(filters);
    const rows = await db.all(sql, ...params);
    return rows.map(rowToEvent);
}
/** Returns the most recent event per competitor for a category (newest first). */
export async function queryLatestPerCompetitor(category, competitorList) {
    const db = await getDb();
    const placeholders = competitorList.map(() => "?").join(", ");
    const rows = await db.all(`SELECT e.id, e.created_at, e.target_url, e.competitor_name, e.category, e.payload, e.metrics
     FROM intelligence_events e
     JOIN (
       SELECT competitor_name, MAX(created_at || printf('-%06d', id)) AS rank
       FROM intelligence_events
       WHERE category = ? AND competitor_name IN (${placeholders})
       GROUP BY competitor_name
     ) latest ON latest.competitor_name = e.competitor_name
     AND (e.created_at || printf('-%06d', e.id)) = latest.rank
     ORDER BY e.competitor_name`, category, ...competitorList);
    return rows.map(rowToEvent);
}
/** Returns every event for a competitor/category pair ordered oldest first. */
export async function queryTimeline(competitorName, category, startDate, limit = 50) {
    const db = await getDb();
    const params = [competitorName, category];
    let where = "competitor_name LIKE ? AND category = ?";
    if (startDate && startDate.trim().length > 0) {
        where += " AND created_at >= ?";
        params.push(startDate.trim());
    }
    const rows = await db.all(`SELECT id, created_at, target_url, competitor_name, category, payload, metrics
     FROM intelligence_events
     WHERE ${where}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`, ...params, Math.min(Math.max(limit, 1), 500));
    return rows.map(rowToEvent);
}
/** Aggregates event counts per competitor and category for overview output. */
export async function queryOverview() {
    const db = await getDb();
    return db.all(`SELECT competitor_name, category, COUNT(*) AS event_count, MAX(created_at) AS last_seen
     FROM intelligence_events
     GROUP BY competitor_name, category
     ORDER BY competitor_name, category`);
}
/** Closes the shared connection (used during shutdown and tests). */
export async function closeDb() {
    if (!dbPromise)
        return;
    const db = await dbPromise;
    dbPromise = null;
    await db.close();
}
//# sourceMappingURL=index.js.map