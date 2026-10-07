import { CATEGORY_LABELS, CATEGORIES } from "./types.js";
import { queryEvents, insertEvent, queryOverview } from "./db/index.js";
import { ScrapeEngine } from "./scrapers/engine.js";
import { parseByCategory } from "./scrapers/parsers/index.js";
import { fmt, safeJsonParse } from "./scrapers/parsers/shared.js";
const PAYLOAD_JSON_BUDGET = 24_000;
/** Renders JSON, intelligently truncating large item arrays so tool output stays agent-friendly. */
export function renderJson(value, budget = PAYLOAD_JSON_BUDGET) {
    let text = JSON.stringify(value, null, 2);
    if (text.length <= budget)
        return text;
    const clone = JSON.parse(JSON.stringify(value));
    for (const [key, entry] of Object.entries(clone)) {
        if (Array.isArray(entry) && entry.length > 8) {
            clone[key] = [
                ...entry.slice(0, 8),
                { _truncated: true, omitted: entry.length - 8, note: "Increase limit via raw DB export for full list" },
            ];
            text = JSON.stringify(clone, null, 2);
            if (text.length <= budget)
                return text;
        }
    }
    text = JSON.stringify(clone);
    if (text.length <= budget)
        return text;
    return `${text.slice(0, budget)}\n.../* output truncated at ${budget} chars */`;
}
function parsePayload(event) {
    return safeJsonParse(event.payload);
}
function parseMetrics(event) {
    return safeJsonParse(event.metrics) ?? {};
}
/** Core scrape workflow: fetch → parse → persist → format. */
export async function runScrape(request) {
    const engine = new ScrapeEngine();
    let snapshot;
    try {
        snapshot = await engine.scrape(request.url, {
            timeoutMs: 30_000,
            customSelector: request.customSelector,
        });
    }
    finally {
        await engine.close();
    }
    const result = parseByCategory(request.category, snapshot);
    const eventId = await insertEvent({
        targetUrl: snapshot.finalUrl || request.url,
        competitorName: request.competitorName,
        category: request.category,
        payload: result.payload,
        metrics: result.metrics,
    });
    const lines = [];
    lines.push(`# Scrape Result - ${request.competitorName} [${request.category}]`);
    lines.push("");
    lines.push(`- **Target URL:** ${snapshot.finalUrl || snapshot.requestedUrl}`);
    lines.push(`- **HTTP status:** ${snapshot.status || "n/a"}`);
    lines.push(`- **Page title:** ${snapshot.title || "(none)"}`);
    lines.push(`- **Fetched at:** ${snapshot.fetchedAt}`);
    lines.push(`- **Stored event id:** ${eventId}`);
    if (snapshot.blockedRequests > 0) {
        lines.push(`- **Blocked media requests:** ${snapshot.blockedRequests} (speed optimisation)`);
    }
    lines.push("");
    lines.push("## Metric Summary");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    for (const [key, value] of Object.entries(result.metrics)) {
        lines.push(`| ${key} | ${value === null ? "–" : String(value)} |`);
    }
    if (Object.keys(result.metrics).length === 0)
        lines.push("| (none) | – |");
    lines.push("");
    if (result.notes.length > 0) {
        lines.push("## Parser Notes");
        for (const note of result.notes)
            lines.push(`- ${note}`);
        lines.push("");
    }
    lines.push("## Structured Payload");
    lines.push("");
    lines.push("```json");
    lines.push(renderJson(result.payload));
    lines.push("```");
    return lines.join("\n");
}
function diffMetrics(older, newer) {
    const changes = [];
    for (const key of Object.keys(newer)) {
        const before = older[key];
        const after = newer[key];
        if (before === undefined || before === after)
            continue;
        if (typeof before === "number" && typeof after === "number") {
            const delta = Math.round((after - before) * 100) / 100;
            const sign = delta > 0 ? "+" : "";
            changes.push(`${key}: ${fmt(before)} -> ${fmt(after)} (${sign}${fmt(delta)})`);
        }
        else {
            changes.push(`${key}: ${String(before)} -> ${String(after)}`);
        }
    }
    return changes;
}
function diffPayloads(category, older, newer) {
    const changes = [];
    if (category === "hr_talent" && older.kind === "hr_talent" && newer.kind === "hr_talent") {
        const oldTech = new Set(Object.keys(older.techStackFrequency));
        const newTech = new Set(Object.keys(newer.techStackFrequency));
        const added = [...newTech].filter((t) => !oldTech.has(t));
        const removed = [...oldTech].filter((t) => !newTech.has(t));
        if (added.length > 0)
            changes.push(`Tech stack additions: ${added.join(", ")}`);
        if (removed.length > 0)
            changes.push(`Tech stack drops: ${removed.join(", ")}`);
        const oldTitles = new Set(older.jobs.map((j) => j.title.toLowerCase()));
        const fresh = newer.jobs.filter((j) => !oldTitles.has(j.title.toLowerCase()));
        if (fresh.length > 0) {
            const preview = fresh.slice(0, 6).map((j) => j.title);
            changes.push(`New job postings (${fresh.length}): ${preview.join(" | ")}${fresh.length > 6 ? " | ..." : ""}`);
        }
    }
    if (category === "saas_pricing" && older.kind === "saas_pricing" && newer.kind === "saas_pricing") {
        const oldPlans = new Map(older.plans.map((p) => [p.name.toLowerCase(), p]));
        const newPlans = new Map(newer.plans.map((p) => [p.name.toLowerCase(), p]));
        for (const [name, plan] of newPlans) {
            const prev = oldPlans.get(name);
            if (!prev) {
                changes.push(`New plan added: ${plan.name} (${plan.price ?? "custom"} ${plan.currency})`);
                continue;
            }
            if (prev.price !== plan.price) {
                changes.push(`Plan ${plan.name} price: ${prev.price ?? "n/a"} -> ${plan.price ?? "n/a"} ${plan.currency}`);
            }
            const addedFeatures = plan.features.filter((f) => !prev.features.includes(f));
            if (addedFeatures.length > 0) {
                changes.push(`Plan ${plan.name} feature additions: ${addedFeatures.slice(0, 5).join(", ")}`);
            }
        }
        for (const name of oldPlans.keys()) {
            if (!newPlans.has(name))
                changes.push(`Plan removed: ${name}`);
        }
    }
    if (category === "content_pr" && older.kind === "content_pr" && newer.kind === "content_pr") {
        const oldUrls = new Set(older.articles.map((a) => a.url));
        const fresh = newer.articles.filter((a) => !oldUrls.has(a.url));
        if (fresh.length > 0) {
            const preview = fresh.slice(0, 5).map((a) => `"${a.title}"`);
            changes.push(`New articles (${fresh.length}): ${preview.join(", ")}${fresh.length > 5 ? ", ..." : ""}`);
        }
    }
    if (category === "ecommerce" && older.kind === "ecommerce" && newer.kind === "ecommerce") {
        const oldPrices = new Map(older.products.map((p) => [p.title.toLowerCase(), p.price]));
        let priceMoves = 0;
        const examples = [];
        for (const product of newer.products) {
            const before = oldPrices.get(product.title.toLowerCase());
            if (before !== undefined && before !== null && product.price !== null && before !== product.price) {
                priceMoves += 1;
                if (examples.length < 5) {
                    examples.push(`${product.title.slice(0, 40)}: ${fmt(before)} -> ${fmt(product.price)}`);
                }
            }
        }
        if (priceMoves > 0)
            changes.push(`Price changes detected (${priceMoves}): ${examples.join("; ")}`);
        const out = newer.products.filter((p) => p.inStock === false).length;
        const prevOut = older.products.filter((p) => p.inStock === false).length;
        if (out !== prevOut)
            changes.push(`Out-of-stock products: ${prevOut} -> ${out}`);
    }
    if (category === "real_estate" && older.kind === "real_estate" && newer.kind === "real_estate") {
        if (older.priceStats.avg !== null && newer.priceStats.avg !== null && older.priceStats.avg !== newer.priceStats.avg) {
            const delta = Math.round((newer.priceStats.avg - older.priceStats.avg) * 100) / 100;
            changes.push(`Average asking price: ${fmt(older.priceStats.avg)} -> ${fmt(newer.priceStats.avg)} (${delta > 0 ? "+" : ""}${fmt(delta)})`);
        }
        const oldTitles = new Set(older.listings.map((l) => l.title.toLowerCase()));
        const fresh = newer.listings.filter((l) => !oldTitles.has(l.title.toLowerCase()));
        if (fresh.length > 0)
            changes.push(`New listings: ${fresh.length}`);
        const gone = older.listings.filter((l) => !new Set(newer.listings.map((x) => x.title.toLowerCase())).has(l.title.toLowerCase()));
        if (gone.length > 0)
            changes.push(`Listings removed/off-market: ${gone.length}`);
    }
    if (category === "social_trends" && older.kind === "social_trends" && newer.kind === "social_trends") {
        const oldTitles = new Set(older.posts.map((p) => p.title.toLowerCase()));
        const fresh = newer.posts.filter((p) => !oldTitles.has(p.title.toLowerCase()));
        if (fresh.length > 0)
            changes.push(`New trending posts: ${fresh.length}`);
        const topOld = Object.entries(older.trendingKeywords)[0]?.[0];
        const topNew = Object.entries(newer.trendingKeywords)[0]?.[0];
        if (topOld && topNew && topOld !== topNew)
            changes.push(`Top keyword shift: ${topOld} -> ${topNew}`);
    }
    return changes;
}
/** Queries the intelligence ledger and renders a historic trend report. */
export async function runHistory(filters) {
    const category = filters.category;
    const events = await queryEvents({
        competitorName: filters.competitorName,
        category,
        startDate: filters.startDate,
        limit: filters.limit ?? 100,
    });
    const lines = [];
    lines.push(`# Intelligence History`);
    lines.push("");
    lines.push(`- Filters: competitor=${filters.competitorName ?? "any"}, category=${filters.category ?? "any"}, since=${filters.startDate ?? "beginning"}, limit=${filters.limit ?? 100}`);
    lines.push(`- Matching events: **${events.length}**`);
    lines.push("");
    if (events.length === 0) {
        lines.push("No stored events matched. Run `scrape_competitor_target` first, or widen the filters.");
        return lines.join("\n");
    }
    // Group newest-first result set by competitor+category.
    const groups = new Map();
    for (const event of events) {
        const key = `${event.competitorName}::${event.category}`;
        const group = groups.get(key) ?? { competitor: event.competitorName, category: event.category, events: [] };
        group.events.push(event);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        lines.push(`## ${group.competitor} - ${CATEGORY_LABELS[group.category]}`);
        lines.push("");
        // Oldest first for change tracking.
        const ordered = [...group.events].reverse();
        let previous = null;
        for (const event of ordered) {
            lines.push(`### ${event.createdAt} (event #${event.id})`);
            lines.push(`- Source: ${event.targetUrl}`);
            const metrics = parseMetrics(event);
            const metricText = Object.entries(metrics)
                .map(([k, v]) => `${k}=${v === null ? "–" : String(v)}`)
                .join(", ");
            if (metricText)
                lines.push(`- Metrics: ${metricText}`);
            if (previous) {
                const changes = [
                    ...diffMetrics(parseMetrics(previous), metrics),
                    (() => {
                        const olderPayload = parsePayload(previous);
                        const newerPayload = parsePayload(event);
                        if (!olderPayload || !newerPayload)
                            return [];
                        return diffPayloads(group.category, olderPayload, newerPayload);
                    })(),
                ].flat();
                if (changes.length > 0) {
                    lines.push("- **Change vs previous snapshot:**");
                    for (const change of changes)
                        lines.push(`  - ${change}`);
                }
                else {
                    lines.push("- No material change vs previous snapshot.");
                }
            }
            const payload = parsePayload(event);
            if (payload) {
                lines.push("- Snapshot:");
                lines.push("  ```json");
                for (const row of renderJson(payload, 9_000).split("\n"))
                    lines.push(`  ${row}`);
                lines.push("  ```");
            }
            lines.push("");
            previous = event;
        }
    }
    return lines.join("\n");
}
const COMPARE_COLUMNS = {
    hr_talent: [
        { key: "jobCount", label: "Jobs" },
        { key: "uniqueTechCount", label: "Techs" },
        { key: "seniorRoleCount", label: "Senior+" },
        { key: "rolesWithSalary", label: "W/ Salary" },
        { key: "avgMinSalary", label: "Avg Min Salary" },
    ],
    content_pr: [
        { key: "articleCount", label: "Articles" },
        { key: "withDates", label: "Dated" },
        { key: "blogLinks", label: "Blog" },
        { key: "pressLinks", label: "Press" },
    ],
    social_trends: [
        { key: "postCount", label: "Posts" },
        { key: "positiveCount", label: "Positive" },
        { key: "negativeCount", label: "Negative" },
        { key: "avgEngagement", label: "Avg Engagement" },
        { key: "topKeyword", label: "Top Keyword" },
    ],
    real_estate: [
        { key: "listingCount", label: "Listings" },
        { key: "avgPrice", label: "Avg Price" },
        { key: "minPrice", label: "Min" },
        { key: "maxPrice", label: "Max" },
        { key: "availableCount", label: "Available" },
    ],
    saas_pricing: [
        { key: "planCount", label: "Plans" },
        { key: "paidPlanCount", label: "Paid" },
        { key: "entryPrice", label: "Entry" },
        { key: "topPrice", label: "Top" },
        { key: "currency", label: "CCY" },
        { key: "billingPeriod", label: "Billing" },
    ],
    ecommerce: [
        { key: "productCount", label: "Products" },
        { key: "avgPrice", label: "Avg Price" },
        { key: "minPrice", label: "Min" },
        { key: "maxPrice", label: "Max" },
        { key: "inStockCount", label: "In Stock" },
        { key: "currency", label: "CCY" },
    ],
};
const PRIMARY_METRIC = {
    hr_talent: "jobCount",
    content_pr: "articleCount",
    social_trends: "postCount",
    real_estate: "listingCount",
    saas_pricing: "entryPrice",
    ecommerce: "avgPrice",
};
function cell(value) {
    if (value === null || value === undefined || value === "")
        return "–";
    if (typeof value === "number")
        return fmt(value);
    return String(value);
}
/** Generates a comparative Markdown summary across competitors for one category. */
export async function runCompare(category, competitorList) {
    const wanted = competitorList.map((c) => c.trim()).filter(Boolean);
    const all = await queryEvents({ category, limit: 1000 });
    const wantedSet = new Set(wanted.map((c) => c.toLowerCase()));
    const relevant = all.filter((e) => wantedSet.has(e.competitorName.toLowerCase()));
    const byCompetitor = new Map();
    for (const event of relevant) {
        const key = event.competitorName;
        const list = byCompetitor.get(key) ?? [];
        list.push(event);
        byCompetitor.set(key, list);
    }
    const columns = COMPARE_COLUMNS[category];
    const primary = PRIMARY_METRIC[category];
    const lines = [];
    lines.push(`# Competitor Comparison - ${CATEGORY_LABELS[category]}`);
    lines.push("");
    lines.push(`Competitors requested: ${wanted.join(", ")}`);
    lines.push("");
    const header = ["Competitor", ...columns.map((c) => c.label), "Δ primary", "Snapshots", "Last seen"];
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`| ${header.map(() => "---").join(" | ")} |`);
    const rows = [];
    const detailSections = [];
    for (const name of wanted) {
        const events = byCompetitor.get(name) ??
            [...byCompetitor.entries()].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ??
            [];
        if (events.length === 0) {
            rows.push(`| ${name} | ${columns.map(() => "–").join(" | ")} | – | 0 | no data |`);
            continue;
        }
        // queryEvents returns newest-first; entries[0] is the latest snapshot.
        const sorted = [...events].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
        const latest = sorted[0];
        const previous = sorted[1];
        const latestMetrics = parseMetrics(latest);
        const previousMetrics = previous ? parseMetrics(previous) : null;
        const cells = columns.map((column) => cell(latestMetrics[column.key]));
        let delta = "–";
        if (previousMetrics) {
            const before = previousMetrics[primary];
            const after = latestMetrics[primary];
            if (typeof before === "number" && typeof after === "number") {
                const d = Math.round((after - before) * 100) / 100;
                delta = d === 0 ? "0" : `${d > 0 ? "+" : ""}${fmt(d)}`;
            }
            else if (before !== after) {
                delta = `${String(before ?? "–")} -> ${String(after ?? "–")}`;
            }
            else {
                delta = "0";
            }
        }
        rows.push(`| ${name} | ${cells.join(" | ")} | ${delta} | ${sorted.length} | ${latest.createdAt.slice(0, 19)}Z |`);
        const payload = parsePayload(latest);
        const details = [];
        if (payload) {
            if (payload.kind === "hr_talent") {
                const topTech = Object.entries(payload.techStackFrequency)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([tech, count]) => `${tech} (${count})`);
                if (topTech.length > 0)
                    details.push(`- **Tech focus:** ${topTech.join(", ")}`);
                const seniority = Object.entries(payload.seniorityBreakdown)
                    .map(([level, count]) => `${level}: ${count}`)
                    .join(", ");
                if (seniority)
                    details.push(`- **Seniority mix:** ${seniority}`);
            }
            if (payload.kind === "saas_pricing") {
                details.push(`- **Plans:** ${payload.plans.map((p) => `${p.name} (${p.price ?? "custom"})`).join(", ")}`);
            }
            if (payload.kind === "social_trends") {
                const keywords = Object.entries(payload.trendingKeywords)
                    .slice(0, 8)
                    .map(([k, v]) => `${k} (${v})`);
                if (keywords.length > 0)
                    details.push(`- **Trending keywords:** ${keywords.join(", ")}`);
                details.push(`- **Sentiment:** ${payload.sentimentBreakdown.positive} positive / ${payload.sentimentBreakdown.neutral} neutral / ${payload.sentimentBreakdown.negative} negative`);
            }
            if (payload.kind === "content_pr") {
                const recent = payload.articles.slice(0, 3).map((a) => `"${a.title}"`);
                if (recent.length > 0)
                    details.push(`- **Latest content:** ${recent.join(", ")}`);
            }
            if (payload.kind === "real_estate" || payload.kind === "ecommerce") {
                const stockish = payload.kind === "real_estate" ? payload.availabilityBreakdown : null;
                if (stockish)
                    details.push(`- **Availability:** ${Object.entries(stockish).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
                if (payload.kind === "ecommerce") {
                    details.push(`- **Stock:** ${payload.stockBreakdown.inStock} in stock / ${payload.stockBreakdown.outOfStock} out of stock / ${payload.stockBreakdown.unknown} unknown`);
                }
            }
            if (details.length > 0)
                detailSections.push(`### ${name}\n${details.join("\n")}`);
        }
    }
    lines.push(...rows);
    lines.push("");
    const missing = wanted.filter((name) => !byCompetitor.has(name) && ![...byCompetitor.keys()].some((k) => k.toLowerCase() === name.toLowerCase()));
    if (missing.length > 0) {
        lines.push(`> No stored snapshots yet for: ${missing.join(", ")}. Run \`scrape_competitor_target\` for each to populate the ledger.`);
        lines.push("");
    }
    if (detailSections.length > 0) {
        lines.push("## Category Deep-Dive");
        lines.push("");
        lines.push(...detailSections, "");
    }
    lines.push(`_Δ primary = change in \`${primary}\` vs previous snapshot. Data sourced from the local SQLite ledger._`);
    return lines.join("\n");
}
/** Lightweight overview used by tests and diagnostics. */
export async function runOverview() {
    const rows = await queryOverview();
    const lines = ["# Intelligence Ledger Overview", ""];
    if (rows.length === 0) {
        lines.push("Ledger is empty - run `scrape_competitor_target` to record the first event.");
        return lines.join("\n");
    }
    lines.push("| Competitor | Category | Events | Last seen |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of rows) {
        lines.push(`| ${row.competitor_name} | ${row.category} | ${row.event_count} | ${row.last_seen} |`);
    }
    return lines.join("\n");
}
export { CATEGORIES };
//# sourceMappingURL=tools.js.map