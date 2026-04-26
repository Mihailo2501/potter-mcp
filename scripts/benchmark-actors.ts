#!/usr/bin/env tsx
import { ApifyClient } from "apify-client";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

type Category = "profile" | "company" | "posts" | "employees";

interface ActorCandidate {
  id: string;
  buildInput: (fixture: string) => Record<string, unknown>;
  extractCount: (items: unknown[]) => number;
}

interface Fixture {
  name: string;
  url: string;
}

const PROFILE_FIXTURES: Fixture[] = [
  { name: "mihailo", url: "https://www.linkedin.com/in/mihailoskendzic/" },
  { name: "elias-stravik", url: "https://www.linkedin.com/in/eliasstravik/" },
  { name: "dario-amodei", url: "https://www.linkedin.com/in/darioamodei/" },
  { name: "satya-nadella", url: "https://www.linkedin.com/in/satyanadella/" },
  { name: "patrick-collison", url: "https://www.linkedin.com/in/patrickcollison/" },
];

const COMPANY_FIXTURES: Fixture[] = [
  { name: "anthropic", url: "https://www.linkedin.com/company/anthropicresearch/" },
  { name: "stripe", url: "https://www.linkedin.com/company/stripe/" },
  { name: "vercel", url: "https://www.linkedin.com/company/vercel/" },
  { name: "vanta", url: "https://www.linkedin.com/company/trustvanta/" },
  { name: "ramp", url: "https://www.linkedin.com/company/ramp/" },
];

import {
  slugFromLinkedInCompanyUrl,
  slugFromLinkedInProfileUrl,
} from "../src/urls.js";

