import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { PageSnapshot } from "../engine.js";
import type { HrTalentPayload, JobPosting, ParseResult, SalaryRange } from "../../types.js";
import { cleanText, countBy, detectPeriod, parseMoney, round2 } from "./shared.js";

/** Container selectors commonly used by career portals and ATS widgets. */
const CONTAINER_SELECTORS = [
  "li.opening",
  ".job-card",
  ".job-card-content",
  "[data-job-id]",
  "[data-component='job-card']",
  "article[class*='job']",
  "li[class*='job-listing']",
  "div[class*='job-card']",
  "div[class*='position']",
  "tr[class*='job']",
  "div[class*='career'] li",
  ".jobs-list li",
  ".positions li",
  ".vacancy",
  ".vacancy-item",
  ".career-opening",
  "[class*='opening']",
];

const TITLE_SELECTORS = ["h2", "h3", "h4", "[class*='title']", "[class*='name']", "a"];

const LOCATION_SELECTORS = ["[class*='location']", "[class*='city']", "[class*='place']", "[data-location]"];

const DATE_SELECTORS = ["time", "[class*='date']", "[class*='posted']", "[class*='published']"];

const SALARY_SELECTORS = [
  "[class*='salary']",
  "[class*='compensation']",
  "[class*='pay']",
  "[class*='wage']",
  "[class*='maas']",
  "[class*=' ücret']",
];

const SENIORITY_RULES: Array<{ level: string; re: RegExp }> = [
  { level: "Intern", re: /\b(intern|internship|stajyer|staj)\b/i },
  { level: "Junior", re: /\b(junior|jr\.?|graduate|new grad|entry[- ]level|başlangıç)\b/i },
  { level: "Mid", re: /\b(mid[- ]?level|intermediate|middle|orta seviye)\b/i },
  { level: "Senior", re: /\b(senior|sr\.?|kıdemli|uzman)\b/i },
  { level: "Lead", re: /\b(lead|tech lead|team lead|lider)\b/i },
  { level: "Principal", re: /\b(principal|staff engineer|mimari)\b/i },
  { level: "Manager", re: /\b(engineering manager|product manager|team manager|yönetici)\b/i },
  { level: "Director+", re: /\b(director|head of|vp |vice president|cto|cio|chief|genel müdür)\b/i },
];

/** Technology / skill vocabulary scanned inside job descriptions. */
const TECH_VOCABULARY = [
  "React", "Next.js", "Vue", "Angular", "Svelte", "Remix",
  "Node.js", "NestJS", "Express", "Django", "Flask", "FastAPI", "Ruby on Rails", "Laravel", "Spring Boot", "ASP.NET",
  "TypeScript", "JavaScript", "Python", "Java", "Kotlin", "Swift", "Golang", "Rust", "C#", "PHP", "Scala",
  "React Native", "Flutter", "iOS", "Android",
  "AWS", "Azure", "Google Cloud", "GCP", "Kubernetes", "Docker", "Terraform", "Ansible", "Istio",
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "Elasticsearch", "Cassandra", "DynamoDB", "Kafka", "RabbitMQ", "GraphQL",
  "Microservices", "gRPC", "REST", "CI/CD", "Jenkins", "GitLab CI", "GitHub Actions", "ArgoCD",
  "Datadog", "Grafana", "Prometheus", "Splunk", "Snowflake", "dbt", "Airflow",
  "PyTorch", "TensorFlow", "LLM", "RAG", "OpenAI", "LangChain", "Machine Learning", "MLOps",
  "SAP", "Salesforce", "ServiceNow", "Tableau", "Power BI", "Jira", "Confluence",
  "Tailwind CSS", "Redux", "WebSocket", "Blockchain", "Solidity", "Web3", "Go",
];

const DATE_HINT = /\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\./i;

function pickFirstText(scope: ReturnType<CheerioAPI>, selectors: string[]): string | null {
  for (const selector of selectors) {
    try {
      const text = cleanText(scope.find(selector).first().text());
      if (text) return text;
    } catch {
      // Selector unsupported by the parser engine - skip.
    }
  }
  return null;
}

function detectSeniority(title: string): string {
  for (const rule of SENIORITY_RULES) {
    if (rule.re.test(title)) return rule.level;
  }
  return "Unspecified";
}

export function extractTechStack(text: string): string[] {
  const haystack = text.toLowerCase();
  const found = new Set<string>();
  for (const tech of TECH_VOCABULARY) {
    const needle = tech.toLowerCase();
    if (haystack.includes(needle)) found.add(tech);
  }
  return [...found];
}

