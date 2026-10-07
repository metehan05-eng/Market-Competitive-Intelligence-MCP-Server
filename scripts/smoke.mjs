/**
 * End-to-end smoke test.
 *
 * Spawns the built MCP server over stdio, serves local HTML fixtures for every
 * intelligence category over http, and exercises all four MCP tools.
 *
 *   node scripts/smoke.mjs
 *
 * Requires: `npm run build` and a system Google Chrome OR `npx playwright install chromium`.
 */
import { once } from "node:events";
import http from "node:http";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(cwd(), "dist", "index.js");

const FIXTURES = {
  hr_talent: `<!doctype html><html><head><title>Acme Careers</title></head><body>
    <h1>Open Positions</h1>
    <ul class="jobs-list">
      <li class="opening"><h3>Senior React Developer</h3>
        <span class="location">Istanbul, TR</span>
        <span class="salary">$90,000 - $120,000 / year</span>
        <time>2026-10-01</time>
        <a href="/jobs/senior-react">detail</a></li>
      <li class="opening"><h3>Junior Python Engineer</h3>
        <span class="location">Ankara, TR</span>
        <span class="salary">25.000 ₺ - 35.000 ₺ / month</span>
        <a href="/jobs/junior-python">detail</a></li>
      <li class="opening"><h3>DevOps Lead (Kubernetes, AWS)</h3>
        <span class="salary">$110,000 - $140,000 / year</span></li>
    </ul></body></html>`,

  content_pr: `<!doctype html><html><head><title>Acme Blog</title></head><body>
    <main>
      <article class="post">
        <h2><a href="/blog/ai-market-shift">How AI reshaped our roadmap</a></h2>
        <time>2026-09-28</time>
        <p>We launched a new LLM feature set for enterprise customers.</p>
      </article>
      <article class="post">
        <h2><a href="/blog/expansion-eu">Expanding into the EU</a></h2>
        <time>2026-09-15</time>
        <p>New offices in Berlin and second data centre in Frankfurt.</p>
      </article>
    </main></body></html>`,

  social_trends: `<!doctype html><html><head><title>reddit</title></head><body>
    <ul>
      <li><shreddit-post score="142" title="The best AI note-taking app this year" comment-count="38"><h3><a href="/r/ai/comments/1">The best AI note-taking app this year</a></h3><time>2 days ago</time></shreddit-post></li>
      <li><shreddit-post score="88" title="Anyone else frustrated with SaaS pricing tiers?" comment-count="60"><h3><a href="/r/saas/comments/2">Anyone else frustrated with SaaS pricing tiers?</a></h3></shreddit-post></li>
    </ul></body></html>`,

  real_estate: `<!doctype html><html><head><title>CityListings</title></head><body>
    <div class="search-results">
      <div class="property-card">
        <h3><a href="/p/1">2-bedroom apartment in Kadikoy</a></h3>
        <span class="address">Kadikoy, Istanbul</span>
        <span class="price">1,200,000 ₺ / total</span>
        <span class="status">for sale</span>
      </div>
      <div class="property-card">
        <h3><a href="/p/2">Seaside villa Bodrum</a></h3>
        <span class="price">$450,000 / total</span>
        <span class="status">available</span>
      </div>
      <div class="property-card">
        <h3><a href="/p/3">Studio rental city centre</a></h3>
        <span class="price">650 EUR / month</span>
        <span class="status">for rent</span>
      </div>
    </div></body></html>`,

  saas_pricing: `<!doctype html><html><head><title>Acme SaaS Pricing</title></head><body>
    <div class="pricing-tiers">
      <div class="pricing-tier">
        <h3>Starter</h3><span class="price">$19 / month / up to 5 users</span>
        <ul class="features"><li>100 API calls/day</li><li>Community support</li></ul>
      </div>
      <div class="pricing-tier">
        <h3>Pro</h3><span class="price">$49 / month / up to 50 users</span>
        <span class="badge">Most Popular</span>
        <ul class="features"><li>10k API calls/day</li><li>SSO</li><li>Audit logs</li></ul>
      </div>
      <div class="pricing-tier">
        <h3>Enterprise</h3><span class="price">Custom</span>
        <ul class="features"><li>Unlimited seats</li><li>Dedicated support</li><li>On-prem</li></ul>
      </div>
    </div></body></html>`,

  ecommerce: `<!doctype html><html><head><title>Acme Store</title>
    <script type="application/ld+json">{"@type":"Product","name":"Wireless Mouse Pro","price":"89.99","priceCurrency":"USD","availability":"InStock","url":"/p/mouse-pro"}</script>
    </head><body>
    <div class="product-list">
      <div class="product-card">
        <h3><a href="/p/mouse">Wireless Mouse Standard</a></h3>
        <span class="price">$29.99</span>
        <span class="stock">In Stock</span>
      </div>
      <div class="product-card">
        <h3><a href="/p/keyboard">Mechanical Keyboard TKL</a></h3>
        <span class="price">$119.00</span>
        <span class="stock">Out of stock</span>
      </div>
      <div class="product-card">
        <h3><a href="/p/monitor">27-inch 4K Monitor</a></h3>
        <span class="price">$349.00</span>
        <span class="stock">Available for delivery</span>
      </div>
    </div></body></html>`,
};

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const page = (url.pathname.match(/^\/(hr|content|social|realestate|saas|ecommerce)/) ?? [])[1];
    const key = { hr: "hr_talent", content: "content_pr", social: "social_trends", realestate: "real_estate", saas: "saas_pricing", ecommerce: "ecommerce" }[page];
    if (key) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURES[key]);
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const { server, port } = await startFixtureServer();
const BASE = `http://127.0.0.1:${port}`;

