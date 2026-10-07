import { load } from "cheerio";
import { cleanText, computePriceStats, parseMoney, round2, textWithSpacing } from "./shared.js";
const PRODUCT_SELECTORS = [
    "[data-testid*='product-card']",
    "[data-test*='product']",
    "article[class*='product']",
    "li[class*='product']",
    "div[class*='product-card']",
    "div[class*='productCard']",
    ".product-item",
    ".product-tile",
    ".card-product",
    ".item-product",
    "[class*='ProductList'] > *",
    ".s-result-item[data-asin]",
    ".product",
];
const TITLE_SELECTORS = ["[class*='title']", "[class*='name']", "h2", "h3", "h4", "a[title]", "a[href]"];
const PRICE_SELECTORS = [
    "[data-testid*='price']",
    "[class*='price']",
    "[class*='amount']",
    "[itemprop='price']",
    "[class*='cost']",
];
const IN_STOCK_RE = /\b(in stock|available|stokta|mevcut|available for delivery|hemen teslim|satın al|add to cart|sepete ekle)\b/i;
const OUT_OF_STOCK_RE = /\b(out of stock|sold out|unavailable|stokta yok|tükendi|temin edilemiyor|notify me|gelecek)\b/i;
const CURRENCY_GUESS = [
    { re: /₺|TL\b/i, code: "TRY" },
    { re: /€/, code: "EUR" },
    { re: /£/, code: "GBP" },
    { re: /\$/, code: "USD" },
];
function guessCurrency(text) {
    for (const rule of CURRENCY_GUESS) {
        if (rule.re.test(text))
            return rule.code;
    }
    return null;
}
function extractFromJsonLd(snapshot) {
    const products = [];
    const walk = (node) => {
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (!node || typeof node !== "object")
            return;
        const obj = node;
        if (obj["@graph"])
            walk(obj["@graph"]);
        const type = String(obj["@type"] ?? "");
        if (!/Product/i.test(type))
            return;
        const name = typeof obj["name"] === "string" ? cleanText(obj["name"]) : null;
        if (!name)
            return;
        const offersRaw = obj["offers"];
        let price = null;
        let currency = "USD";
        let availability = null;
        const readOffer = (offer) => {
            if (!offer)
                return;
            const amount = offer["price"] ?? offer["lowPrice"];
            const numeric = typeof amount === "number" ? amount : Number.parseFloat(String(amount ?? ""));
            if (Number.isFinite(numeric))
                price = numeric;
            if (typeof offer["priceCurrency"] === "string")
                currency = offer.priceCurrency;
            if (typeof offer["availability"] === "string")
                availability = offer.availability;
        };
        if (Array.isArray(offersRaw))
            offersRaw.forEach((o) => readOffer(o));
        else if (offersRaw && typeof offersRaw === "object")
            readOffer(offersRaw);
        else
            readOffer(obj);
        const url = typeof obj["url"] === "string" ? obj["url"] : typeof obj["@id"] === "string" ? obj["@id"] : null;
        products.push({
            title: name,
            url,
            price,
            currency,
            inStock: availability ? /InStock/i.test(availability) : null,
            availability: availability ?? null,
        });
    };
    snapshot.jsonLd.forEach(walk);
    return products;
}
function extractFromCards(snapshot) {
    const $ = load(snapshot.html);
    const base = snapshot.finalUrl || snapshot.requestedUrl;
    const products = [];
    const seen = new Set();
    for (const selector of PRODUCT_SELECTORS) {
        let nodes;
        try {
            nodes = $(selector);
        }
        catch {
            continue;
        }
        nodes.each((_, el) => {
            const node = $(el);
            const title = cleanText(TITLE_SELECTORS.map((s) => cleanText(node.find(s).first().text())).find((t) => t.length >= 6) ??
                cleanText(node.attr("aria-label") ?? ""));
            if (!title || title.length > 300)
                return;
            let priceRaw = "";
            for (const priceSelector of PRICE_SELECTORS) {
                const candidate = cleanText(node.find(priceSelector).first().text());
                if (candidate && parseMoney(candidate)) {
                    priceRaw = candidate;
                    break;
                }
            }
            if (!priceRaw)
                return;
            const money = parseMoney(priceRaw);
            const nodeText = textWithSpacing(node.html() ?? "");
            const inStock = OUT_OF_STOCK_RE.test(nodeText)
                ? false
                : IN_STOCK_RE.test(nodeText)
                    ? true
                    : null;
            const href = node.find("a[href]").first().attr("href") ?? node.attr("href");
            let url = null;
            if (href) {
                try {
                    url = new URL(href, base).toString();
                }
                catch {
                    url = null;
                }
            }
            const key = `${title.toLowerCase()}|${url ?? priceRaw}`;
            if (seen.has(key))
                return;
            seen.add(key);
            products.push({
                title,
                url,
                price: money?.min ?? null,
                currency: money && money.currency !== "UNKNOWN" ? money.currency : guessCurrency(priceRaw) ?? "UNKNOWN",
                inStock,
                availability: inStock === null ? null : inStock ? "InStock" : "OutOfStock",
            });
        });
        if (products.length > 0)
            break;
    }
    return products;
}
function extractFromCustom(snapshot) {
    const products = [];
    for (const [field, entries] of Object.entries(snapshot.customSelectors)) {
        if (!["products", "items", "cards", "results"].includes(field))
            continue;
        for (const entry of entries) {
            if (!entry.text)
                continue;
            const money = parseMoney(entry.text);
            products.push({
                title: entry.text.slice(0, 300),
                url: (() => {
                    if (!entry.href)
                        return null;
                    try {
                        return new URL(entry.href, snapshot.finalUrl || snapshot.requestedUrl).toString();
                    }
                    catch {
                        return null;
                    }
                })(),
                price: money?.min ?? null,
                currency: money && money.currency !== "UNKNOWN" ? money.currency : guessCurrency(entry.text) ?? "UNKNOWN",
                inStock: OUT_OF_STOCK_RE.test(entry.text) ? false : IN_STOCK_RE.test(entry.text) ? true : null,
                availability: null,
            });
        }
    }
    return products;
}
/** Parses competitor storefronts into product price & stock intelligence (ecommerce). */
export function parseEcommerce(snapshot) {
    const notes = [];
    let products = extractFromCustom(snapshot);
    if (products.length > 0) {
        notes.push(`Extracted via custom selectors: ${products.length} product(s).`);
    }
    if (products.length === 0) {
        products = extractFromJsonLd(snapshot);
        if (products.length > 0)
            notes.push(`JSON-LD Product data: ${products.length} product(s).`);
    }
    if (products.length === 0) {
        products = extractFromCards(snapshot);
        notes.push(`Card heuristic scan: ${products.length} product(s) found.`);
        if (products.length === 0) {
            notes.push("No products matched known storefront patterns. Provide customSelector (e.g. { products: '.product-card' }) to target this site's markup.");
        }
    }
    const currencies = products.map((p) => p.currency).filter((c) => c && c !== "UNKNOWN");
    const currencyFreq = {};
    for (const code of currencies)
        currencyFreq[code] = (currencyFreq[code] ?? 0) + 1;
    const currency = Object.entries(currencyFreq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const priceStats = computePriceStats(products.map((p) => p.price), currency);
    const inStock = products.filter((p) => p.inStock === true).length;
    const outOfStock = products.filter((p) => p.inStock === false).length;
    const unknown = products.length - inStock - outOfStock;
    const payload = {
        kind: "ecommerce",
        products,
        priceStats,
        stockBreakdown: { inStock, outOfStock, unknown },
    };
    const metrics = {
        productCount: products.length,
        avgPrice: priceStats.avg !== null ? round2(priceStats.avg) : null,
        minPrice: priceStats.min,
        maxPrice: priceStats.max,
        inStockCount: inStock,
        outOfStockCount: outOfStock,
        currency: priceStats.currency,
    };
    return { payload, metrics, notes };
}
//# sourceMappingURL=ecommerceParser.js.map