import { type Database } from "sqlite";
import { type Category, type IntelligenceEvent, type NewIntelligenceEvent, type QueryFilters } from "../types.js";
/** Absolute path of the SQLite database in use (resolved lazily). */
export declare function resolveDbPath(): string;
/** Returns the shared, lazily-initialised database connection. */
export declare function getDb(): Promise<Database>;
/** Persists a scraped intelligence event and returns its row id. */
export declare function insertEvent(event: NewIntelligenceEvent): Promise<number>;
/** Queries stored intelligence events with optional filters (newest first). */
export declare function queryEvents(filters?: QueryFilters): Promise<IntelligenceEvent[]>;
/** Returns the most recent event per competitor for a category (newest first). */
export declare function queryLatestPerCompetitor(category: Category, competitorList: string[]): Promise<IntelligenceEvent[]>;
/** Returns every event for a competitor/category pair ordered oldest first. */
export declare function queryTimeline(competitorName: string, category: Category, startDate?: string, limit?: number): Promise<IntelligenceEvent[]>;
export interface OverviewRow {
    competitor_name: string;
    category: string;
    event_count: number;
    last_seen: string;
}
/** Aggregates event counts per competitor and category for overview output. */
export declare function queryOverview(): Promise<OverviewRow[]>;
/** Closes the shared connection (used during shutdown and tests). */
export declare function closeDb(): Promise<void>;
