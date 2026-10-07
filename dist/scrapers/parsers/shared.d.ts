import type { PriceStats } from "../../types.js";
/** Collapses whitespace and trims a string. */
export declare function cleanText(value: string | null | undefined): string;
/**
 * Extracts readable text from an HTML fragment, inserting a space wherever a
 * tag boundary occurs. Unlike `cheerio.text()`, this preserves word boundaries
 * between "…$29.99" and "In Stock", so `\b…\b` regexes match reliably.
 */
export declare function textWithSpacing(html: string, max?: number): string;
/** Normalises an arbitrary label into a lowercase, dash-separated key. */
export declare function slugify(value: string): string;
interface MoneyParse {
    min: number | null;
    max: number | null;
    currency: string;
}
/**
 * Parses salary/price strings such as "$120,000 - $150,000", "10.000 ₺ - 15.000 ₺",
 * "€1.200,50" or "850 TL / night" into structured numeric ranges.
 */
export declare function parseMoney(raw: string): MoneyParse | null;
/** Detects the pay period implied by a salary/price string. */
export declare function detectPeriod(text: string): "hour" | "day" | "month" | "year" | null;
export declare function computePriceStats(prices: Array<number | null | undefined>, currency: string | null): PriceStats;
/** Returns the top `limit` significant tokens from a text blob. */
export declare function keywordFrequency(text: string, limit?: number): Record<string, number>;
export declare function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number>;
export declare function round2(value: number): number;
/** Safe JSON parse that returns null instead of throwing. */
export declare function safeJsonParse<T>(raw: string): T | null;
/** Formats a number for display in markdown tables (thousands separators). */
export declare function fmt(value: number | null | undefined): string;
export {};
