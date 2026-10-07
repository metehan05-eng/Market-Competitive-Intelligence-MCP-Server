import type { CustomSelectors } from "../types.js";
export declare const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export declare const DEFAULT_TIMEOUT_MS = 30000;
export interface EngineOptions {
    timeoutMs?: number;
    waitSelector?: string;
    blockMedia?: boolean;
    locale?: string;
    timezoneId?: string;
    headers?: Record<string, string>;
    /** Optional field->selector map extracted verbatim from the DOM. */
    customSelector?: CustomSelectors;
}
/** Normalised page snapshot passed to category parsers. */
export interface PageSnapshot {
    requestedUrl: string;
    finalUrl: string;
    status: number;
    title: string;
    html: string;
    text: string;
    meta: Record<string, string>;
    jsonLd: unknown[];
    customSelectors: Record<string, Array<{
        text: string;
        href: string | null;
    }>>;
    fetchedAt: string;
    blockedRequests: number;
}
export declare class ScrapeError extends Error {
    readonly url: string;
    readonly status: number | null;
    constructor(message: string, url: string, status?: number | null, cause?: unknown);
}
/**
 * Playwright core wrapper: launches a stealthed headless Chromium context,
 * navigates with anti-bot headers, applies retries/timeouts and returns a
 * normalised snapshot for the category parsers.
 */
export declare class ScrapeEngine {
    private browser;
    private context;
    private ensureContext;
    /**
     * Launches a browser, preferring an already-installed Google Chrome
     * (no CDN download required) and falling back to Playwright's bundled
     * Chromium (installed via `npx playwright install chromium`).
     */
    private launchBrowser;
    /** Fetches a URL and returns a parser-ready snapshot. */
    scrape(url: string, options?: EngineOptions): Promise<PageSnapshot>;
    private navigateWithRetry;
    private buildSnapshot;
    /** Closes the underlying browser and context. */
    close(): Promise<void>;
}