const slugFromProfileUrl = (url: string): string => {
  try {
    return slugFromLinkedInProfileUrl(url);
  } catch {
    const match = url.match(/\/in\/([^/?#]+)/i);
    return match?.[1]?.toLowerCase() ?? url;
  }
};

const slugFromCompanyUrl = (url: string): string => {
  try {
    return slugFromLinkedInCompanyUrl(url);
  } catch {
    const match = url.match(/\/company\/([^/?#]+)/i);
    return match?.[1]?.toLowerCase() ?? url;
  }
};

const CANDIDATES: Record<Category, ActorCandidate[]> = {
  profile: [
    {
      id: "dev_fusion/Linkedin-Profile-Scraper",
      buildInput: (url) => ({ profileUrls: [url] }),
      extractCount: (items) => items.length,
    },
    {
      id: "harvestapi/linkedin-profile-scraper",
      buildInput: (url) => ({
        queries: [url],
        profileScraperMode: "Profile details no email ($4 per 1k)",
      }),
      extractCount: (items) => items.length,
    },
    {
      id: "apimaestro/linkedin-profile-batch-scraper-no-cookies-required",
      buildInput: (url) => ({ usernames: [slugFromProfileUrl(url)], includeEmail: false }),
      extractCount: (items) => items.length,
    },
  ],
  company: [
    {
      id: "dev_fusion/Linkedin-Company-Scraper",
      buildInput: (url) => ({ profileUrls: [url] }),
      extractCount: (items) => items.length,
    },
    {
      id: "apimaestro/linkedin-company-detail",
      buildInput: (url) => ({ identifier: [slugFromCompanyUrl(url)] }),
      extractCount: (items) => items.length,
    },
    {
      id: "harvestapi/linkedin-company",
      buildInput: (url) => ({ companies: [url] }),
      extractCount: (items) => items.length,
    },
  ],
  posts: [
    {
      id: "harvestapi/linkedin-profile-posts",
      buildInput: (url) => ({ targetUrls: [url], maxPosts: 5, includeReposts: false }),
      extractCount: (items) => items.length,
    },
    {
      id: "apimaestro/linkedin-profile-posts",
      buildInput: (url) => ({ username: slugFromProfileUrl(url), limit: 5 }),
      extractCount: (items) => items.length,
    },
    {
      id: "apimaestro/linkedin-batch-profile-posts-scraper",
      buildInput: (url) => ({ usernames: [slugFromProfileUrl(url)], limit: 5 }),
      extractCount: (items) => items.length,
    },
  ],
  employees: [
    {
      id: "harvestapi/linkedin-company-employees",
      buildInput: (url) => ({ companies: [url], maxItems: 5 }),
      extractCount: (items) => items.length,
    },
    {
      id: "apimaestro/linkedin-company-employees-scraper-no-cookies",
      buildInput: (url) => ({ identifier: slugFromCompanyUrl(url), max_employees: 5 }),
      extractCount: (items) => items.length,
    },
  ],
};

const FIXTURES: Record<Category, Fixture[]> = {
  profile: PROFILE_FIXTURES,
  company: COMPANY_FIXTURES,
  posts: PROFILE_FIXTURES,
  employees: COMPANY_FIXTURES,
};

const RUN_TIMEOUT_SECONDS = 120;
const RESULT_ITEM_LIMIT = 5;

interface RunResult {
  category: Category;
  actor: string;
  fixture: string;
  success: boolean;
  latency_ms: number;
  item_count: number;
  cost_usd: number | null;
  first_item_bytes: number;
  error: string | null;
  run_status: string | null;
}

const log = (msg: string) => process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);

async function runOne(
  client: ApifyClient,
  category: Category,
  actor: ActorCandidate,
  fixture: Fixture,
  runsDir: string,
): Promise<RunResult> {
  const started = Date.now();
  try {
    const input = actor.buildInput(fixture.url);
    log(`run ${category}/${actor.id} <- ${fixture.name}`);
    const run = await client.actor(actor.id).call(input, {
      timeout: RUN_TIMEOUT_SECONDS,
      waitSecs: RUN_TIMEOUT_SECONDS,
    });
    const dataset = await client
      .dataset(run.defaultDatasetId)
      .listItems({ limit: RESULT_ITEM_LIMIT });
    const items = dataset.items;
    const firstItem = items[0] ?? null;
    const firstItemBytes = Buffer.byteLength(JSON.stringify(firstItem ?? null), "utf8");
    const cost =
      typeof run.usageTotalUsd === "number"
        ? run.usageTotalUsd
        : typeof run.usage?.ACTOR_COMPUTE_UNITS === "number"
          ? null
          : null;

    const safeActorName = actor.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    await writeFile(
      path.join(runsDir, `${category}-${safeActorName}-${fixture.name}.json`),
      JSON.stringify(
        { run_id: run.id, status: run.status, input, items },
        null,
        2,
      ),
    );

    const firstItemObj = firstItem as Record<string, unknown> | null;
    const hasErrorField =
      firstItemObj !== null &&
      typeof firstItemObj === "object" &&
      (typeof firstItemObj.error === "string" ||
        (typeof firstItemObj.message === "string" && typeof firstItemObj.url !== "string"));
    return {
      category,
      actor: actor.id,
      fixture: fixture.name,
      success: run.status === "SUCCEEDED" && items.length > 0 && !hasErrorField,
      latency_ms: Date.now() - started,
      item_count: actor.extractCount(items),
      cost_usd: cost,
      first_item_bytes: firstItemBytes,
      error: hasErrorField ? "actor_returned_error_item" : null,
      run_status: run.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FAIL ${category}/${actor.id} <- ${fixture.name}: ${message}`);
    return {
      category,
      actor: actor.id,
      fixture: fixture.name,
      success: false,
      latency_ms: Date.now() - started,
      item_count: 0,
      cost_usd: null,
      first_item_bytes: 0,
      error: message,
      run_status: null,
    };
  }
}

interface SummaryRow {
  actor: string;
  successes: number;
  fixtures: number;
  median_latency_s: number | null;
  total_cost_usd: number | null;
  avg_first_item_kb: number | null;
  errors: string[];
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
};

const summarize = (results: RunResult[], category: Category): SummaryRow[] => {
  const actors = CANDIDATES[category].map((a) => a.id);
  return actors.map((actorId) => {
    const rows = results.filter((r) => r.actor === actorId);
    const succ = rows.filter((r) => r.success);
    const latencyMedian = median(succ.map((r) => r.latency_ms));
    const costs = rows.map((r) => r.cost_usd).filter((c): c is number => c !== null);
    const totalCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
    const itemBytes = succ.map((r) => r.first_item_bytes);
    const avgItemBytes =
      itemBytes.length > 0 ? itemBytes.reduce((a, b) => a + b, 0) / itemBytes.length : null;
    const errors = rows
      .filter((r) => r.error !== null)
      .map((r) => `${r.fixture}: ${r.error}`);
    return {
      actor: actorId,
      successes: succ.length,
      fixtures: rows.length,
      median_latency_s: latencyMedian !== null ? latencyMedian / 1000 : null,
      total_cost_usd: totalCost,
      avg_first_item_kb: avgItemBytes !== null ? avgItemBytes / 1024 : null,
      errors,
    };
  });
};

const renderMarkdown = (
  summaries: Record<Category, SummaryRow[]>,
  timestamp: string,
): string => {
  const sections: string[] = [];
  sections.push(`# Potter Apify Actor Benchmark Results\n`);
  sections.push(`**Tested on:** ${timestamp}`);
  sections.push(`**Fixtures per category:** 5`);
  sections.push(`**Run timeout:** ${RUN_TIMEOUT_SECONDS}s each`);
  sections.push(`**Note:** Runs are sequential to avoid provider rate-limit noise.\n`);

  for (const category of ["profile", "company", "posts", "employees"] as Category[]) {
    sections.push(`## ${category}\n`);
    sections.push(`| Actor | Success | Median latency (s) | Total cost (USD) | Avg first-item (kB) |`);
    sections.push(`|-------|---------|--------------------|------------------|---------------------|`);
    for (const row of summaries[category]) {
      sections.push(
        `| \`${row.actor}\` | ${row.successes}/${row.fixtures} | ${row.median_latency_s?.toFixed(1) ?? "-"} | ${row.total_cost_usd?.toFixed(4) ?? "-"} | ${row.avg_first_item_kb?.toFixed(1) ?? "-"} |`,
      );
    }
    const errorRows = summaries[category].filter((r) => r.errors.length > 0);
    if (errorRows.length > 0) {
      sections.push(`\n**Errors:**`);
      for (const row of errorRows) {
        for (const e of row.errors) {
          sections.push(`- \`${row.actor}\` · ${e}`);
        }
      }
    }
    sections.push("");
  }

  sections.push(`## Winner selection rules`);
  sections.push(`1. Highest success count wins the category.`);
  sections.push(`2. On tie: best median latency.`);
  sections.push(`3. On further tie: lowest total cost.`);
  sections.push(`4. Spot-check raw field completeness before baking the winner into \`src/providers/apify-actors.ts\`.`);

  return sections.join("\n") + "\n";
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  if (!config.apifyToken) {
    throw new Error(
      "POTTER_APIFY_TOKEN is not set. Fill potter-mcp/.env before running the benchmark.",
    );
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, "..");

  if (dryRun) {
    log("dry-run mode: validating config only; no Apify calls will be made");
    const total =
      CANDIDATES.profile.length * FIXTURES.profile.length +
      CANDIDATES.company.length * FIXTURES.company.length +
      CANDIDATES.posts.length * FIXTURES.posts.length +
      CANDIDATES.employees.length * FIXTURES.employees.length;
    log(`planned runs: ${total}`);
    for (const category of ["profile", "company", "posts", "employees"] as Category[]) {
      log(`  ${category}: ${CANDIDATES[category].length} actors × ${FIXTURES[category].length} fixtures`);
      for (const actor of CANDIDATES[category]) {
        const sample = actor.buildInput(FIXTURES[category][0]!.url);
        log(`    ${actor.id} input sample: ${JSON.stringify(sample)}`);
      }
    }
    log("dry-run complete");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runsDir = path.join(packageRoot, "docs", "provider-benchmark-runs", timestamp);
  await mkdir(runsDir, { recursive: true });
  log(`benchmark run -> ${runsDir}`);

  const client = new ApifyClient({ token: config.apifyToken });

  const allResults: RunResult[] = [];
  for (const category of ["profile", "company", "posts", "employees"] as Category[]) {
    for (const actor of CANDIDATES[category]) {
      for (const fixture of FIXTURES[category]) {
        const result = await runOne(client, category, actor, fixture, runsDir);
        allResults.push(result);
      }
    }
  }

  const summaries: Record<Category, SummaryRow[]> = {
    profile: summarize(allResults, "profile"),
    company: summarize(allResults, "company"),
    posts: summarize(allResults, "posts"),
    employees: summarize(allResults, "employees"),
  };

  const markdown = renderMarkdown(summaries, timestamp);
  const outPath = path.join(packageRoot, "docs", "provider-benchmarks.md");
  await writeFile(outPath, markdown);
  log(`wrote ${outPath}`);

  await writeFile(
    path.join(runsDir, "all-results.json"),
    JSON.stringify(allResults, null, 2),
  );

  const totalSuccess = allResults.filter((r) => r.success).length;
  log(`done: ${totalSuccess}/${allResults.length} total successes`);
}

main().catch((err) => {
  process.stderr.write(
    `benchmark failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
