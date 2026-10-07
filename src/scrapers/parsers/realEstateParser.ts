import { load } from "cheerio";
import type { PageSnapshot } from "../engine.js";
import type { ListingPrice, ParseResult, RealEstateListing, RealEstatePayload } from "../../types.js";
import { cleanText, computePriceStats, countBy, parseMoney, round2, textWithSpacing } from "./shared.js";

const CARD_SELECTORS = [
  "[data-testid*='card']",
  "[data-test*='card']",
  "article[class*='listing']",
  "li[class*='listing']",
  "div[class*='listing']",
  "div[class*='property']",
  "div[class*='card']",
  ".search-result",
  ".result-card",
  ".pl-card",
  ".CardContainer",
  ".stay-card",
  ".property-card",
  ".sr-property-card",
  "li[class*='result']",
];

const TITLE_SELECTORS = ["[class*='title']", "[class*='name']", "h2", "h3", "h4", "a[href]"];
const PRICE_SELECTORS = [
  "[class*='price']",
  "[class*='rate']",
  "[class*='cost']",
  "[data-testid*='price']",
  "[itemprop='price']",
];
const LOCATION_SELECTORS = ["[class*='location']", "[class*='address']", "[class*='region']", "[class*='city']"];
const AVAILABILITY_SELECTORS = [
  "[class*='availability']",
  "[class*='status']",
  "[class*='badge']",
  "[class*='sold']",
  "[class*='rent']",
  "[class*='müsait']",
];

const AVAILABILITY_RULES: Array<{ key: string; re: RegExp }> = [
  { key: "available", re: /\b(available|in stock|müsait|uygun|book now|reserve|boş)\b/i },
  { key: "sold_out", re: /\b(sold out|unavailable|no availability|tükendi|dolu|fully booked|not available)\b/i },
  { key: "reserved", re: /\b(reserved|pending|rezerve|hold)\b/i },
  { key: "for_sale", re: /\b(for sale|satılık|satılıdır|listened|listing active)\b/i },
  { key: "for_rent", re: /\b(for rent|kiralık|kiraya verilir|rental)\b/i },
];

const PERIOD_RULES: Array<{ period: ListingPrice["period"]; re: RegExp }> = [
  { period: "night", re: /\b(night|gece|per night|\/ ?night|nightly)\b/i },
  { period: "month", re: /\b(month|ay|per month|monthly|aylık)\b/i },
  { period: "total", re: /\b(total|toplam|overall|whole stay|entire)\b/i },
];

function resolveUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function detectListingPeriod(text: string): ListingPrice["period"] {
  for (const rule of PERIOD_RULES) {
    if (rule.re.test(text)) return rule.period;
  }
  return null;
}

function detectAvailability(text: string): string | null {
  for (const rule of AVAILABILITY_RULES) {
    if (rule.re.test(text)) return rule.key;
  }
  return null;
}

function parseListingPrice(raw: string): ListingPrice | null {
  const money = parseMoney(raw);
  if (!money || money.min === null) return null;
  return {
    raw,
    min: money.min,
    max: money.max,
    currency: money.currency,
    period: detectListingPeriod(raw),
  };
}

function extractFromJsonLd(snapshot: PageSnapshot): RealEstateListing[] {
  const listings: RealEstateListing[] = [];
  const flatten = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(flatten);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj["@graph"]) flatten(obj["@graph"]);

    const type = String(obj["@type"] ?? "");
    const isListing =
      /LodgingBusiness|Accommodation|Apartment|House|Residence|RealEstateListing|Product|Offer/i.test(type);
    if (!isListing) return;

    const name = typeof obj["name"] === "string" ? cleanText(obj["name"]) : null;
    if (!name) return;

    const offers = obj["offers"];
    let price: ListingPrice | null = null;
    if (offers && typeof offers === "object") {
      const offer = Array.isArray(offers) ? (offers[0] as Record<string, unknown> | undefined) : (offers as Record<string, unknown>);
      const amount = offer?.["price"] ?? offer?.["lowPrice"];
      if (typeof amount === "string" || typeof amount === "number") {
        const raw = String(amount);
        const parsed = parseListingPrice(raw);
        const numeric = Number(raw);
        price = parsed ??
          (Number.isFinite(numeric)
            ? {
                raw,
                min: numeric,
                max: numeric,
                currency: String(offer?.["priceCurrency"] ?? "UNKNOWN"),
                period: null,
              }
            : null);
        if (price && typeof offer?.["priceCurrency"] === "string" && price.currency === "UNKNOWN") {
          price.currency = offer.priceCurrency;
        }
      }
    }

    const address = obj["address"];
    let location: string | null = null;
    if (typeof address === "string") {
      location = cleanText(address) || null;
    } else if (address && typeof address === "object") {
      const addr = address as Record<string, unknown>;
      const parts = [addr["addressLocality"], addr["addressRegion"], addr["streetAddress"]]
        .filter((v): v is string => typeof v === "string");
      location = cleanText(parts.join(", ")) || null;
    }

    listings.push({
      title: name,
      url: typeof obj["url"] === "string" ? obj["url"] : null,
      price,
      location,
      availability: typeof obj["availability"] === "string" ? obj["availability"] : null,
    });
  };

  snapshot.jsonLd.forEach(flatten);
  return listings;
}

