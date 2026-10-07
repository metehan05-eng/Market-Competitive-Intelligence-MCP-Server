import { load, type CheerioAPI } from "cheerio";
import type { PageSnapshot } from "../engine.js";
import type {
  ContentArticle,
  ContentPrPayload,
  ParseResult,
  Sentiment,
  SocialPost,
  SocialTrendsPayload,
} from "../../types.js";
import { cleanText, countBy, keywordFrequency } from "./shared.js";

const ARTICLE_LINK_SELECTORS = [
  "article a[href]",
  "a[href*='/blog/']",
  "a[href*='/news/']",
  "a[href*='/press']",
  "a[href*='/article/']",
  "a[href*='/haber']",
  "a[href*='/yazi']",
  ".post a[href]",
  ".blog-card a[href]",
  "[class*='post'] a[href]",
  "[class*='article'] a[href]",
];

const POSITIVE_WORDS = [
  "best", "great", "excellent", "amazing", "love", "win", "winner", "recommended", "impressive",
  "growth", "record", "breakthrough", "innovative", "successful", "powerful", "perfect", "awesome",
  "iyi", "harika", "başarılı", "ödüllü", "büyüme",
];
const NEGATIVE_WORDS = [
  "worst", "bad", "terrible", "hate", "fail", "failed", "failure", "scam", "broken", "bloat",
  "expensive", "disappointing", "down", "layoff", "lawsuit", "overpriced", "kötü", "sorun",
];

const POST_SELECTORS = [
  "shreddit-post",
  "article[data-testid='post-container']",
  "[class*='search-hintlist-content']",
  "div[class*='Post']",
  "article h3 a[href]",
  "article h2 a[href]",
  "[data-test='post-name']",
  "a[data-test='post-name']",
];

function toAbsoluteUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function extractJsonLdItems(snapshot: PageSnapshot): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (obj["headline"] || obj["articleBody"] || obj["datePublished"]) items.push(obj);
      if (obj["@graph"]) walk(obj["@graph"]);
    }
  };
  snapshot.jsonLd.forEach(walk);
  return items;
}

