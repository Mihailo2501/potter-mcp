import { beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../../src/config.js";
import { compositeTools } from "../../src/tools/composite.js";

const liveEnabled = process.env.POTTER_GOLDEN === "1";
const cfg = liveEnabled ? loadConfig() : null;
const hasFirecrawl = Boolean(cfg?.firecrawlApiKey);
const hasApify = Boolean(cfg?.apifyToken);

const findTool = (name: string) => {
  const tool = compositeTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found in compositeTools`);
  return tool;
};

const callTool = async (
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> => {
  const tool = findTool(name);
  return tool.handler(args);
};

const parseContent = (result: CallToolResult): Record<string, unknown> => {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text content block");
  return JSON.parse(block.text) as Record<string, unknown>;
};

const expectEnvelope = (payload: Record<string, unknown>) => {
  expect(Array.isArray(payload.source_urls)).toBe(true);
  expect(Array.isArray(payload.provider_status)).toBe(true);
  expect(Array.isArray(payload.warnings)).toBe(true);
};

beforeAll(() => {
  if (process.env.POTTER_QA_STUB_MODE === "true") {
    throw new Error(
      "Golden tests require POTTER_QA_STUB_MODE to be unset; got true. Stub mode short-circuits handlers and would invalidate the test.",
    );
  }
});

describe.runIf(liveEnabled)("potter_research_person", () => {
  it.runIf(hasApify && hasFirecrawl)(
    "returns a person dossier with profile + envelope + data_quality",
    async () => {
      const result = await callTool("potter_research_person", {
        linkedin_url: "https://www.linkedin.com/in/satyanadella/",
      });
      expect(result.isError).not.toBe(true);
      const payload = parseContent(result);
      expectEnvelope(payload);
      const person = payload.person as Record<string, unknown> | undefined;
      expect(person).toBeDefined();
      const profile = person?.profile as Record<string, unknown> | undefined;
      expect(profile?.full_name).toBeTruthy();
      expect(profile?.headline).toBeTruthy();
      expect(payload.data_quality).toBeDefined();
      expect((payload.source_urls as string[]).length).toBeGreaterThan(0);
    },
    300_000,
  );
});

describe.runIf(liveEnabled)("potter_research_company", () => {
  it.runIf(hasApify && hasFirecrawl)(
    "returns a company dossier with target + page scrapes + envelope",
    async () => {
      const result = await callTool("potter_research_company", {
        url_or_domain: "stripe.com",
      });
      expect(result.isError).not.toBe(true);
      const payload = parseContent(result);
      expectEnvelope(payload);
      const company = payload.company as Record<string, unknown> | undefined;
      expect(company).toBeDefined();
      const target = company?.target as Record<string, unknown> | undefined;
      expect(target?.domain).toBe("stripe.com");
      expect(payload.data_quality).toBeDefined();
      // At least one page scrape outcome should have produced data
      const pageKeys = company
        ? Object.keys(company).filter((k) => k.startsWith("page_"))
        : [];
      expect(pageKeys.length).toBeGreaterThan(0);
    },
    300_000,
  );
});

describe.runIf(liveEnabled)("potter_summarize_linkedin_posts", () => {
  it.runIf(hasApify)(
    "returns posts + heuristic_themes + notable_quotes + data_quality",
    async () => {
      const result = await callTool("potter_summarize_linkedin_posts", {
        linkedin_url: "https://www.linkedin.com/in/satyanadella/",
        limit: 5,
      });
      expect(result.isError).not.toBe(true);
      const payload = parseContent(result);
      expectEnvelope(payload);
      expect(Array.isArray(payload.posts)).toBe(true);
      expect(Array.isArray(payload.heuristic_themes)).toBe(true);
      expect(Array.isArray(payload.notable_quotes)).toBe(true);
      expect(typeof payload.post_count).toBe("number");
      expect(payload.data_quality).toBeDefined();
    },
    240_000,
  );
});

describe.runIf(liveEnabled)("potter_find_decision_maker", () => {
  it.runIf(hasApify)(
    "returns ranked candidates with match_reason for a concrete role",
    async () => {
      const result = await callTool("potter_find_decision_maker", {
        company_url_or_domain: "https://www.linkedin.com/company/stripe/",
        role_description: "Head of Engineering",
        num_candidates: 5,
      });
      expect(result.isError).not.toBe(true);
      const payload = parseContent(result);
      expectEnvelope(payload);
      expect(Array.isArray(payload.candidates)).toBe(true);
      expect(typeof payload.candidate_count).toBe("number");
      expect(payload.role_description).toBe("Head of Engineering");
      const candidates = payload.candidates as Array<Record<string, unknown>>;
      // Must return at least one candidate. An empty array silently passing is the
      // false-positive class we explicitly added this assertion to catch (Apify actor
      // quota cap, normalizer regression, or actor breakage). If this fails, check the
      // run's warnings for a quota message and the Apify dashboard for actor errors.
      expect(candidates.length).toBeGreaterThan(0);
      const first = candidates[0]!;
      expect(typeof first.score).toBe("number");
      expect(typeof first.match_reason).toBe("string");
      expect(typeof first.url).toBe("string");
      expect((first.url as string).length).toBeGreaterThan(0);
    },
    300_000,
  );
});

describe.runIf(liveEnabled)("potter_extract_structured", () => {
  it.runIf(hasFirecrawl)(
    "returns extracted JSON matching the supplied schema",
    async () => {
      const result = await callTool("potter_extract_structured", {
        url: "https://www.anthropic.com/pricing",
        schema: {
          type: "object",
          properties: {
            plans: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
                required: ["name"],
              },
            },
          },
          required: ["plans"],
        },
        prompt: "Extract the list of pricing plans.",
      });
      expect(result.isError).not.toBe(true);
      const payload = parseContent(result);
      expectEnvelope(payload);
      expect(payload.data_quality).toBeDefined();
      expect(payload.extracted).toBeDefined();
    },
    240_000,
  );
});
