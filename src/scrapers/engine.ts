import type { Browser, BrowserContext, Page, Response } from "playwright";
import type { CustomSelectors, CustomSelectorField } from "../types.js";
import { cleanText } from "./parsers/shared.js";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_TIMEOUT_MS = 30_000;
const NAVIGATION_RETRIES = 2;
const SETTLE_DELAY_MS = 750;

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
  customSelectors: Record<string, Array<{ text: string; href: string | null }>>;
  fetchedAt: string;
  blockedRequests: number;
}

export class ScrapeError extends Error {
  public readonly url: string;
  public readonly status: number | null;

  constructor(message: string, url: string, status: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ScrapeError";
    this.url = url;
    this.status = status;
  }
}

const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  if (!window.chrome) { window.chrome = { runtime: {} }; }
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters && parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);
`;

function buildHeaders(locale: string): Record<string, string> {
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": `${locale},${locale.split("-")[0] ?? "en"};q=0.9,en;q=0.8`,
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
}

/**
 * Playwright core wrapper: launches a stealthed headless Chromium context,
 * navigates with anti-bot headers, applies retries/timeouts and returns a
 * normalised snapshot for the category parsers.
 */
export class ScrapeEngine {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  private async ensureContext(options: EngineOptions): Promise<BrowserContext> {
    const locale = options.locale ?? "en-US";
    const timezoneId = options.timezoneId ?? "Europe/Istanbul";

    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await this.launchBrowser();
    }

    if (this.context) {
      return this.context;
    }

    this.context = await this.browser.newContext({
      userAgent: DEFAULT_USER_AGENT,
      viewport: { width: 1440, height: 900 },
      locale,
      timezoneId,
      javaScriptEnabled: true,
      extraHTTPHeaders: { ...buildHeaders(locale), ...(options.headers ?? {}) },
      bypassCSP: false,
      colorScheme: "light",
    });

    await this.context.addInitScript(STEALTH_INIT_SCRIPT);
    return this.context;
  }

  /**
   * Launches a browser, preferring an already-installed Google Chrome
   * (no CDN download required) and falling back to Playwright's bundled
   * Chromium (installed via `npx playwright install chromium`).
   */
  private async launchBrowser(): Promise<Browser> {
    const { chromium } = await import("playwright");
    const launchOptions = {
      headless: true as const,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
      ],
    };

    const attempts: Array<() => Promise<Browser>> = [
      () => chromium.launch({ ...launchOptions, channel: "chrome" }),
      () => chromium.launch(launchOptions),
    ];

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ScrapeError(
      "No browser available. Install Google Chrome or run `npx playwright install chromium`. " +
        `Launch error: ${detail}`,
      "",
      null,
      lastError,
    );
  }

  /** Fetches a URL and returns a parser-ready snapshot. */
  async scrape(url: string, options: EngineOptions = {}): Promise<PageSnapshot> {
    const timeout = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5_000), 120_000);
    const context = await this.ensureContext(options);
    const page = await context.newPage();

    let blockedRequests = 0;
    if (options.blockMedia !== false) {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font") {
          blockedRequests += 1;
          void route.abort().catch(() => undefined);
        } else {
          void route.continue().catch(() => undefined);
        }
      });
    }

    try {
      const response = await this.navigateWithRetry(page, url, timeout);

      if (options.waitSelector) {
        await page
          .waitForSelector(options.waitSelector, { timeout: Math.min(timeout, 10_000), state: "attached" })
          .catch(() => undefined);
      }

      if (SETTLE_DELAY_MS > 0) {
        await page.waitForTimeout(SETTLE_DELAY_MS);
      }

      const snapshot = await this.buildSnapshot(page, url, response, options.customSelector);
      snapshot.blockedRequests = blockedRequests;
      return snapshot;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async navigateWithRetry(page: Page, url: string, timeout: number): Promise<Response | null> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= NAVIGATION_RETRIES; attempt++) {
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        if (response && response.status() >= 500) {
          throw new ScrapeError(`Upstream server error (HTTP ${response.status()})`, url, response.status());
        }
        if (response && response.status() === 429) {
          throw new ScrapeError("Rate limited by target site (HTTP 429)", url, 429);
        }
        return response;
      } catch (error) {
        lastError = error;
        if (error instanceof ScrapeError && error.status !== null && error.status < 500 && error.status !== 429) {
          break;
        }
        if (attempt < NAVIGATION_RETRIES) {
          await page.waitForTimeout(1_000 * attempt);
        }
      }
    }

    if (lastError instanceof ScrapeError) throw lastError;
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ScrapeError(`Navigation failed for ${url}: ${message}`, url, null, lastError);
  }

  private async buildSnapshot(
    page: Page,
    requestedUrl: string,
    response: Response | null,
    customSelector?: CustomSelectors,
  ): Promise<PageSnapshot> {
    const extracted = await page.evaluate(() => {
      const meta: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("meta[name], meta[property]"))) {
        const key = el.getAttribute("name") ?? el.getAttribute("property");
        const content = el.getAttribute("content");
        if (key && content) meta[key] = content;
      }

      const jsonLd: unknown[] = [];
      for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        const raw = el.textContent ?? "";
        if (!raw.trim()) continue;
        try {
          jsonLd.push(JSON.parse(raw));
        } catch {
          // Ignore malformed structured data blocks.
        }
      }

      return {
        title: document.title ?? "",
        html: document.documentElement?.outerHTML ?? "",
        text: document.body?.innerText ?? "",
        meta,
        jsonLd,
      };
    });

    const customSelectors = customSelector
      ? await extractCustomSelectors(page, customSelector)
      : {};

    return {
      requestedUrl,
      finalUrl: page.url(),
      status: response?.status() ?? 0,
      title: cleanText(extracted.title),
      html: extracted.html,
      text: extracted.text,
      meta: extracted.meta,
      jsonLd: extracted.jsonLd,
      customSelectors,
      fetchedAt: new Date().toISOString(),
      blockedRequests: 0,
    };
  }

  /** Closes the underlying browser and context. */
  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.context = null;
    this.browser = null;
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
}

async function extractCustomSelectors(
  page: Page,
  selectors: CustomSelectors,
): Promise<Record<string, Array<{ text: string; href: string | null }>>> {
  const entries = Object.entries(selectors).map(([field, raw]) => {
    const config: CustomSelectorField = typeof raw === "string" ? { selector: raw } : raw;
    return { field, selector: config.selector, attr: config.attr ?? "" };
  });

  if (entries.length === 0) return {};

  return page.evaluate((defs) => {
    const out: Record<string, Array<{ text: string; href: string | null }>> = {};
    for (const def of defs) {
      const nodes = Array.from(document.querySelectorAll(def.selector)).slice(0, 200);
      out[def.field] = nodes.map((node) => {
        let value: string;
        if (def.attr) {
          value = node.getAttribute(def.attr) ?? "";
        } else if (node instanceof HTMLAnchorElement) {
          value = node.innerText || (node.getAttribute("href") ?? "");
        } else {
          value = node.textContent ?? "";
        }
        const href = node instanceof HTMLAnchorElement ? node.getAttribute("href") : null;
        return { text: (value ?? "").replace(/\s+/g, " ").trim(), href };
      });
    }
    return out;
  }, entries);
}
