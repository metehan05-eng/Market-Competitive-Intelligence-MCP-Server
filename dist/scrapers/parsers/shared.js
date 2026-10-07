/** Collapses whitespace and trims a string. */
export function cleanText(value) {
    return (value ?? "").replace(/\s+/g, " ").trim();
}
/**
 * Extracts readable text from an HTML fragment, inserting a space wherever a
 * tag boundary occurs. Unlike `cheerio.text()`, this preserves word boundaries
 * between "…$29.99" and "In Stock", so `\b…\b` regexes match reliably.
 */
export function textWithSpacing(html, max = 4000) {
    const text = (html ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#\d+;|&#x[0-9a-f]+;/gi, " ");
    return cleanText(text).slice(0, max);
}
/** Normalises an arbitrary label into a lowercase, dash-separated key. */
export function slugify(value) {
    return cleanText(value)
        .toLowerCase()
        .replace(/[^a-z0-9ğüşiöç]+/giu, "-")
        .replace(/^-+|-+$/g, "");
}
const CURRENCY_SYMBOLS = {
    "€": "EUR",
    $: "USD",
    "₺": "TRY",
    "£": "GBP",
    "¥": "JPY",
    "₹": "INR",
    "₽": "RUB",
    "zł": "PLN",
    "CHF": "CHF",
    "A$": "AUD",
    "C$": "CAD",
};
const CURRENCY_CODES = ["USD", "EUR", "GBP", "TRY", "JPY", "INR", "AUD", "CAD", "CHF", "PLN", "RUB", "SEK", "NOK", "BRL", "MXN"];
/**
 * Parses salary/price strings such as "$120,000 - $150,000", "10.000 ₺ - 15.000 ₺",
 * "€1.200,50" or "850 TL / night" into structured numeric ranges.
 */
export function parseMoney(raw) {
    const text = cleanText(raw);
    if (!text)
        return null;
    let currency = "UNKNOWN";
    for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
        if (text.includes(symbol)) {
            currency = code;
            break;
        }
    }
    if (currency === "UNKNOWN") {
        const upper = text.toUpperCase();
        for (const code of CURRENCY_CODES) {
            if (new RegExp(`\\b${code}\\b`).test(upper)) {
                currency = code;
                break;
            }
        }
    }
    const numberRe = /\d[\d.,\s\u00a0]*/g;
    const matches = text.match(numberRe);
    if (!matches)
        return null;
    const numbers = matches
        .map((m) => parseNumberToken(m))
        .filter((n) => n !== null && Number.isFinite(n) && n > 0);
    if (numbers.length === 0)
        return null;
    // Preserve written order (headline price first); swap only if actually reversed.
    let min = numbers[0];
    let max = numbers.length >= 2 ? numbers[1] : min;
    if (max < min) {
        const swap = min;
        min = max;
        max = swap;
    }
    return { min, max, currency };
}
/** Interprets a raw numeric token honouring US (1,234.56) and EU (1.234,56) conventions. */
function parseNumberToken(token) {
    // Space/NBSP act as thousand separators ("1 200,50") and are dropped directly.
    const digits = token.replace(/[^\d.,]/g, "");
    if (!/\d/.test(digits))
        return null;
    const hasComma = digits.includes(",");
    const hasDot = digits.includes(".");
    let normalised;
    if (hasComma && hasDot) {
        // The right-most separator is the decimal point; the other one groups thousands.
        const lastComma = digits.lastIndexOf(",");
        const lastDot = digits.lastIndexOf(".");
        normalised =
            lastComma > lastDot
                ? digits.replace(/\./g, "").replace(",", ".")
                : digits.replace(/,/g, "");
    }
    else if (hasComma || hasDot) {
        const separator = hasComma ? "," : ".";
        const parts = digits.split(separator);
        const repeated = parts.length > 2;
        const threeDigitTail = parts.length > 1 && (parts[parts.length - 1] ?? "").length === 3;
        // Repeated separators ("1.234.567") or a single 3-digit tail ("1,234" / "1.234")
        // are treated as thousand grouping; anything else is a decimal fraction.
        normalised = repeated || threeDigitTail ? digits.replace(/[.,]/g, "") : digits.replace(separator, ".");
    }
    else {
        normalised = digits;
    }
    const value = Number.parseFloat(normalised);
    return Number.isFinite(value) ? value : null;
}
const PERIOD_PATTERNS = [
    { re: /(?:^|\s|[-,(])per\s+hours?\b/i, period: "hour" },
    { re: /\/\s*(?:hr|hour|saat)\b/i, period: "hour" },
    { re: /\b(hourly|saatlik)\b/i, period: "hour" },
    { re: /(?:^|\s|[-,(])per\s+day\b/i, period: "day" },
    { re: /\/\s*(?:day|gün)\b/i, period: "day" },
    { re: /\b(daily|günlük)\b/i, period: "day" },
    { re: /(?:^|\s|[-,(])per\s+month\b/i, period: "month" },
    { re: /\/\s*(?:month|mo\b|ay)\b/i, period: "month" },
    { re: /\b(monthly|aylık)\b/i, period: "month" },
    { re: /(?:^|\s|[-,(])per\s+year\b/i, period: "year" },
    { re: /\/\s*(?:year|yr\.?|yıl)\b/i, period: "year" },
    { re: /\b(annual(?:ly)?|yıllık)\b/i, period: "year" },
];
/** Detects the pay period implied by a salary/price string. */
export function detectPeriod(text) {
    for (const { re, period } of PERIOD_PATTERNS) {
        if (re.test(text))
            return period;
    }
    return null;
}
export function computePriceStats(prices, currency) {
    const values = prices.filter((p) => typeof p === "number" && Number.isFinite(p));
    if (values.length === 0) {
        return { count: 0, min: null, max: null, avg: null, currency };
    }
    const sum = values.reduce((acc, v) => acc + v, 0);
    return {
        count: values.length,
        min: Math.round(Math.min(...values) * 100) / 100,
        max: Math.round(Math.max(...values) * 100) / 100,
        avg: Math.round((sum / values.length) * 100) / 100,
        currency,
    };
}
const STOPWORDS = new Set([
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has",
    "will", "can", "you", "your", "our", "their", "what", "when", "how", "why", "who", "all",
    "not", "but", "out", "get", "new", "now", "top", "best", "more", "than", "then", "them",
    "they", "she", "her", "his", "its", "into", "over", "only", "also", "some", "any", "each",
    "about", "after", "before", "there", "these", "those", "been", "being", "does", "did",
    "very", "just", "like", "make", "made", "take", "than", "too", "own", "same", "such",
    "other", "most", "many", "much", "here", "where", "while", "between", "under", "again",
    "against", "through", "during", "because", "until", "while", "http", "https", "www",
    "com", "html", "amp", "quot", "ve", "ll", "don", "t", "s", "re", "m", "d",
]);
/** Returns the top `limit` significant tokens from a text blob. */
export function keywordFrequency(text, limit = 10) {
    const counts = new Map();
    const tokens = cleanText(text)
        .toLowerCase()
        .split(/[^a-z0-9çğıöşü+#.]+/i)
        .map((t) => t.replace(/^\.+|\.+$/g, ""))
        .filter((t) => t.length >= 3 && t.length <= 30 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
    for (const token of tokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .filter(([, count]) => count > 1));
}
export function countBy(items, keyFn) {
    const out = {};
    for (const item of items) {
        const key = keyFn(item) || "unknown";
        out[key] = (out[key] ?? 0) + 1;
    }
    return out;
}
export function round2(value) {
    return Math.round(value * 100) / 100;
}
/** Safe JSON parse that returns null instead of throwing. */
export function safeJsonParse(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/** Formats a number for display in markdown tables (thousands separators). */
export function fmt(value) {
    if (value === null || value === undefined || !Number.isFinite(value))
        return "–";
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
//# sourceMappingURL=shared.js.map