function parseSalary(scope: ReturnType<CheerioAPI>): SalaryRange | null {
  const raw = pickFirstText(scope, SALARY_SELECTORS);
  if (!raw) return null;
  const money = parseMoney(raw);
  if (!money || money.min === null) return null;
  return { raw, min: money.min, max: money.max, currency: money.currency, period: detectPeriod(raw) };
}

function resolveUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function parseFromContainers($: CheerioAPI, snapshot: PageSnapshot): JobPosting[] {
  const base = snapshot.finalUrl || snapshot.requestedUrl;
  const jobs: JobPosting[] = [];
  const seen = new Set<string>();

  for (const selector of CONTAINER_SELECTORS) {
    let nodes: ReturnType<CheerioAPI>;
    try {
      nodes = $(selector);
    } catch {
      continue;
    }
    nodes.each((_, node: AnyNode) => {
      const scope = $(node as Element);
      const title = pickFirstText(scope, TITLE_SELECTORS);
      if (!title || title.length < 3 || title.length > 160) return;

      const href = scope.find("a[href]").first().attr("href") ?? (node as Element).attribs?.["href"];
      const url = resolveUrl(href, base);
      const key = `${title.toLowerCase()}|${url ?? ""}`;
      if (seen.has(key)) return;

      const salary = parseSalary(scope);
      const locationRaw = pickFirstText(scope, LOCATION_SELECTORS);
      const dateRaw = pickFirstText(scope, DATE_SELECTORS);
      const techStack = extractTechStack(cleanText(scope.text()));

      seen.add(key);
      jobs.push({
        title,
        seniority: detectSeniority(title),
        location: locationRaw,
        salary,
        techStack,
        url,
        postedAt: dateRaw && DATE_HINT.test(dateRaw) ? dateRaw : null,
      });
    });
    if (jobs.length > 0) break;
  }

  return jobs;
}

function parseFromCustomSelectors(snapshot: PageSnapshot): JobPosting[] {
  const jobs: JobPosting[] = [];
  for (const [field, entries] of Object.entries(snapshot.customSelectors)) {
    if (!["jobs", "titles", "items", "job"].includes(field)) continue;
    for (const entry of entries) {
      if (!entry.text) continue;
      jobs.push({
        title: entry.text,
        seniority: detectSeniority(entry.text),
        location: null,
        salary: null,
        techStack: extractTechStack(entry.text),
        url: resolveUrl(entry.href, snapshot.finalUrl || snapshot.requestedUrl),
        postedAt: null,
      });
    }
  }
  return jobs;
}

function deriveMetrics(jobs: JobPosting[]): Record<string, number | string | null> {
  const techFreq: Record<string, number> = {};
  for (const job of jobs) {
    for (const tech of job.techStack) {
      techFreq[tech] = (techFreq[tech] ?? 0) + 1;
    }
  }
  const salaries = jobs.map((j) => j.salary?.min).filter((s): s is number => typeof s === "number");
  const seniorRoles = jobs.filter((j) =>
    ["Senior", "Lead", "Principal", "Director+", "Manager"].includes(j.seniority),
  ).length;

  return {
    jobCount: jobs.length,
    uniqueTechCount: Object.keys(techFreq).length,
    seniorRoleCount: seniorRoles,
    rolesWithSalary: jobs.filter((j) => j.salary !== null).length,
    avgMinSalary: salaries.length > 0 ? round2(salaries.reduce((a, b) => a + b, 0) / salaries.length) : null,
  };
}

/** Parses career-portal content into structured job posting intelligence. */
export function parseHr(snapshot: PageSnapshot): ParseResult {
  const notes: string[] = [];
  let jobs = parseFromCustomSelectors(snapshot);

  if (jobs.length > 0) {
    notes.push(`Extracted via custom selectors: ${jobs.length} job posting(s).`);
  } else {
    const $ = load(snapshot.html);
    jobs = parseFromContainers($, snapshot);
    notes.push(`Heuristic container scan: ${jobs.length} job posting(s) found.`);
    if (jobs.length === 0) {
      notes.push(
        "No job cards matched known career-portal patterns. Provide customSelector (e.g. { jobs: '.job-card', title: 'h3' }) to target this site's markup.",
      );
    }
  }

  const techStackFrequency: Record<string, number> = {};
  for (const job of jobs) {
    for (const tech of job.techStack) {
      techStackFrequency[tech] = (techStackFrequency[tech] ?? 0) + 1;
    }
  }

  const payload: HrTalentPayload = {
    kind: "hr_talent",
    jobs,
    techStackFrequency,
    seniorityBreakdown: countBy(jobs, (j) => j.seniority),
  };

  return { payload, metrics: deriveMetrics(jobs), notes };
}