function extractArticlesFromHtml(snapshot: PageSnapshot): ContentArticle[] {
  const $ = load(snapshot.html);
  const base = snapshot.finalUrl || snapshot.requestedUrl;
  const siteHost = safeHost(base);
  const articles: ContentArticle[] = [];
  const seen = new Set<string>();

  const push = (title: string, href: string | null | undefined, publishedAt: string | null, summary: string | null): void => {
    const url = toAbsoluteUrl(href, base);
    if (!url) return;
    if (siteHost && !url.includes(siteHost) && !url.startsWith(base)) return;
    const key = url.split("#")[0] ?? url;
    if (seen.has(key)) return;
    const cleanTitle = cleanText(title);
    if (!cleanTitle || cleanTitle.length < 8) return;
    seen.add(key);
    articles.push({ title: cleanTitle, url, publishedAt, summary, source: classifySource(url) });
  };

  for (const selector of ARTICLE_LINK_SELECTORS) {
    let nodes: ReturnType<CheerioAPI>;
    try {
      nodes = $(selector);
    } catch {
      continue;
    }
    nodes.each((_, el) => {
      const node = $(el);
      const href = node.attr("href");
      const rawTitle = node.attr("title") || node.text() || node.find("h1,h2,h3,h4,[class*='title']").first().text();
      const title = cleanText(rawTitle);
      const container = node.closest("article, li, [class*='card'], [class*='post'], div");
      const timeText = cleanText(container.find("time, [class*='date'], [class*='published']").first().text());
      const summary = cleanText(container.find("p, [class*='excerpt'], [class*='summary']").first().text());
      push(title, href, timeText || null, summary || null);
    });
    if (articles.length > 0) break;
  }

  // JSON-LD articles carry authoritative titles/dates.
  for (const item of extractJsonLdItems(snapshot)) {
    const headline = typeof item["headline"] === "string" ? item["headline"] : null;
    const url = typeof item["url"] === "string" ? item["url"] : typeof item["mainEntityOfPage"] === "object" && item["mainEntityOfPage"] !== null
      ? String((item["mainEntityOfPage"] as Record<string, unknown>)["@id"] ?? "")
      : null;
    if (headline) {
      push(headline, url, typeof item["datePublished"] === "string" ? item["datePublished"] : null,
        typeof item["description"] === "string" ? item["description"].slice(0, 300) : null);
    }
  }

  return articles;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function classifySource(url: string): ContentArticle["source"] {
  if (/\/(blog|yazi|insights?)\//i.test(url)) return "blog";
  if (/\/(press|news|haber|bulten|release)\//i.test(url)) return "press";
  return "generic";
}

function parseRss(snapshot: PageSnapshot): { articles: ContentArticle[]; posts: SocialPost[] } {
  const articles: ContentArticle[] = [];
  const posts: SocialPost[] = [];
  const xml = snapshot.html.trim();
  if (!/<(rss|feed|atom:feed)/i.test(xml)) return { articles, posts };

  const $ = load(xml, { xml: true });
  const base = snapshot.finalUrl || snapshot.requestedUrl;
  const isAtom = $("feed").length > 0;

  const entries = isAtom ? $("feed > entry").toArray() : $("rss channel > item, channel > item").toArray();

  for (const entry of entries) {
    const node = $(entry);
    const title = cleanText(node.find("title").first().text());
    const link = isAtom
      ? node.find("link[rel='alternate']").attr("href") ?? node.find("link").first().text()
      : node.find("link").first().text();
    const published =
      cleanText(node.find("pubDate, updated, published, dc\\:date").first().text()) || null;
    const summary = cleanText(node.find("description, summary, content").first().text()).slice(0, 400) || null;
    const url = toAbsoluteUrl(link, base);
    if (!title || !url) continue;

    articles.push({
      title,
      url,
      publishedAt: published,
      summary,
      source: /rss|feed/.test(snapshot.requestedUrl) || /\.(xml|rss)(\?|$)/i.test(snapshot.requestedUrl) ? "rss" : "generic",
    });

    const commentsRaw = node.find("comments, [name='comments']").first().text();
    const comments = Number.parseInt(commentsRaw, 10);
    posts.push({
      title,
      url,
      publishedAt: published,
      engagement: Number.isFinite(comments) ? comments : null,
      sentiment: scoreSentiment(title),
    });
  }

  return { articles, posts };
}

function scoreSentiment(text: string): Sentiment {
  const lower = text.toLowerCase();
  let score = 0;
  for (const word of POSITIVE_WORDS) if (lower.includes(word)) score += 1;
  for (const word of NEGATIVE_WORDS) if (lower.includes(word)) score -= 1;
  if (score > 0) return "positive";
  if (score < 0) return "negative";
  return "neutral";
}

function parseSocialFeed(snapshot: PageSnapshot): SocialPost[] {
  const $ = load(snapshot.html);
  const base = snapshot.finalUrl || snapshot.requestedUrl;
  const posts: SocialPost[] = [];
  const seen = new Set<string>();

  let sourceHint: "reddit" | "producthunt" | "generic" = "generic";
  if (/reddit\.com|shreddit/i.test(snapshot.finalUrl + snapshot.html.slice(0, 4000))) sourceHint = "reddit";
  else if (/producthunt\.com/i.test(snapshot.finalUrl)) sourceHint = "producthunt";

  for (const selector of POST_SELECTORS) {
    let nodes: ReturnType<CheerioAPI>;
    try {
      nodes = $(selector);
    } catch {
      continue;
    }
    nodes.each((_, el) => {
      const node = $(el);
      const anchor = node.is("a") ? node : node.find("a[href]").first();
      const href = anchor.attr("href") ?? node.attr("href");
      const title = cleanText(
        node.attr("title") || node.attr("aria-label") || node.find("a[href], [class*='title'], h3, h2").first().text(),
      );
      const url = toAbsoluteUrl(href, base);
      if (!title || title.length < 8 || !url) return;
      if (seen.has(url)) return;
      seen.add(url);

      const rawScore =
        node.attr("score") ??
        node.find("[class*='score'], [class*='upvote'], [id*='upvotes']").first().text() ??
        "";
      const scoreMatch = rawScore.replace(/\s/g, "").match(/-?\d+/);
      const commentsMatch = node
        .find("[class*='comment'], [class*='discussion'], a[data-testid='comment-count']")
        .first()
        .text()
        .replace(/\s/g, "")
        .match(/\d+/);

      const engagementCandidates = [
        scoreMatch ? Number.parseInt(scoreMatch[0] as string, 10) : null,
        commentsMatch ? Number.parseInt(commentsMatch[0] as string, 10) : null,
      ].filter((n): n is number => n !== null);

      const timeRaw = cleanText(node.find("time, [class*='timestamp'], [datetime]").first().text()) || null;

      posts.push({
        title,
        url,
        publishedAt: timeRaw,
        engagement: engagementCandidates.length > 0 ? Math.max(...engagementCandidates) : null,
        sentiment: scoreSentiment(title),
      });
    });
    if (posts.length > 0) break;
  }

  if (posts.length === 0 && sourceHint === "generic") {
    // Fallback: treat article-style links as generic social/discussion mentions.
    for (const selector of ["article h2 a[href]", "article h3 a[href]", "h3 a[href]"]) {
      $(selector).each((_, el) => {
        const node = $(el);
        const title = cleanText(node.text());
        const url = toAbsoluteUrl(node.attr("href"), base);
        if (!title || title.length < 8 || !url || seen.has(url)) return;
        seen.add(url);
        posts.push({ title, url, publishedAt: null, engagement: null, sentiment: scoreSentiment(title) });
      });
      if (posts.length > 0) break;
    }
  }

  return posts;
}

/** Parses blog/PR pages into published-article intelligence (content_pr). */
export function parseContent(snapshot: PageSnapshot): ParseResult {
  const notes: string[] = [];
  const { articles } = parseRss(snapshot);
  let source: ContentPrPayload["source"] = "generic";

  if (articles.length > 0) {
    source = articles.some((a) => a.source === "rss") ? "rss" : "generic";
    notes.push(`RSS/Atom feed detected: ${articles.length} entries parsed.`);
  }

  if (articles.length === 0) {
    const htmlArticles = extractArticlesFromHtml(snapshot);
    articles.push(...htmlArticles);
    notes.push(`HTML heuristic scan: ${articles.length} article link(s) found.`);
    source = htmlArticles.some((a) => a.source === "blog") ? "blog" : "generic";
  }

  if (articles.length === 0) {
    notes.push(
      "No article links matched known blog/press patterns. Provide customSelector (e.g. { articles: '.blog-card a' }) to target this site's markup.",
    );
  }

  const payload: ContentPrPayload = { kind: "content_pr", articles, source };
  const metrics: Record<string, number | string | null> = {
    articleCount: articles.length,
    withDates: articles.filter((a) => a.publishedAt).length,
    blogLinks: articles.filter((a) => a.source === "blog").length,
    pressLinks: articles.filter((a) => a.source === "press").length,
    source,
  };

  return { payload, metrics, notes };
}

/** Parses ProductHunt/Reddit/RSS-style feeds into trend intelligence (social_trends). */
export function parseSocial(snapshot: PageSnapshot): ParseResult {
  const notes: string[] = [];
  const rss = parseRss(snapshot);
  let posts: SocialPost[] = rss.posts;
  let source: SocialTrendsPayload["source"] = "generic";

  if (posts.length > 0) {
    source = "rss";
    notes.push(`RSS feed detected: ${posts.length} post(s) parsed.`);
  }

  if (posts.length === 0) {
    posts = parseSocialFeed(snapshot);
    if (/producthunt\.com/i.test(snapshot.finalUrl)) source = "producthunt";
    else if (/reddit\.com/i.test(snapshot.finalUrl)) source = "reddit";
    notes.push(`Feed/link heuristic scan: ${posts.length} post(s) found (source: ${source}).`);
  }

  if (posts.length === 0) {
    notes.push(
      "No posts matched known feed patterns. Provide customSelector (e.g. { posts: 'article h3 a' }) or point at an RSS/Atom feed URL.",
    );
  }

  const sentimentBreakdown = countBy(posts, (p) => p.sentiment) as Record<Sentiment, number>;
  const payload: SocialTrendsPayload = {
    kind: "social_trends",
    posts,
    sentimentBreakdown: {
      positive: sentimentBreakdown.positive ?? 0,
      neutral: sentimentBreakdown.neutral ?? 0,
      negative: sentimentBreakdown.negative ?? 0,
    },
    trendingKeywords: keywordFrequency(posts.map((p) => p.title).join(" \n "), 12),
    source,
  };

  const metrics: Record<string, number | string | null> = {
    postCount: posts.length,
    positiveCount: payload.sentimentBreakdown.positive,
    negativeCount: payload.sentimentBreakdown.negative,
    avgEngagement:
      posts.filter((p) => p.engagement !== null).length > 0
        ? Math.round(
            (posts.reduce((sum, p) => sum + (p.engagement ?? 0), 0) /
              Math.max(posts.filter((p) => p.engagement !== null).length, 1)) * 100,
          ) / 100
        : null,
    topKeyword: Object.entries(payload.trendingKeywords).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    source,
  };

  return { payload, metrics, notes };
}