function extractFromCards(snapshot: PageSnapshot): RealEstateListing[] {
  const $ = load(snapshot.html);
  const base = snapshot.finalUrl || snapshot.requestedUrl;
  const listings: RealEstateListing[] = [];
  const seen = new Set<string>();

  for (const selector of CARD_SELECTORS) {
    let nodes: ReturnType<typeof $>;
    try {
      nodes = $(selector);
    } catch {
      continue;
    }

    nodes.each((_, el) => {
      const node = $(el);
      const title = cleanText(
        TITLE_SELECTORS.map((s) => cleanText(node.find(s).first().text())).find((t) => t.length >= 6) ?? "",
      );
      if (!title || title.length > 220) return;

      let priceRaw = "";
      for (const selector of PRICE_SELECTORS) {
        const candidate = cleanText(node.find(selector).first().text());
        if (candidate && parseMoney(candidate)) {
          priceRaw = candidate;
          break;
        }
      }
      if (!priceRaw) return;

      const price = parseListingPrice(priceRaw);
      const location = cleanText(
        LOCATION_SELECTORS.map((s) => cleanText(node.find(s).first().text())).find((t) => t.length > 1) ?? "",
      ) || null;
      const availabilityRaw = cleanText(
        AVAILABILITY_SELECTORS.map((s) => cleanText(node.find(s).first().text())).find((t) => t.length > 1) ??
          textWithSpacing(node.html() ?? "", 600),
      );
      const href = node.find("a[href]").first().attr("href") ?? node.attr("href");
      const url = resolveUrl(href, base);

      const key = `${title.toLowerCase()}|${url ?? priceRaw}`;
      if (seen.has(key)) return;
      seen.add(key);

      listings.push({
        title,
        url,
        price,
        location,
        availability: detectAvailability(availabilityRaw) ?? (cleanText(availabilityRaw).slice(0, 60) || null),
      });
    });

    if (listings.length > 0) break;
  }

  return listings;
}

function extractFromCustom(snapshot: PageSnapshot): RealEstateListing[] {
  const listings: RealEstateListing[] = [];
  for (const [field, entries] of Object.entries(snapshot.customSelectors)) {
    if (!["listings", "cards", "items", "results"].includes(field)) continue;
    for (const entry of entries) {
      if (!entry.text) continue;
      const money = parseMoney(entry.text);
      listings.push({
        title: entry.text.slice(0, 200),
        url: resolveUrl(entry.href, snapshot.finalUrl || snapshot.requestedUrl),
        price: money ? { raw: entry.text, min: money.min, max: money.max, currency: money.currency, period: detectListingPeriod(entry.text) } : null,
        location: null,
        availability: detectAvailability(entry.text),
      });
    }
  }
  return listings;
}

/** Parses real-estate / hospitality listing pages into price & availability intelligence. */
export function parseRealEstate(snapshot: PageSnapshot): ParseResult {
  const notes: string[] = [];

  let listings = extractFromCustom(snapshot);
  if (listings.length > 0) {
    notes.push(`Extracted via custom selectors: ${listings.length} listing(s).`);
  }

  if (listings.length === 0) {
    const jsonLd = extractFromJsonLd(snapshot);
    listings = jsonLd;
    if (listings.length > 0) notes.push(`JSON-LD structured data: ${listings.length} listing(s).`);
  }

  if (listings.length === 0) {
    listings = extractFromCards(snapshot);
    notes.push(`Card heuristic scan: ${listings.length} listing(s) found.`);
    if (listings.length === 0) {
      notes.push(
        "No listings matched known portal patterns. Provide customSelector (e.g. { listings: '.property-card' }) to target this site's markup.",
      );
    }
  }

  const currencies = listings.map((l) => l.price?.currency).filter((c): c is string => !!c && c !== "UNKNOWN");
  const dominantCurrency = (countBy(currencies, (c) => c) as Record<string, number>);
  const currency =
    Object.entries(dominantCurrency).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const priceStats = computePriceStats(listings.map((l) => l.price?.min), currency);

  const payload: RealEstatePayload = {
    kind: "real_estate",
    listings,
    priceStats,
    availabilityBreakdown: countBy(
      listings.map((l) => l.availability ?? "unknown"),
      (a) => a,
    ),
  };

  const metrics: Record<string, number | string | null> = {
    listingCount: listings.length,
    avgPrice: priceStats.avg,
    minPrice: priceStats.min,
    maxPrice: priceStats.max,
    currency: priceStats.currency,
    availableCount: payload.availabilityBreakdown["available"] ?? 0,
    unavailableCount: (payload.availabilityBreakdown["sold_out"] ?? 0) + (payload.availabilityBreakdown["reserved"] ?? 0),
  };

  if (metrics["avgPrice"] !== null && typeof metrics["avgPrice"] === "number") {
    metrics["avgPrice"] = round2(metrics["avgPrice"]);
  }

  return { payload, metrics, notes };
}
