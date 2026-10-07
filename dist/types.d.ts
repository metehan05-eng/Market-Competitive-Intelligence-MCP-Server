/**
 * Shared domain types for the Omni-Market & Competitive Intelligence MCP server.
 */
export declare const CATEGORIES: readonly ["hr_talent", "content_pr", "social_trends", "real_estate", "saas_pricing", "ecommerce"];
export type Category = (typeof CATEGORIES)[number];
export interface SalaryRange {
    raw: string;
    min: number | null;
    max: number | null;
    currency: string;
    period: "hour" | "day" | "month" | "year" | null;
}
export interface JobPosting {
    title: string;
    seniority: string;
    location: string | null;
    salary: SalaryRange | null;
    techStack: string[];
    url: string | null;
    postedAt: string | null;
}
export interface HrTalentPayload {
    kind: "hr_talent";
    jobs: JobPosting[];
    techStackFrequency: Record<string, number>;
    seniorityBreakdown: Record<string, number>;
}
export interface ContentArticle {
    title: string;
    url: string;
    publishedAt: string | null;
    summary: string | null;
    source: "blog" | "press" | "rss" | "generic";
}
export interface ContentPrPayload {
    kind: "content_pr";
    articles: ContentArticle[];
    source: "blog" | "rss" | "generic";
}
export type Sentiment = "positive" | "neutral" | "negative";
export interface SocialPost {
    title: string;
    url: string;
    publishedAt: string | null;
    engagement: number | null;
    sentiment: Sentiment;
}
export interface SocialTrendsPayload {
    kind: "social_trends";
    posts: SocialPost[];
    sentimentBreakdown: Record<Sentiment, number>;
    trendingKeywords: Record<string, number>;
    source: "rss" | "reddit" | "producthunt" | "generic";
}
export interface ListingPrice {
    raw: string;
    min: number | null;
    max: number | null;
    currency: string;
    period: "night" | "month" | "total" | null;
}
export interface RealEstateListing {
    title: string;
    url: string | null;
    price: ListingPrice | null;
    location: string | null;
    availability: string | null;
}
export interface RealEstatePayload {
    kind: "real_estate";
    listings: RealEstateListing[];
    priceStats: PriceStats;
    availabilityBreakdown: Record<string, number>;
}
export interface PricingPlan {
    name: string;
    price: number | null;
    currency: string;
    period: string | null;
    userLimit: string | null;
    features: string[];
    highlighted: boolean;
}
export interface SaasPricingPayload {
    kind: "saas_pricing";
    plans: PricingPlan[];
    entryPrice: number | null;
    topPrice: number | null;
    currency: string;
    billingPeriod: string | null;
}
export interface EcommerceProduct {
    title: string;
    url: string | null;
    price: number | null;
    currency: string;
    inStock: boolean | null;
    availability: string | null;
}
export interface EcommercePayload {
    kind: "ecommerce";
    products: EcommerceProduct[];
    priceStats: PriceStats;
    stockBreakdown: {
        inStock: number;
        outOfStock: number;
        unknown: number;
    };
}
/** Metric values persisted per event (used for cross-competitor comparison). */
export type MetricValue = number | string | boolean | null;
export type IntelligencePayload = HrTalentPayload | ContentPrPayload | SocialTrendsPayload | RealEstatePayload | SaasPricingPayload | EcommercePayload;
export interface PriceStats {
    count: number;
    min: number | null;
    max: number | null;
    avg: number | null;
    currency: string | null;
}
export interface CustomSelectorField {
    selector: string;
    attr?: string;
}
export type CustomSelectors = Record<string, string | CustomSelectorField>;
/** A single scraped event, as stored in SQLite. */
export interface IntelligenceEvent {
    id: number;
    createdAt: string;
    targetUrl: string;
    competitorName: string;
    category: Category;
    /** Raw JSON payload exactly as persisted. */
    payload: string;
    /** Compact JSON metric summary used for cross-competitor comparisons. */
    metrics: string;
}
export interface NewIntelligenceEvent {
    targetUrl: string;
    competitorName: string;
    category: Category;
    payload: IntelligencePayload;
    metrics: Record<string, MetricValue>;
}
/** Structured result returned by a category parser. */
export interface ParseResult {
    payload: IntelligencePayload;
    metrics: Record<string, MetricValue>;
    notes: string[];
}
export interface ScrapeRequest {
    url: string;
    competitorName: string;
    category: Category;
    customSelector?: CustomSelectors;
}
export interface QueryFilters {
    competitorName?: string;
    category?: Category;
    startDate?: string;
    endDate?: string;
    limit?: number;
}
export declare const CATEGORY_LABELS: Record<Category, string>;
