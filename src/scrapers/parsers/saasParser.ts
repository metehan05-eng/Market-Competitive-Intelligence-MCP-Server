import { load } from "cheerio";
import type { PageSnapshot } from "../engine.js";
import type { MetricValue, ParseResult, PricingPlan, SaasPricingPayload } from "../../types.js";
import { cleanText, detectPeriod, parseMoney, round2, textWithSpacing } from "./shared.js";

const PLAN_SELECTORS = [
  "[data-testid*='plan']",
  "[data-test*='plan']",
  "[class*='pricing-tier']",
  "[class*='pricingTier']",
  "[class*='plan-card']",
  "[class*='planCard']",
  "[class*='price-card']",
  ".pricing-table > div",
  ".plans > *",
  ".tier",
  "[class*='tier']",
  "[class*='plan']",
  "section[class*='pricing'] > div",
];

const PLAN_NAME_SELECTORS = [
  "h2", "h3", "h4",
  "[class*='name']",
  "[class*='title']",
  "[class*='plan-name']",
  "strong",
];

const PRICE_SELECTORS = [
  "[class*='price']",
  "[class*='amount']",
  "[data-testid*='price']",
  "[itemprop='price']",
];

const FEATURES_SELECTORS = [
  "ul li",
  "[class*='features'] li",
  "[class*='feature-list'] li",
  "[class*='feature'] li",
  "ul[class*='feature'] li",
];

