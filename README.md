# Omni-Market & Competitive Intelligence MCP Server

A production-ready **Model Context Protocol (MCP)** server written in TypeScript that watches competitors across six intelligence sectors and answers agentic questions with structured, history-backed market intel.

It runs over **`stdio`** (works in Claude Desktop, Claude Code, Cursor, Windsurf) and persists every scraped observation in **SQLite** so pricing shifts, tech-stack investments, hiring pushes, and content cadence can be diffed over time.

> 🎯 Cross-sector coverage (TR/EN heuristics built-in):
> 1. **HR & Tech Stack Intelligence** — `hr_talent` (Kariyer.net, LinkedIn, Glassdoor job cards)
> 2. **Content, Media & SEO** — `content_pr` (blog/PR article tracker), `social_trends` (Reddit / ProductHunt / RSS trends + sentiment)
> 3. **Real Estate & Travel** — `real_estate` (Airbnb-style listings, sales/rental portals, nightly rates)
> 4. **SaaS & E-Commerce** — `saas_pricing` (`/pricing` tiers), `ecommerce` (product title, price, currency, stock)

---

## Features

- **`scrape_competitor_target(url, competitorName, category, customSelector?)`** — stealth headless browse, extract, persist, return structured JSON.
- **`get_intelligence_history(...)`** — filtered SQLite timeline incl. computed *changes between snapshots* (tech-stack additions, price deltas, new job titles/articles/listings).
- **`compare_competitor_metrics(category, competitorList)`** — one Markdown comparison table + category deep-dive across competitors.
- **`list_intelligence_targets()`** — overview of every tracked competitor/category in the ledger.
- Auto-migrating SQLite ledger, WAL mode, indexed queries.
- Anti-bot heuristics: stealthed headless Chromium (UA, headers, navigator patches), media blocking for speed, retry + timeout handling, custom-selector fallbacks for unknown markup.
- Localization-aware parsing: detects `$`, `€`, `₺`, `£` and both `1,234.56` and `1.234,56` formats; Turkish and English keywords.

---

## Requirements

- Node.js **>= 18.18**
- **Google Chrome** (system install — used automatically) **or** `npx playwright install chromium`

## Quick start

```bash
npm install
npm run build

# make sure a browser is available
google-chrome --version    # or: npx playwright install chromium

# optional - point the ledger somewhere explicit
export INTEL_DB_PATH="$HOME/.omni-intel/intelligence.db"

# mount into your agent via MCP (see below) OR run self-checks:
npm run smoke
node dist/index.js
```

The server writes its SQLite ledger to `./data/intelligence.db` by default — override with **`INTEL_DB_PATH`**.

---

## Wiring into AI coding agents

All three entries point the same `dist/index.js` (must be built first).

### Cursor — `.cursor/mcp.json` (project level)

```json
{
  "mcpServers": {
    "omni-market-intelligence": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/omni-market-intelligence/dist/index.js"],
      "env": {
        "INTEL_DB_PATH": "/abs/path/to/omni-market-intelligence/data/intelligence.db"
      }
    }
  }
}
```

Global equivalent: **Settings → Cursor → MCP** (or `~/.cursor/mcp.json` for user-wide).

### Claude Code — `claude config`

Claude Code mounts project MCP servers from a `.mcp.json` **at the project root** (workspace-wide, not repo-committed), or you can add a user-wide one:

```bash
claude mcp add omni-market-intelligence \
  --transport stdio \
  --env INTEL_DB_PATH="/abs/path/omni-market-intelligence/data/intelligence.db" \
  node /abs/path/omni-market-intelligence/dist/index.js
```

Equivalent `.mcp.json`:

```json
{
  "mcpServers": {
    "omni-market-intelligence": {
      "command": "node",
      "args": ["/abs/path/to/omni-market-intelligence/dist/index.js"],
      "env": {
        "INTEL_DB_PATH": "/abs/path/to/omni-market-intelligence/data/intelligence.db"
      }
    }
  }
}
```

