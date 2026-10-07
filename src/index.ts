#!/usr/bin/env node
/**
 * Omni-Market & Competitive Intelligence MCP Server
 *
 * Runs over stdio for Claude Desktop, Claude Code, Cursor and Windsurf.
 * All logging MUST go to stderr (stdout is reserved for the MCP protocol).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { closeDb, resolveDbPath } from "./db/index.js";
import { runCompare, runHistory, runOverview, runScrape } from "./tools.js";
import { CATEGORIES, CATEGORY_LABELS } from "./types.js";

const SERVER_NAME = "omni-market-intelligence";
const SERVER_VERSION = "1.0.0";

const categorySchema = z
  .enum(CATEGORIES)
  .describe(
    "Intelligence category: hr_talent | content_pr | social_trends | real_estate | saas_pricing | ecommerce",
  );

const customSelectorSchema = z
  .record(
    z.string(),
    z.union([
      z.string().describe("CSS selector returning one field"),
      z
        .object({
          selector: z.string().describe("CSS selector"),
          attr: z.string().optional().describe("Attribute to read instead of text (e.g. href, datetime)"),
        })
        .describe("Selector with attribute extraction"),
    ]),
  )
  .describe(
    "Optional field-name -> CSS-selector map used instead of (or in addition to) heuristic parsers. Example: { jobs: '.job-card', title: 'h3' }",
  );

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown) {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}${error.cause ? `\nCaused by: ${String((error.cause as Error).message ?? error.cause)}` : ""}`
      : String(error);
  return {
    content: [{ type: "text" as const, text: `ERROR - ${message}` }],
    isError: true,
  };
}

function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "scrape_competitor_target",
    {
      title: "Scrape competitor target",
      description:
        "Scrapes a competitor URL with a stealth headless browser (Playwright), extracts structured data with category-specific heuristic parsers, persists the event to SQLite and returns a JSON intelligence snapshot. " +
        "Categories: " +
        CATEGORIES.map((c) => `${c} (${CATEGORY_LABELS[c]})`).join("; ") +
        ". Supports customSelector overrides when a site's markup is unknown.",
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL to scrape (career page, /pricing, /blog, listing, feed, storefront...)"),
        competitorName: z.string().min(1).describe("Label grouping this target, e.g. 'Acme Corp'"),
        category: categorySchema,
        customSelector: customSelectorSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ url, competitorName, category, customSelector }) => {
      try {
        const text = await runScrape({
          url,
          competitorName,
          category,
          customSelector: customSelector ?? undefined,
        });
        return textResult(text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_intelligence_history",
    {
      title: "Get intelligence history",
      description:
        "Queries the persistent SQLite intelligence ledger and renders a historic timeline per competitor/category, including computed changes between snapshots (tech-stack shifts, price changes, new job postings, new articles, listing deltas).",
      inputSchema: {
        competitorName: z.string().optional().describe("Substring match on competitor name (optional)"),
        category: categorySchema.optional().describe("Filter by intelligence category (optional)"),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "Use YYYY-MM-DD or ISO-8601")
          .optional()
          .describe("Only events at/after this timestamp (YYYY-MM-DD or ISO-8601)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max events returned (default 100)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ competitorName, category, startDate, limit }) => {
      try {
        const text = await runHistory({
          competitorName,
          category,
          startDate,
          limit,
        });
        return textResult(text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "compare_competitor_metrics",
    {
      title: "Compare competitor metrics",
      description:
        "Builds a comparative Markdown table across the given competitors for one intelligence category (latest stored snapshot per competitor, delta vs previous snapshot, plus a category deep-dive).",
      inputSchema: {
        category: categorySchema.describe("Category to compare across competitors"),
        competitorList: z
          .array(z.string().min(1))
          .min(1)
          .max(25)
          .describe("Competitor names to compare (must match stored competitorName values)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ category, competitorList }) => {
      try {
        const text = await runCompare(category, competitorList);
        return textResult(text);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_intelligence_targets",
    {
      title: "List intelligence targets",
      description:
        "Returns an overview of every competitor/category present in the local SQLite ledger (event counts and last snapshot time). Useful before running history or comparison tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return textResult(await runOverview());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const server = createServer();
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[${SERVER_NAME}] ${signal} received, shutting down...`);
    try {
      await closeDb();
    } catch {
      // Best-effort close.
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} running on stdio`);
  console.error(`[${SERVER_NAME}] SQLite ledger: ${dbPath}`);
  console.error(
    `[${SERVER_NAME}] categories: ${CATEGORIES.map((c) => c).join(", ")}`,
  );
}

main().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] fatal startup error:`, error);
  process.exit(1);
});
