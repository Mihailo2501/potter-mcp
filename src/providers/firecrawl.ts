import { Firecrawl } from "@mendable/firecrawl-js";
import type {
  Document,
  SearchData,
  CrawlJob,
  ScrapeOptions,
  CrawlOptions,
  SearchRequest,
  FormatOption,
} from "@mendable/firecrawl-js";
import pLimit from "p-limit";
import type { ZodTypeAny } from "zod";
import { loadConfig } from "../config.js";
import { PotterError } from "../errors.js";
import {
  canonicalizeDomain,
  canonicalizeWebUrl,
  isLinkedInDomain,
  isLinkedInUrl,
} from "../urls.js";

const PROVIDER = "firecrawl" as const;
const MAX_BACKOFF_MS = 30_000;

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: PotterError };

interface FirecrawlScrapeInput {
  url: string;
  formats?: FormatOption[];
  onlyMainContent?: boolean;
  waitFor?: number;
  timeoutMs?: number;
  includeTags?: string[];
  excludeTags?: string[];
}

interface FirecrawlSearchInput {
  query: string;
  limit?: number;
  site?: string;
  scrapeOptions?: ScrapeOptions;
}

interface FirecrawlCrawlInput {
  url: string;
  maxPages?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  timeoutMs?: number;
}

interface FirecrawlExtractInput {
  url: string;
  schema?: ZodTypeAny | Record<string, unknown>;
  prompt?: string;
  timeoutMs?: number;
}

const extractStatus = (err: unknown): number | undefined => {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  return e.status ?? e.statusCode ?? e.response?.status;
};

const isRetryableStatus = (status: number | undefined): boolean =>
  status === 429 || status === 502 || status === 503 || status === 504;

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);

const rejectLinkedIn = (tool: string, detail: string): never => {
  throw new PotterError({
    tool,
    provider: PROVIDER,
    reason: `LinkedIn target rejected: ${detail}. Use potter_linkedin_* primitives for LinkedIn data.`,
    retryable: false,
    recommended_action:
      "Route LinkedIn lookups through potter_linkedin_profile / potter_linkedin_company / potter_linkedin_posts.",
  });
};

const toPotterError = (tool: string, err: unknown): PotterError => {
  if (err instanceof PotterError) return err;
  const status = extractStatus(err);
  return new PotterError({
    tool,
    provider: PROVIDER,
    reason: messageOf(err),
    retryable: isRetryableStatus(status),
    status_code: status,
    recommended_action:
      status === 401 || status === 403
        ? "Check POTTER_FIRECRAWL_API_KEY — current key was rejected."
        : status === 429
          ? "Firecrawl rate-limited this call. Retry later or lower POTTER_CONCURRENCY_LIMIT."
          : "Check Firecrawl dashboard for credit balance and incident status.",
  });
};

class FirecrawlProvider {
  private client: Firecrawl | null = null;
  private readonly limit = pLimit(loadConfig().concurrencyLimit);

  private getClient(tool: string): Firecrawl {
    if (this.client) return this.client;
    const cfg = loadConfig();
    if (!cfg.firecrawlApiKey) {
      throw new PotterError({
        tool,
        provider: PROVIDER,
        reason: "POTTER_FIRECRAWL_API_KEY is not set.",
        retryable: false,
        recommended_action:
          "Add POTTER_FIRECRAWL_API_KEY to .env (get one at https://firecrawl.dev) and restart Potter.",
      });
    }
    this.client = new Firecrawl({
      apiKey: cfg.firecrawlApiKey,
      timeoutMs: cfg.providerTimeoutMs,
    });
    return this.client;
  }

