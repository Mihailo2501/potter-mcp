import { z } from "zod";
import { extractNotableQuotes, extractThemes } from "../composite/theme-extractor.js";
import {
  buildCompositeEnvelope,
  COMPOSITE_CONCURRENCY_LIMIT,
  deriveConfidence,
  enforceSchemaConstraints,
  escapeSearchTerm,
  isSettledOk,
  outcomeFromResult,
  outcomeFromSettled,
  quotedPhrase,
  resolveCompanyTarget,
  resolveLinkedInCompanyUrlFromDomain,
  runParallel,
  similarity,
  type CompositeProvider,
  type SubCallOutcome,
} from "../composite/utils.js";
import { PotterError } from "../errors.js";
import { getFirecrawl } from "../providers/firecrawl.js";
import {
  getLinkedInCompany,
  getLinkedInEmployees,
  getLinkedInPosts,
  getLinkedInProfile,
} from "../providers/apify-actors.js";
import type {
  CanonicalCompany,
  CanonicalEmployee,
  CanonicalPost,
  CanonicalProfile,
  ProviderStatusEntry,
} from "../types.js";
import {
  canonicalizeLinkedInProfileUrl,
  ensureUrlAllowed,
  isLinkedInUrl,
} from "../urls.js";
import { loadConfig } from "../config.js";
import { defineTool, type ToolDefinition } from "./registry.js";

const LinkedInProfileUrl = z
  .string()
  .url()
  .refine((u) => isLinkedInUrl(u) && /\/(?:[a-z]{2}\/)?in\//i.test(new URL(u).pathname), {
    message: "Must be a LinkedIn profile URL with /in/<slug>",
  });

const ResearchPersonArgs = z
  .object({
    linkedin_url: LinkedInProfileUrl.describe("LinkedIn profile URL."),
    context: z
      .string()
      .optional()
      .describe("Optional free-text context that biases news-search queries."),
    include_github: z
      .boolean()
      .optional()
      .describe("If true, attempt a GitHub profile lookup based on the headline/name. Defaults to false."),
  })
  .strict();

const ResearchCompanyArgs = z
  .object({
    url_or_domain: z
      .string()
      .min(1)
      .describe(
        "Company LinkedIn URL or domain (e.g. 'anthropic.com' or 'https://www.linkedin.com/company/trustvanta/').",
      ),
    focus: z
      .string()
      .optional()
      .describe("Optional free-text bias (e.g. 'hiring', 'pricing', 'product launches')."),
  })
  .strict();

const SummarizePostsArgs = z
  .object({
    linkedin_url: LinkedInProfileUrl,
    limit: z.number().int().min(3).max(50).optional().describe("Max posts to fetch. Defaults to 10."),
    time_window: z
      .enum(["week", "month", "quarter", "year", "all"])
      .optional()
      .describe("Client-side filter on posted_at. Defaults to 'all'."),
  })
  .strict();

const FindDecisionMakerArgs = z
  .object({
    company_url_or_domain: z.string().min(1),
    role_description: z.string().min(2),
    seniority: z
      .enum(["ic", "lead", "manager", "director", "vp", "c_suite"])
      .optional(),
    num_candidates: z.number().int().min(1).max(25).optional().describe("Number of candidates to return. Defaults to 5."),
  })
  .strict();

const ExtractStructuredArgs = z
  .object({
    url: z.string().url(),
    schema: z
      .record(z.string(), z.unknown())
      .describe("JSON Schema describing the desired extraction shape."),
    prompt: z
      .string()
      .optional()
      .describe("Optional natural-language hint for the extractor."),
  })
  .strict();

const SENIORITY_TOKENS: Record<string, string[]> = {
  ic: ["engineer", "analyst", "designer", "specialist", "developer"],
  lead: ["lead", "staff", "principal", "tech lead"],
  manager: ["manager", "head"],
  director: ["director"],
  vp: ["vp", "vice president"],
  c_suite: ["chief", "ceo", "cto", "cmo", "coo", "cfo", "cpo", "founder"],
};

const timeWindowCutoff = (window: string): number | null => {
  const now = Date.now();
  switch (window) {
    case "week":
      return now - 7 * 86_400_000;
    case "month":
      return now - 30 * 86_400_000;
    case "quarter":
      return now - 90 * 86_400_000;
    case "year":
      return now - 365 * 86_400_000;
    default:
      return null;
  }
};