const USER_LIMIT_RE = /\b(up to|max\.?|maximum|included|görünüm|kadar)?\s*(\d[\d.,]*)\s*\+?\s*(users?|seats?|members?|projects?|kullanıcı|kişi)\b/i;
const PER_MONTH_RE = /\b(\/\s*mo(?:nth)?|per month|monthly|aylık|\bp\/a\b)\b/i;
const PER_YEAR_RE = /\b(\/\s*yr|per year|annual(ly)?|yıllık)\b/i;
const CUSTOM_RE = /\b(custom|contact us|talk to sales|let's talk|ığtiar|özel fiyat|contact sales)\b/i;
const FREE_RE = /\b(free|ücretsiz|forever|0\s*[$₺€]\s*(?:\/\s*mo)?)\b/i;

function detectCurrency(text: string): string | null {
  const money = parseMoney(text);
  return money && money.currency !== "UNKNOWN" ? money.currency : null;
}

function extractPlansFromCards(snapshot: PageSnapshot): { plans: PricingPlan[]; notes: string[] } {
  const $ = load(snapshot.html);
  const notes: string[] = [];
  const plans: PricingPlan[] = [];
  const seen = new Set<string>();

  for (const selector of PLAN_SELECTORS) {
    let nodes: ReturnType<typeof $>;
    try {
      nodes = $(selector);
    } catch {
      continue;
    }

    nodes.each((_, el) => {
      // Skip ancestors that contain other matches (e.g. `.pricing-tiers`
      // wrapping `.pricing-tier` cards) so the innermost plan is parsed.
      const leaf = !$(el)
        .find(selector)
        .toArray()
        .some((descendant) => descendant !== el);
      if (!leaf) return;

      const node = $(el);
      const text = cleanText(node.text());
      // Spaced variant preserves word boundaries (cheerio.text() concatenates siblings).
      const spacedText = textWithSpacing(node.html() ?? "");
      if (text.length < 10 || text.length > 4000) return;

      const name = cleanText(
        PLAN_NAME_SELECTORS.map((s) => cleanText(node.find(s).first().text())).find(
          (t) => t.length >= 2 && t.length <= 60 && !/^\d/.test(t),
        ) ?? "",
      );
      if (!name) return;
      if (seen.has(name.toLowerCase())) return;

      let priceRaw = "";
      for (const priceSelector of PRICE_SELECTORS) {
        const candidate = cleanText(node.find(priceSelector).first().text());
        if (candidate && (/\d/.test(candidate) || FREE_RE.test(candidate) || CUSTOM_RE.test(candidate))) {
          priceRaw = candidate;
          break;
        }
      }

      let price: number | null = null;
      let currency = "USD";
      if (CUSTOM_RE.test(priceRaw) || (!priceRaw && CUSTOM_RE.test(spacedText))) {
        price = null;
      } else if (FREE_RE.test(priceRaw) || (!priceRaw && FREE_RE.test(spacedText))) {
        price = 0;
        currency = detectCurrency(spacedText) ?? "USD";
      } else if (priceRaw) {
        // Drop "up to 5 users" style clauses so the headline figure wins.
        const priceClean = priceRaw
          .replace(/\b(?:up to|max(?:imum)?|included|for)?\s*\d[\d.,]*\s*\+?\s*(?:users?|seats?|members?|projects?|kullanıcı|kişi)\b/gi, "")
          .replace(/\s*\/\s*up to\s*\d[\d.,]*\s*\+?\s*(?:users?|seats?|members?)\b/gi, "")
          .trim();
        const money = parseMoney(priceClean) ?? parseMoney(priceRaw.replace(/\b(?:up to|for)?\s*\d[\d.,]*\s*\+?\s*(?:users?|seats?)\b/gi, ""));
        if (money && money.min !== null) {
          price = money.min;
          currency = money.currency === "UNKNOWN" ? (detectCurrency(spacedText) ?? "USD") : money.currency;
        }
      }

      const features = FEATURES_SELECTORS.flatMap((s) => {
        try {
          return node
            .find(s)
            .toArray()
            .map((li) => cleanText($(li).text()))
            .filter((t) => t.length >= 3 && t.length <= 220);
        } catch {
          return [];
        }
      });
      const uniqueFeatures = [...new Set(features)].slice(0, 40);

      const limitMatch = spacedText.match(USER_LIMIT_RE);
      // Prefer the price element for billing period (feature lists often contain "/day").
      const periodText = priceRaw || spacedText;
      const detected = PER_MONTH_RE.test(periodText)
        ? "monthly"
        : PER_YEAR_RE.test(periodText)
          ? "yearly"
          : detectPeriod(periodText);
      const period = detected === "month" ? "monthly" : detected === "year" ? "yearly" : detected;

      // Skip non-plan containers that merely mention pricing words.
      if (price === null && uniqueFeatures.length === 0 && !CUSTOM_RE.test(spacedText)) return;

      seen.add(name.toLowerCase());
      plans.push({
        name,
        price,
        currency,
        period,
        userLimit: limitMatch ? cleanText(limitMatch[0]) : null,
        features: uniqueFeatures,
        highlighted: /\b(popular|recommended|best|önerilen|en popüler|featured)\b/i.test(spacedText),
      });
    });

    if (plans.length >= 2) break;
  }

  notes.push(`Plan container heuristic scan: ${plans.length} plan(s) found.`);
  return { plans, notes };
}

function extractPlansFromCustom(snapshot: PageSnapshot): PricingPlan[] {
  const plans: PricingPlan[] = [];
  for (const [field, entries] of Object.entries(snapshot.customSelectors)) {
    if (!["plans", "tiers", "packages"].includes(field)) continue;
    for (const entry of entries) {
      if (!entry.text) continue;
      const money = parseMoney(entry.text);
      plans.push({
        name: entry.text.slice(0, 60),
        price: money?.min ?? (FREE_RE.test(entry.text) ? 0 : null),
        currency: money && money.currency !== "UNKNOWN" ? money.currency : "USD",
        period: PER_YEAR_RE.test(entry.text) ? "yearly" : PER_MONTH_RE.test(entry.text) ? "monthly" : null,
        userLimit: entry.text.match(USER_LIMIT_RE)?.[0] ?? null,
        features: [],
        highlighted: false,
      });
    }
  }
  return plans;
}

/** Parses /pricing pages into tier structure intelligence (saas_pricing). */
export function parseSaas(snapshot: PageSnapshot): ParseResult {
  const notes: string[] = [];

  let plans = extractPlansFromCustom(snapshot);
  if (plans.length > 0) {
    notes.push(`Extracted via custom selectors: ${plans.length} plan(s).`);
  } else {
    const extracted = extractPlansFromCards(snapshot);
    plans = extracted.plans;
    notes.push(...extracted.notes);
  }

  if (plans.length === 0) {
    notes.push(
      "No pricing tiers matched known patterns. Provide customSelector (e.g. { plans: '.pricing-tier' }) to target this site's markup.",
    );
  }

  const priced = plans.filter((p) => typeof p.price === "number");
  const nonZeroPrices = priced.filter((p) => (p.price ?? 0) > 0).map((p) => p.price as number);
  const currencyCounts: Record<string, number> = {};
  for (const plan of priced) {
    currencyCounts[plan.currency] = (currencyCounts[plan.currency] ?? 0) + 1;
  }
  const currency =
    Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? priced[0]?.currency ?? "USD";

  const billingPeriod = plans.some((p) => p.period === "monthly")
    ? "monthly"
    : plans.some((p) => p.period === "yearly")
      ? "yearly"
      : null;

  const payload: SaasPricingPayload = {
    kind: "saas_pricing",
    plans,
    entryPrice: nonZeroPrices.length > 0 ? Math.min(...nonZeroPrices) : priced.length > 0 ? 0 : null,
    topPrice: nonZeroPrices.length > 0 ? Math.max(...nonZeroPrices) : null,
    currency,
    billingPeriod,
  };

  const totalFeatures = plans.reduce((sum, p) => sum + p.features.length, 0);

  const metrics: Record<string, MetricValue> = {
    planCount: plans.length,
    entryPrice: payload.entryPrice !== null ? round2(payload.entryPrice) : null,
    topPrice: payload.topPrice !== null ? round2(payload.topPrice) : null,
    paidPlanCount: nonZeroPrices.length,
    totalFeatures,
    freeTier: plans.some((p) => p.price === 0),
    currency,
    billingPeriod: billingPeriod ?? "unknown",
  };

  return { payload, metrics, notes };
}
