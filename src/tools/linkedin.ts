import { z } from "zod";
import { PotterError } from "../errors.js";
import {
  getLinkedInCompany,
  getLinkedInPosts,
  getLinkedInProfile,
} from "../providers/apify-actors.js";
import type { ProviderResponseEnvelope } from "../types.js";
import { isLinkedInUrl } from "../urls.js";
import { defineTool, type ToolDefinition } from "./registry.js";

const LinkedInUrl = z
  .string()
  .url()
  .refine((u) => isLinkedInUrl(u), {
    message: "URL must be a linkedin.com address (www., m., or touch. subdomain allowed)",
  });

const ProfileArgs = z
  .object({
    url: LinkedInUrl.describe("LinkedIn profile URL, e.g. https://www.linkedin.com/in/satyanadella/"),
    include: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of extra sections to include. Accepted tokens per spec §4: 'posts', 'company'. Not all are wired in v1; unsupported tokens are echoed back in warnings.",
      ),
  })
  .strict();

const CompanyArgs = z
  .object({
    url: LinkedInUrl.describe(
      "LinkedIn company URL, e.g. https://www.linkedin.com/company/stripe/",
    ),
    include: z
      .array(z.string())
      .optional()
      .describe("Optional list of extra sections. Unsupported tokens returned in warnings."),
  })
  .strict();

const PostsArgs = z
  .object({
    url: LinkedInUrl.describe("LinkedIn profile URL to scrape posts from."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Maximum posts to return (default 10, max 50)."),
    since: z
      .string()
      .optional()
      .describe(
        "Optional ISO date; posts older than this are filtered out client-side after the fetch.",
      ),
  })
  .strict();

const filterSince = <T extends { posted_at: string | null }>(
  items: T[],
  since: string | undefined,
): T[] => {
  if (!since) return items;
  const threshold = Date.parse(since);
  if (Number.isNaN(threshold)) return items;
  return items.filter((i) => {
    if (!i.posted_at) return true;
    const t = Date.parse(i.posted_at);
    return Number.isNaN(t) ? true : t >= threshold;
  });
};

const throwIfError = (r: { ok: false; error: PotterError } | { ok: true; value: unknown }): void => {
  if (!r.ok) throw r.error;
};

export const linkedinTools: ToolDefinition[] = [
  defineTool({
    name: "potter_linkedin_profile",
    description:
      "Fetch a single LinkedIn profile by URL and return a canonical profile payload (full_name, headline, about, experience[], education[], location, skills, counts, image). Uses Apify under the hood. Returns data_quality one of full/sparse/not_found/protected.",
    argsSchema: ProfileArgs,
    run: async ({ url, include }) => {
      const result = await getLinkedInProfile(url);
      throwIfError(result);
      if (!result.ok) throw result.error;
      const warnings: string[] = [];
      if (result.value.data_quality !== "full") {
        warnings.push(`data_quality=${result.value.data_quality}`);
      }
      if (include && include.length > 0) {
        warnings.push(`include tokens not yet supported in v1: ${include.join(",")}`);
      }
      const envelope: ProviderResponseEnvelope & { profile: typeof result.value } = {
        source_urls: [result.value.url],
        provider_status: [{ provider: "apify", ok: true }],
        warnings,
        profile: result.value,
      };
      return envelope;
    },
  }),
  defineTool({
    name: "potter_linkedin_company",
    description:
      "Fetch a single LinkedIn company page by URL and return canonical company data (name, tagline, description, website, industry, employee_count, follower_count, headquarters, founded_year, specialties, logo). Uses Apify.",
    argsSchema: CompanyArgs,
    run: async ({ url, include }) => {
      const result = await getLinkedInCompany(url);
      if (!result.ok) throw result.error;
      const warnings: string[] = [];
      if (result.value.data_quality !== "full") {
        warnings.push(`data_quality=${result.value.data_quality}`);
      }
      if (include && include.length > 0) {
        warnings.push(`include tokens not yet supported in v1: ${include.join(",")}`);
      }
      const envelope: ProviderResponseEnvelope & { company: typeof result.value } = {
        source_urls: [result.value.url],
        provider_status: [{ provider: "apify", ok: true }],
        warnings,
        company: result.value,
      };
      return envelope;
    },
  }),
  defineTool({
    name: "potter_linkedin_posts",
    description:
      "Fetch recent posts from a LinkedIn profile. Returns an array of canonical posts (text, posted_at, reactions_count, comments_count, reposts_count, media, author). Optional 'since' ISO date filters client-side. Uses Apify. Posts that don't have text+url are dropped automatically.",
    argsSchema: PostsArgs,
    run: async ({ url, limit, since }) => {
      const opts: { limit?: number } = {};
      if (limit !== undefined) opts.limit = limit;
      const result = await getLinkedInPosts(url, opts);
      if (!result.ok) throw result.error;
      const filtered = filterSince(result.value, since);
      const envelope: ProviderResponseEnvelope & {
        posts: typeof filtered;
        dropped_by_since: number;
      } = {
        source_urls: [url, ...filtered.map((p) => p.url).filter((u): u is string => u !== "")],
        provider_status: [{ provider: "apify", ok: true }],
        warnings: filtered.length === 0 ? ["no posts returned"] : [],
        posts: filtered,
        dropped_by_since: result.value.length - filtered.length,
      };
      return envelope;
    },
  }),
];