const researchPersonTool = defineTool({
  name: "potter_research_person",
  description:
    "BETA: Research a person by LinkedIn URL. Runs profile, recent posts, current company, and a Firecrawl news search in parallel. Returns a consolidated dossier with data_quality and partial-failure information. Uses Apify (LinkedIn); quality depends on the Apify profile actor benchmark trail (see docs/provider-benchmarks.md). Reasonable for quick research; do not use for high-volume enrichment.",
  argsSchema: ResearchPersonArgs,
  run: async ({ linkedin_url, context, include_github }) => {
    const profileUrl = canonicalizeLinkedInProfileUrl(linkedin_url);
    const profileResult = await getLinkedInProfile(profileUrl);
    const outcomes: SubCallOutcome[] = [outcomeFromResult("profile", "apify", profileResult)];

    if (!profileResult.ok) {
      return buildCompositeEnvelope(
        {
          source_urls: [profileUrl],
          outcomes,
          core_failure: { key: "profile", provider: "apify", failure_point: "apify_profile" },
          warnings: ["profile lookup failed; no downstream calls attempted"],
          limitations: [],
        },
        { person: {} },
      );
    }

    const profile = profileResult.value;
    const name = profile.full_name ?? "";
    const company = profile.current_company ?? "";
    const headline = profile.headline ?? "";

    const tasks: Array<{ key: string; provider: CompositeProvider; fn: () => Promise<unknown> }> = [];
    tasks.push({
      key: "posts",
      provider: "apify",
      fn: async () => {
        const r = await getLinkedInPosts(profileUrl, { limit: 5 });
        if (!r.ok) throw r.error;
        return r.value;
      },
    });
    if (profile.current_company_url) {
      tasks.push({
        key: "current_company",
        provider: "apify",
        fn: async () => {
          const r = await getLinkedInCompany(profile.current_company_url!);
          if (!r.ok) throw r.error;
          return r.value;
        },
      });
    }
    if (name) {
      const query = [
        quotedPhrase(name),
        company ? quotedPhrase(company) : "",
        escapeSearchTerm(headline),
        escapeSearchTerm(context ?? ""),
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      tasks.push({
        key: "news",
        provider: "firecrawl",
        fn: async () => {
          const r = await getFirecrawl().search({ query, limit: 5 });
          if (!r.ok) throw r.error;
          return r.value;
        },
      });
    }
    if (include_github && name) {
      tasks.push({
        key: "github",
        provider: "firecrawl",
        fn: async () => {
          const r = await getFirecrawl().search({
            query: quotedPhrase(name),
            site: "github.com",
            limit: 3,
          });
          if (!r.ok) throw r.error;
          return r.value;
        },
      });
    }

    const settled = await runParallel(tasks.map((t) => t.fn), COMPOSITE_CONCURRENCY_LIMIT);
    for (let i = 0; i < settled.length; i += 1) {
      outcomes.push(outcomeFromSettled(tasks[i]!.key, tasks[i]!.provider, settled[i]!));
    }

    let staleCompanyWarning: string | null = null;
    if (profile.current_company && profile.current_company_url) {
      const companyOutcome = outcomes.find((o) => o.key === "current_company");
      if (companyOutcome?.ok && typeof companyOutcome.value === "object" && companyOutcome.value !== null) {
        const fetchedName = (companyOutcome.value as { name?: string }).name ?? "";
        if (fetchedName && similarity(fetchedName, profile.current_company) < 0.4) {
          staleCompanyWarning = `current_company_url resolved to "${fetchedName}" but profile.current_company is "${profile.current_company}"; may be stale`;
        }
      }
    }

    const person: Record<string, unknown> = { profile };
    for (const o of outcomes.slice(1)) {
      if (o.ok) person[o.key] = o.value;
    }

    const warnings: string[] = [];
    if (staleCompanyWarning) warnings.push(staleCompanyWarning);

    return buildCompositeEnvelope(
      {
        source_urls: [profileUrl],
        outcomes,
        warnings,
        limitations: context ? [] : ["no context hint provided; news search may be broad"],
        weights: { profile: 3, posts: 2, current_company: 2, news: 1, github: 1 },
      },
      { person },
    );
  },
});

const COMPANY_PATHS = ["/", "/about", "/pricing", "/careers", "/blog", "/press"] as const;

const researchCompanyTool = defineTool({
  name: "potter_research_company",
  description:
    "Research a company by LinkedIn company URL or domain. Fans out Firecrawl scrapes across root / about / pricing / careers / blog / press pages, plus a news search. Use this for ANY company-level question once a company URL or domain is in the prompt: hiring questions ('Is Ramp hiring engineers?', 'Check if Linear.app is hiring backend engineers' (the /careers scrape answers these directly)), pricing questions, tech-stack questions, product-launch questions, generic 'rundown / info / research' phrasings, even short yes/no asks. Cheaper-feeling alternatives like potter_web_search lose context the company dossier provides. Optional 'focus' adds extra terms to the news search only. Returns a consolidated company dossier with data_quality.",
  argsSchema: ResearchCompanyArgs,
  run: async ({ url_or_domain, focus }) => {
    const target = resolveCompanyTarget(url_or_domain);
    let derivedDomain = target.domain;
    const outcomes: SubCallOutcome[] = [];
    const warnings: string[] = [];

    let resolvedLinkedInUrl: string | null = target.linkedin_url;
    if (!resolvedLinkedInUrl && target.domain) {
      const resolved = await resolveLinkedInCompanyUrlFromDomain(target.domain);
      if (resolved) {
        resolvedLinkedInUrl = resolved;
        warnings.push(
          `linkedin_url resolved from domain "${target.domain}" via Firecrawl: ${resolved}`,
        );
      }
    }

    if (resolvedLinkedInUrl) {
      const r = await getLinkedInCompany(resolvedLinkedInUrl);
      outcomes.push(outcomeFromResult("linkedin", "apify", r));
      if (r.ok && !derivedDomain && r.value.website) {
        try {
          derivedDomain = new URL(
            r.value.website.startsWith("http") ? r.value.website : `https://${r.value.website}`,
          ).hostname.replace(/^www\./, "");
          warnings.push(`domain derived from LinkedIn company.website: ${derivedDomain}`);
        } catch {
          /* ignore */
        }
      }
    }

    const pageTasks: Array<{ key: string; provider: CompositeProvider; fn: () => Promise<unknown> }> = [];
    if (derivedDomain) {
      const base = `https://${derivedDomain}`;
      for (const path of COMPANY_PATHS) {
        pageTasks.push({
          key: `page_${path === "/" ? "root" : path.slice(1)}`,
          provider: "firecrawl",
          fn: async () => {
            const r = await getFirecrawl().scrape({
              url: `${base}${path}`,
              formats: ["markdown"],
            });
            if (!r.ok) throw r.error;
            return r.value;
          },
        });
      }
      const newsQuery = focus
        ? `${quotedPhrase(derivedDomain)} ${escapeSearchTerm(focus)}`
        : `${quotedPhrase(derivedDomain)} news`;
      pageTasks.push({
        key: "news",
        provider: "firecrawl",
        fn: async () => {
          const r = await getFirecrawl().search({ query: newsQuery, limit: 5 });
          if (!r.ok) throw r.error;
          return r.value;
        },
      });
    }

    const settled = await runParallel(pageTasks.map((t) => t.fn), COMPOSITE_CONCURRENCY_LIMIT);
    for (let i = 0; i < settled.length; i += 1) {
      outcomes.push(outcomeFromSettled(pageTasks[i]!.key, pageTasks[i]!.provider, settled[i]!));
    }

    const parts: Record<string, unknown> = { target };
    for (const o of outcomes) {
      if (o.ok) parts[o.key] = o.value;
    }

    return buildCompositeEnvelope(
      {
        source_urls: [
          ...(resolvedLinkedInUrl ? [resolvedLinkedInUrl] : []),
          ...(derivedDomain ? [`https://${derivedDomain}`] : []),
        ],
        outcomes,
        warnings,
        limitations: focus ? [] : ["no focus bias applied to page selection in v1"],
        weights: {
          linkedin: 3,
          page_root: 3,
          page_about: 2,
          page_pricing: 2,
          page_careers: 1,
          page_blog: 1,
          page_press: 1,
          news: 1,
        },
      },
      { company: parts },
    );
  },
});

const summarizePostsTool = defineTool({
  name: "potter_summarize_linkedin_posts",
  description:
    "BETA: Fetch a profile's recent posts and return heuristic themes (tf-idf, no LLM), notable quotes (engagement-ranked), and the raw posts. REQUIRES an explicit LinkedIn profile URL. Does NOT search for the profile. If the user names a person without giving a LinkedIn URL ('What's Tim Yakubson been talking about lately?'), call potter_web_search first to locate the profile, then call this tool with the resolved URL. Use time_window to filter: week / month / quarter / year / all. Quality depends on the Apify posts actor benchmark trail; see docs/provider-benchmarks.md.",
  argsSchema: SummarizePostsArgs,
  run: async ({ linkedin_url, limit, time_window }) => {
    const result = await getLinkedInPosts(linkedin_url, { limit });
    const outcomes: SubCallOutcome[] = [outcomeFromResult("posts", "apify", result)];
    if (!result.ok) {
      return buildCompositeEnvelope(
        {
          source_urls: [linkedin_url],
          outcomes,
          core_failure: { key: "posts", provider: "apify", failure_point: "apify_posts" },
          warnings: ["posts fetch failed; no themes extracted"],
          limitations: [],
        },
        {
          heuristic_themes: [],
          notable_quotes: [],
          posts: [],
          post_count: 0,
          date_unknown_count: 0,
        },
      );
    }
    const cutoff = timeWindowCutoff(time_window ?? "all");
    const dateUnknown: CanonicalPost[] = [];
    const inWindow: CanonicalPost[] = [];
    for (const p of result.value) {
      if (!p.posted_at) {
        dateUnknown.push(p);
        continue;
      }
      if (cutoff === null) {
        inWindow.push(p);
        continue;
      }
      const t = Date.parse(p.posted_at);
      // Apify post actors sometimes return relative date strings ("2w", "3d ago") that Date.parse
      // cannot resolve. Treat those as date-unknown rather than silently dropping them; the
      // primitive potter_linkedin_posts filter does the same (keeps unparseable dates).
      if (Number.isNaN(t)) {
        dateUnknown.push(p);
        continue;
      }
      if (t >= cutoff) inWindow.push(p);
    }
    const filtered = cutoff === null ? inWindow : [...inWindow, ...dateUnknown];

    const themes = extractThemes({
      posts: filtered.map((p) => ({ text: p.text, url: p.url })),
    });
    const quotes = extractNotableQuotes(filtered);

    const warnings: string[] = [];
    if (filtered.length === 0) warnings.push("no posts matched the time_window filter");
    if (filtered.length < 3) warnings.push("fewer than 3 posts; themes are low-signal");
    if (dateUnknown.length > 0 && cutoff !== null) {
      warnings.push(
        `${dateUnknown.length} posts had no parseable timestamp; kept with time_window=${time_window} but may be older than the window`,
      );
    }
    if (themes.length === 0 && filtered.length > 0) {
      warnings.push("posts contained insufficient distinct content; no heuristic themes produced");
    }

    const limitations: string[] = [
      "heuristic_themes use tf-idf; no LLM summarization in v1",
    ];
    if (quotes.length > 0 && quotes.every((q) => q.engagement_score === 0)) {
      limitations.push("notable_quotes are length-sorted only (all candidates had zero engagement)");
    }

    const hasUsableThemes = themes.length > 0;
    const hasQuotes = quotes.length > 0;
    const passes = [filtered.length >= 3, hasUsableThemes, hasQuotes].filter(Boolean).length;
    const confidence =
      passes === 3 ? "high" : passes === 2 ? "medium" : "low";

    return {
      source_urls: [linkedin_url, ...filtered.map((p) => p.url).filter((u) => u !== "")],
      provider_status: [{ provider: "apify", ok: true }],
      warnings,
      data_quality: {
        confidence,
        missing_fields: [],
        limitations,
      },
      heuristic_themes: themes,
      notable_quotes: quotes,
      posts: filtered,
      post_count: filtered.length,
      date_unknown_count: dateUnknown.length,
    };
  },
});

const matchSeniority = (text: string, seniority?: string): number => {
  if (!seniority) return 0;
  const t = text.toLowerCase();
  const tokens = SENIORITY_TOKENS[seniority] ?? [];
  for (const token of tokens) if (t.includes(token)) return 1;
  return 0;
};

const tokenize = (s: string): Set<string> => {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  );
};

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const scoreEmployee = (
  emp: CanonicalEmployee,
  role: string,
  seniority?: string,
): { score: number; match_reason: string } => {
  const combined = `${emp.headline ?? ""} ${emp.current_title ?? ""}`.trim();
  const roleTokens = tokenize(role);
  const combinedTokens = tokenize(combined);
  const tokenOverlap = jaccard(roleTokens, combinedTokens);
  const charSim = similarity(role, combined);
  const seniorityBoost = matchSeniority(combined, seniority) * 0.2;
  const score = tokenOverlap * 0.5 + charSim * 0.3 + seniorityBoost;
  const pieces = [
    `token_overlap=${tokenOverlap.toFixed(2)}`,
    `char_similarity=${charSim.toFixed(2)}`,
  ];
  if (seniority) pieces.push(`seniority_match=${seniorityBoost > 0 ? "yes" : "no"}`);
  return { score, match_reason: pieces.join(", ") };
};

