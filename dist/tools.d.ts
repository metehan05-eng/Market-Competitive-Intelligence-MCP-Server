import { CATEGORIES, type Category, type ScrapeRequest } from "./types.js";
/** Renders JSON, intelligently truncating large item arrays so tool output stays agent-friendly. */
export declare function renderJson(value: unknown, budget?: number): string;
/** Core scrape workflow: fetch → parse → persist → format. */
export declare function runScrape(request: ScrapeRequest): Promise<string>;
/** Queries the intelligence ledger and renders a historic trend report. */
export declare function runHistory(filters: {
    competitorName?: string;
    category?: string;
    startDate?: string;
    limit?: number;
}): Promise<string>;
/** Generates a comparative Markdown summary across competitors for one category. */
export declare function runCompare(category: Category, competitorList: string[]): Promise<string>;
/** Lightweight overview used by tests and diagnostics. */
export declare function runOverview(): Promise<string>;
export { CATEGORIES };
