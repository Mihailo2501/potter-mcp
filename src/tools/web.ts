import { z } from "zod";
import { PotterError } from "../errors.js";
import { getFirecrawl } from "../providers/firecrawl.js";
import type { ProviderResponseEnvelope } from "../types.js";
import { isLinkedInUrl } from "../urls.js";
import { defineTool, type ToolDefinition } from "./registry.js";

const HttpUrl = z.string().url();

const rejectIfLinkedInUrl = (tool: string, url: string): void => {
  if (!isLinkedInUrl(url)) return;
  throw new PotterError({
    tool,
    provider: "firecrawl",
    reason: `LinkedIn URLs are not supported by ${tool}. Use potter_linkedin_* primitives instead.`,
    retryable: false,
    recommended_action:
      "Route LinkedIn lookups through potter_linkedin_profile / potter_linkedin_company / potter_linkedin_posts.",
  });
};

const ScrapeArgs = z
  .object({
    url: HttpUrl.describe("Fully-qualified URL to scrape."),
    format: z
      .enum(["markdown", "html", "links"])
      .optional()
      .describe(
        "Scrape output format. Defaults to markdown if omitted. Use 'html' when the user wants raw markup: script-tag inspection, vendor / analytics fingerprinting (GTM, HubSpot, Intercom, Mixpanel, Segment, etc.), stack reverse-engineering, or anything that depends on `<script>` / `<link>` / `<meta>` tags. Use 'links' when the user only needs href URLs (sitemap-style listings).",
      ),
    wait_for: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .optional()
      .describe(
        "Optional wait in milliseconds before extracting content; used for client-rendered pages.",
      ),
  })
  .strict();

const SearchArgs = z
  .object({
    query: z.string().min(1).describe("Search query."),
    limit: z.number().int().min(1).max(20).optional().describe("Max results. Default Firecrawl default (usually 10)."),
    site: z
      .string()
      .optional()
      .describe(
        "Optional site filter, e.g. 'anthropic.com'. Appended as a site: operator after canonicalization.",
      ),
  })
  .strict();

const CrawlArgs = z
  .object({
    url: HttpUrl.describe("Root URL to crawl."),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum pages to visit. Defaults to 5 if omitted, hard max 50."),
    include_patterns: z
      .array(z.string())
      .optional()
      .describe("Glob-style include paths (e.g. '/blog/*')."),
    exclude_patterns: z
      .array(z.string())
      .optional()
      .describe("Glob-style exclude paths."),
  })
  .strict();

export const webTools: ToolDefinition[] = [
  defineTool({
    name: "potter_web_scrape",
    description:
      "Scrape a SINGLE public web page (HN comments, pricing pages, careers pages, single articles, YouTube watch pages, etc.) and return cleaned content in the requested format. format='markdown' (default) for prose / pricing tiers / human-readable content. format='html' for raw markup when the user wants to inspect script tags, vendor fingerprints, analytics IDs, third-party widgets (chat, scheduler, email capture), or do marketing-stack reverse-engineering. Markdown strips these out; html preserves them. format='links' for sitemap-style URL listings. Uses Firecrawl with Potter's canonical envelope (source_urls, provider_status, 20KB cap with truncation markers). Preferred over generic web fetchers when the result might feed potter_extract_structured or another Potter call. For multiple pages or 'crawl N entries' / 'crawl everything under X' phrasings, use potter_web_crawl. URLs are validated server-side: LinkedIn URLs return a structured error with a redirect hint to the right potter_linkedin_* primitive, and private/loopback hosts are blocked. Call this tool normally on those URLs and surface the structured error; do not pre-route based on the URL.",
    argsSchema: ScrapeArgs,
    run: async ({ url, format, wait_for }) => {
      rejectIfLinkedInUrl("potter_web_scrape", url);
      const fc = getFirecrawl();
      const input: Parameters<typeof fc.scrape>[0] = { url, formats: [format ?? "markdown"] };
      if (wait_for !== undefined) input.waitFor = wait_for;
      const result = await fc.scrape(input);
      if (!result.ok) throw result.error;
      const doc = result.value;
      const envelope: ProviderResponseEnvelope & { document: typeof doc } = {
        source_urls: [url],
        provider_status: [{ provider: "firecrawl", ok: true }],
        warnings: [],
        document: doc,
      };
      return envelope;
    },
  }),
  defineTool({
    name: "potter_web_search",
    description:
      "Search the web (Firecrawl). Returns title/url/snippet results in Potter's canonical envelope. Use for: looking up people not already given as a LinkedIn URL ('Who is X at Y company?'), discovery queries ('best Series B fintechs hiring data engineers'), explicit search requests ('search the web for X'), 'what's been said about X lately' queries when no profile URL is provided, and locating pages before potter_web_scrape or potter_extract_structured. Optional 'site' restricts to a single domain. Preferred over generic web search when the result feeds another Potter call. LinkedIn results are filtered out server-side.",
    argsSchema: SearchArgs,
    run: async ({ query, limit, site }) => {
      const fc = getFirecrawl();
      const input: Parameters<typeof fc.search>[0] = { query };
      if (limit !== undefined) input.limit = limit;
      if (site !== undefined) input.site = site;
      const result = await fc.search(input);
      if (!result.ok) throw result.error;
      const envelope: ProviderResponseEnvelope & { results: typeof result.value } = {
        source_urls: [],
        provider_status: [{ provider: "firecrawl", ok: true }],
        warnings: [],
        results: result.value,
      };
      return envelope;
    },
  }),
  defineTool({
    name: "potter_web_crawl",
    description:
      "Crawl a site from a root URL up to max_pages (default 5, max 50). Uses Firecrawl's sitemap-aware crawler. Returns page contents. Use for multi-page collection: 'crawl https://vercel.com/changelog for the last 20 entries', 'crawl everything under docs.anthropic.com/en/docs', blog/release-notes subtrees, multi-page listings, anywhere the user implies more than one page. Include/exclude path globs filter which URLs get visited. For a SINGLE page, use potter_web_scrape instead. LinkedIn URLs are blocked server-side.",
    argsSchema: CrawlArgs,
    run: async ({ url, max_pages, include_patterns, exclude_patterns }) => {
      rejectIfLinkedInUrl("potter_web_crawl", url);
      const fc = getFirecrawl();
      const input: Parameters<typeof fc.crawl>[0] = { url };
      input.maxPages = max_pages ?? 5;
      if (include_patterns) input.includePatterns = include_patterns;
      if (exclude_patterns) input.excludePatterns = exclude_patterns;
      const result = await fc.crawl(input);
      if (!result.ok) throw result.error;
      const envelope: ProviderResponseEnvelope & { job: typeof result.value } = {
        source_urls: [url],
        provider_status: [{ provider: "firecrawl", ok: true }],
        warnings: [],
        job: result.value,
      };
      return envelope;
    },
  }),
];