  private async withRetries<T>(tool: string, op: () => Promise<T>): Promise<T> {
    const cfg = loadConfig();
    const maxAttempts = cfg.maxRetries + 1;
    let attempt = 0;
    let delay = 500;
    while (true) {
      try {
        return await op();
      } catch (err) {
        attempt += 1;
        const status = extractStatus(err);
        if (attempt >= maxAttempts || !isRetryableStatus(status)) {
          throw toPotterError(tool, err);
        }
        const jitter = Math.random() * 250;
        const wait = Math.min(delay + jitter, MAX_BACKOFF_MS);
        await new Promise((resolve) => setTimeout(resolve, wait));
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private wrap<T>(tool: string, op: () => Promise<T>): Promise<Result<T>> {
    return this.limit(async () => {
      try {
        const value = await this.withRetries(tool, op);
        return { ok: true as const, value };
      } catch (err) {
        return { ok: false as const, error: toPotterError(tool, err) };
      }
    });
  }

  scrape(input: FirecrawlScrapeInput): Promise<Result<Document>> {
    const tool = "potter_web_scrape";
    return this.wrap(tool, async () => {
      if (isLinkedInUrl(input.url)) rejectLinkedIn(tool, input.url);
      const cfg = loadConfig();
      const url = await canonicalizeWebUrl(input.url, cfg.allowPrivateUrls);
      const options: ScrapeOptions = {};
      if (input.formats) options.formats = input.formats;
      if (input.onlyMainContent !== undefined) options.onlyMainContent = input.onlyMainContent;
      if (input.waitFor !== undefined) options.waitFor = input.waitFor;
      if (input.timeoutMs !== undefined) options.timeout = input.timeoutMs;
      if (input.includeTags) options.includeTags = input.includeTags;
      if (input.excludeTags) options.excludeTags = input.excludeTags;
      return this.getClient(tool).scrape(url, options);
    });
  }

  search(input: FirecrawlSearchInput): Promise<Result<SearchData>> {
    const tool = "potter_web_search";
    return this.wrap(tool, async () => {
      let query = input.query;
      if (input.site) {
        if (isLinkedInDomain(input.site)) rejectLinkedIn(tool, `site:${input.site}`);
        const domain = canonicalizeDomain(input.site);
        query = `${input.query} site:${domain}`;
      }
      const req: Omit<SearchRequest, "query"> = {};
      if (input.limit !== undefined) req.limit = input.limit;
      if (input.scrapeOptions) req.scrapeOptions = input.scrapeOptions;
      return this.getClient(tool).search(query, req);
    });
  }

  crawl(input: FirecrawlCrawlInput): Promise<Result<CrawlJob>> {
    const tool = "potter_web_crawl";
    return this.wrap(tool, async () => {
      if (isLinkedInUrl(input.url)) rejectLinkedIn(tool, input.url);
      const cfg = loadConfig();
      const url = await canonicalizeWebUrl(input.url, cfg.allowPrivateUrls);
      const opts: CrawlOptions & { pollInterval?: number; timeout?: number } = {};
      if (input.maxPages !== undefined) opts.limit = input.maxPages;
      if (input.includePatterns) opts.includePaths = input.includePatterns;
      if (input.excludePatterns) opts.excludePaths = input.excludePatterns;
      const timeoutSeconds = Math.ceil((input.timeoutMs ?? cfg.providerTimeoutMs) / 1000);
      opts.timeout = timeoutSeconds;
      return this.getClient(tool).crawl(url, opts);
    });
  }

  extract(input: FirecrawlExtractInput): Promise<Result<Document>> {
    const tool = "potter_extract_structured";
    return this.wrap(tool, async () => {
      if (isLinkedInUrl(input.url)) rejectLinkedIn(tool, input.url);
      const cfg = loadConfig();
      const url = await canonicalizeWebUrl(input.url, cfg.allowPrivateUrls);
      const jsonFormat: FormatOption = {
        type: "json",
        ...(input.schema ? { schema: input.schema as Record<string, unknown> } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
      };
      const options: ScrapeOptions = { formats: [jsonFormat] };
      if (input.timeoutMs !== undefined) options.timeout = input.timeoutMs;
      return this.getClient(tool).scrape(url, options);
    });
  }
}

let instance: FirecrawlProvider | null = null;

export const getFirecrawl = (): FirecrawlProvider => {
  if (instance === null) instance = new FirecrawlProvider();
  return instance;
};

export type {
  Document as FirecrawlDocument,
  SearchData as FirecrawlSearchData,
  CrawlJob as FirecrawlCrawlJob,
};