const tmpDir = await mkdtemp(path.join(tmpdir(), "mcp-intel-"));
const dbPath = path.join(tmpDir, "intel.db");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { INTEL_DB_PATH: dbPath, ...process.env },
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` (${extra})` : ""}`);
  if (!ok) failures += 1;
};

try {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check("server exposes 4 mcp tools", JSON.stringify(names) === JSON.stringify(["compare_competitor_metrics", "get_intelligence_history", "list_intelligence_targets", "scrape_competitor_target"]), names.join(","));

  const targets = [
    { url: `${BASE}/hr`, competitorName: "Acme Corp", category: "hr_talent", expect: "Jobs |" },
    { url: `${BASE}/content`, competitorName: "Acme Corp", category: "content_pr", expect: "Articles |" },
    { url: `${BASE}/social`, competitorName: "r/AskAI", category: "social_trends", expect: "Posts |" },
    { url: `${BASE}/realestate`, competitorName: "CityListings", category: "real_estate", expect: "Listings |" },
    { url: `${BASE}/saas`, competitorName: "Acme SaaS", category: "saas_pricing", expect: "Plans |" },
    { url: `${BASE}/ecommerce`, competitorName: "Acme Store", category: "ecommerce", expect: "Products |" },
  ];

  for (const target of targets) {
    const res = await client.callTool({
      name: "scrape_competitor_target",
      arguments: { url: target.url, competitorName: target.competitorName, category: target.category },
    });
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const json = text.split("```json")[1]?.split("```")[0] ?? "";
    let payload;
    try { payload = JSON.parse(json); } catch { payload = null; }

    const summaryLine = text.split("\n").find((l) => l.includes("|"));
    const hasPayload = payload !== null;
    const hasSummary = text.includes(`# Scrape Result - ${target.competitorName}`);
    check(
      `scrape ${target.category}: parsed + persisted`,
      hasSummary && hasPayload && text.includes("Stored event id"),
      summaryLine?.trim().slice(0, 60) ?? "no summary",
    );
  }

  const history = await client.callTool({ name: "get_intelligence_history", arguments: { competitorName: "Acme" } });
  const historyText = history.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  check("history: filters & groups by competitor", /Acme Corp - HR & Tech Stack Intelligence/.test(historyText) && /Acme SaaS - SaaS Pricing Intelligence/.test(historyText));

  const compare = await client.callTool({
    name: "compare_competitor_metrics",
    arguments: { category: "ecommerce", competitorList: ["Acme Store", "Missing Store"] },
  });
  const compareText = compare.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  check("compare: markdown table + missing row", compareText.includes("| Competitor |") && compareText.includes("Missing Store") && compareText.includes("no data") && compareText.includes("Acme Store"));

  const overview = await client.callTool({ name: "list_intelligence_targets", arguments: {} });
  const overviewText = overview.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  check("overview: ledger accounted", (overviewText.match(/Acme/gi) ?? []).length >= 4, `${(overviewText.match(/Acme/gi) ?? []).length} Acme mentions`);

  // Error path
  const bad = await client.callTool({ name: "scrape_competitor_target", arguments: { url: "ftp://not-http", competitorName: "X", category: "saas_pricing" } });
  check("scrape: invalid URL rejected by zod", bad.isError === true || JSON.stringify(bad.content).includes("ERROR"), JSON.stringify(bad.content).slice(0, 60));
} finally {
  await client.close();
  server.close();
  await once(server, "close").catch(() => undefined);
  await rm(tmpDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSmoke test: ALL PASSED" : `\nSmoke test: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);