const findDecisionMakerTool = defineTool({
  name: "potter_find_decision_maker",
  description:
    "BETA: Find likely decision-makers at a company for a given role. Takes the company (LinkedIn URL or domain) + role_description. Returns a ranked list of enriched employee candidates with match_reason (max 25 candidates, hard-capped server-side). Seniority filter is optional. Bulk-employee enumeration is not supported. Generic role_descriptions like 'employee', 'employees', 'people', 'staff', 'workers', 'everyone', 'anyone' are rejected server-side with a structured 'role-required' error; pass a concrete role like 'platform engineer' or 'security lead'. On 'find every X at Y' / 'pull every employee' / 'scrape all engineers' prompts, still call this tool with whatever concrete role you can infer; the structured error is the right way to surface 'be more specific' to the user, and refusing without calling is incorrect. Uses the internal Apify employees actor. Honest fallback to company data + a suggested search strategy if the actor returns empty.",
  argsSchema: FindDecisionMakerArgs,
  run: async ({ company_url_or_domain, role_description, seniority, num_candidates }) => {
    const normalizedRole = role_description.trim().toLowerCase();
    if (/^(all\s+)?(employees?|people|staff|workers|everyone|anyone|everybody|anybody)$/i.test(normalizedRole)) {
      throw new PotterError({
        tool: "potter_find_decision_maker",
        provider: "potter",
        reason: `role_description="${role_description}" is too generic; bulk-employee enumeration is not supported.`,
        retryable: false,
        recommended_action:
          "Pass a concrete role (e.g. 'platform engineer', 'security lead', 'head of revenue') or add a seniority filter.",
      });
    }
    const target = resolveCompanyTarget(company_url_or_domain);
    const outcomes: SubCallOutcome[] = [];
    const warnings: string[] = [];

    let resolvedLinkedInUrl: string | null = target.linkedin_url;
    if (!resolvedLinkedInUrl && target.domain) {
      const resolved = await resolveLinkedInCompanyUrlFromDomain(target.domain);
      if (resolved) {
        resolvedLinkedInUrl = resolved;
        warnings.push(
          `linkedin_url resolved from domain "${target.domain}" via Firecrawl: ${resolved}`,
        );
      }
    }
    if (!resolvedLinkedInUrl) {
      warnings.push(
        `no linkedin_url could be resolved from "${company_url_or_domain}"; employees lookup skipped`,
      );
    }

    let company: CanonicalCompany | null = null;
    if (resolvedLinkedInUrl) {
      const r = await getLinkedInCompany(resolvedLinkedInUrl);
      outcomes.push(outcomeFromResult("company", "apify", r));
      if (r.ok) company = r.value;
    }

    let employees: CanonicalEmployee[] = [];
    if (resolvedLinkedInUrl) {
      const r = await getLinkedInEmployees(resolvedLinkedInUrl, { limit: 25 });
      outcomes.push(outcomeFromResult("employees", "apify", r));
      if (r.ok) employees = r.value;
    }

    const ranked = employees
      .map((emp) => ({ emp, ...scoreEmployee(emp, role_description, seniority) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, num_candidates)
      .map(({ emp, score, match_reason }) => ({ ...emp, score, match_reason }));

    if (ranked.length === 0) {
      warnings.push(
        `no employee results; consider LinkedIn Sales Navigator search with role="${escapeSearchTerm(role_description)}"${seniority ? `, seniority=${seniority}` : ""}`,
      );
    }

    if (!resolvedLinkedInUrl) {
      return buildCompositeEnvelope(
        {
          source_urls: target.domain ? [`https://${target.domain}`] : [],
          outcomes,
          core_failure: {
            key: "employees",
            provider: "apify",
            failure_point: "apify_employees",
          },
          warnings,
          limitations: [
            "cannot look up employees: domain → LinkedIn URL resolver returned no candidate, and no LinkedIn URL was supplied",
          ],
        },
        {
          role_description,
          seniority: seniority ?? null,
          candidates: [],
          candidate_count: 0,
        },
      );
    }

    return buildCompositeEnvelope(
      {
        source_urls: [
          resolvedLinkedInUrl,
          ...ranked.map((c) => c.url).filter((u) => u !== ""),
        ],
        outcomes,
        warnings,
        limitations: [
          "scoring is token-overlap + char-similarity + seniority heuristics; no LLM",
        ],
        weights: { company: 1, employees: 3 },
      },
      {
        company: company ?? target,
        role_description,
        seniority: seniority ?? null,
        candidates: ranked,
        candidate_count: ranked.length,
      },
    );
  },
});

const extractStructuredTool = defineTool({
  name: "potter_extract_structured",
  description:
    "Extract structured data from a URL against a user-provided JSON Schema. Schema is depth-capped at 5 levels and forced to additionalProperties:false on every object. Backed by Firecrawl's JSON format. URLs are validated server-side: LinkedIn URLs return a structured error with a redirect hint to potter_linkedin_*, and private/loopback hosts (localhost, 127.0.0.1, *.local, RFC1918 ranges, cloud metadata IPs) return a blocked-host structured error. Call this tool normally on those URLs and surface the structured error instead of pre-routing.",
  argsSchema: ExtractStructuredArgs,
  run: async ({ url, schema, prompt }) => {
    if (isLinkedInUrl(url)) {
      throw new PotterError({
        tool: "potter_extract_structured",
        provider: "firecrawl",
        reason: "LinkedIn URLs are not supported by potter_extract_structured. Use potter_linkedin_* primitives.",
        retryable: false,
        recommended_action: "Route LinkedIn lookups through potter_linkedin_profile/company.",
      });
    }
    try {
      ensureUrlAllowed(url, loadConfig().allowPrivateUrls);
    } catch (err) {
      throw new PotterError({
        tool: "potter_extract_structured",
        provider: "potter",
        reason: err instanceof Error ? err.message : String(err),
        retryable: false,
        recommended_action:
          "Use a public http(s) URL. Private/loopback/metadata hosts are blocked unless POTTER_ALLOW_PRIVATE_URLS=true.",
      });
    }
    let constrained: Record<string, unknown>;
    try {
      constrained = enforceSchemaConstraints(JSON.parse(JSON.stringify(schema)));
    } catch (err) {
      throw new PotterError({
        tool: "potter_extract_structured",
        provider: "potter",
        reason: err instanceof Error ? err.message : String(err),
        retryable: false,
        recommended_action: "Provide a JSON Schema with depth <= 5.",
      });
    }

    const extractInput: Parameters<ReturnType<typeof getFirecrawl>["extract"]>[0] = {
      url,
      schema: constrained,
    };
    if (prompt !== undefined) extractInput.prompt = prompt;
    const result = await getFirecrawl().extract(extractInput);
    if (!result.ok) throw result.error;
    const doc = result.value as { json?: unknown };
    return {
      source_urls: [url],
      provider_status: [{ provider: "firecrawl", ok: true }],
      warnings: [],
      data_quality: {
        confidence: doc.json ? "high" : "low",
        missing_fields: doc.json ? [] : ["json extraction returned empty"],
        limitations: [],
      },
      extracted: doc.json ?? null,
    };
  },
});

export const compositeTools: ToolDefinition[] = [
  researchPersonTool,
  researchCompanyTool,
  summarizePostsTool,
  findDecisionMakerTool,
  extractStructuredTool,
];