Claude Code also respects the older `claude.json`-style config:

```bash
claude mcp add --scope user omni-market-intelligence -- node /abs/path/dist/index.js
# then verify:
claude mcp list
claude mcp get omni-market-intelligence
```

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "omni-market-intelligence": {
      "command": "node",
      "args": ["/abs/path/to/omni-market-intelligence/dist/index.js"],
      "env": {
        "INTEL_DB_PATH": "/abs/path/to/omni-market-intelligence/data/intelligence.db"
      }
    }
  }
}
```

Paths in `env` must be **absolute**, and `dist/` must exist (`npm run build`). After adding, fully restart the agent (no hot-reload for stdio servers).

### Windsurf

**Settings → MCP → Add** → `omni-market-intelligence` → command `node`, args/absolute path + env as above.

---

## Tools (agent-facing)

### `scrape_competitor_target`
| Input | Type | Notes |
| --- | --- | --- |
| `url` | string (url) | e.g. `https://acme.com/careers`, `https://acme.com/pricing` |
| `competitorName` | string | stable label used for grouping/diffs |
| `category` | enum | `hr_talent` · `content_pr` · `social_trends` · `real_estate` · `saas_pricing` · `ecommerce` |
| `customSelector` | object (optional) | `{ jobs: '.job-card', title: 'h3' }` or `{ field: { selector, attr } }` |

Heuristic parsers fire automatically per category; **`customSelector`** is the escape hatch when a site's markup is unknown. Output = metric table + parser notes + full JSON payload; the event is persisted to SQLite.

### `get_intelligence_history`
Filters: `competitorName?`, `category?`, `startDate?`, `limit?`. Renders a per-competitor timeline with computed **Δ vs previous snapshot** for the category.

### `compare_competitor_metrics`
`category` + `competitorList[]` → single Markdown table (snapshot metrics + Δ primary metric + snapshots count + last seen) plus a deep-dive section.

### `list_intelligence_targets`
Ledger overview — counts and last-seen per (competitor, category).

---

## Project layout

```
src/
  index.ts                  # MCP server entrypoint (stdio transport)
  types.ts                  # strict domain types shared everywhere
  db/index.ts               # SQLite init + auto-migrations + queries
  tools.ts                  # tool workflows: scrape/history/compare (testable core)
  scrapers/
    engine.ts               # Playwright wrapper: stealth, retries, snapshot, custom selectors
    parsers/
      index.ts              # category dispatcher
      shared.ts             # money/period parsing, keyword & text utilities
      hrParser.ts           # job cards, seniority, salary ₺/$/€, tech-stack scan
      contentParser.ts      # blog/PR articles + RSS/Reddit/ProductHunt social parsing
      realEstateParser.ts   # listing cards, nightly/monthly/total rates, availability
      saasParser.ts         # pricing tiers, features, user limits, billing period
      ecommerceParser.ts    # products, price, currency, stock + JSON-LD
scripts/
  smoke.mjs                 # end-to-end MCP smoke test over stdio (fixtures incl.)
```

## Database

SQLite via `sqlite`/`sqlite3` (WAL mode). Table:

```sql
intelligence_events(
  id, created_at, target_url, competitor_name,
  category  -- CHECK in hr_talent|content_pr|social_trends|real_estate|saas_pricing|ecommerce
  payload   -- raw JSON observation
  metrics   -- compact comparison metrics
)
```

Schema migrations run automatically (tracked in `schema_migrations`). Sample:

```bash
sqlite3 data/intelligence.db "SELECT * FROM intelligence_events ORDER BY id DESC LIMIT 3;"
```

> ⚠️ **Ethics & ToS**: this automates scraping. Verify each target site's terms of service and robots.txt; throttle requests; never store PII beyond what is needed for competitive intel.

## License

MIT# Market-Competitive-Intelligence-MCP-Server
