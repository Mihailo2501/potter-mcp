import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { getFirecrawl } from "../src/providers/firecrawl.js";
import {
  closeAllStagehandSessions,
  getStagehand,
} from "../src/providers/stagehand.js";
import {
  getLinkedInCompany,
  getLinkedInEmployees,
  getLinkedInPosts,
  getLinkedInProfile,
} from "../src/providers/apify-actors.js";

const liveEnabled = process.env.POTTER_SMOKE === "1";
const cfg = liveEnabled ? loadConfig() : null;
const hasFirecrawl = Boolean(cfg?.firecrawlApiKey);
const hasBrowserbase = Boolean(cfg?.browserbaseApiKey && cfg?.browserbaseProjectId);
const hasApify = Boolean(cfg?.apifyToken);

describe.runIf(liveEnabled)("live Firecrawl", () => {
  it.runIf(hasFirecrawl)(
    "scrape returns markdown for example.com",
    async () => {
      const result = await getFirecrawl().scrape({
        url: "https://example.com",
        formats: ["markdown"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value.markdown).toBe("string");
        expect((result.value.markdown ?? "").length).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  it.runIf(hasFirecrawl)(
    "extract returns structured json for anthropic pricing",
    async () => {
      const result = await getFirecrawl().extract({
        url: "https://www.anthropic.com/pricing",
        prompt: "Extract the list of pricing plans with name and a short description.",
        schema: {
          type: "object",
          properties: {
            plans: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                },
                required: ["name"],
              },
            },
          },
          required: ["plans"],
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const json = (result.value as { json?: { plans?: unknown[] } }).json;
        expect(Array.isArray(json?.plans)).toBe(true);
      }
    },
    180_000,
  );

  it.runIf(hasFirecrawl)("search returns results", async () => {
    const result = await getFirecrawl().search({
      query: "anthropic claude api",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const web = (result.value as { web?: unknown[] }).web;
      expect(Array.isArray(web)).toBe(true);
    }
  }, 60_000);
});

describe.runIf(liveEnabled)("live Stagehand", () => {
  afterAll(async () => {
    await closeAllStagehandSessions();
  });

  it.runIf(hasBrowserbase)(
    "session lifecycle on Browserbase opens, extracts, closes",
    async () => {
      const manager = getStagehand();
      const session = await manager.createSession();
      expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(manager.size()).toBeGreaterThan(0);
      const look = manager.getSession(session.id);
      expect(look.id).toBe(session.id);
      await manager.closeSession(session.id);
      expect(manager.size()).toBe(0);
    },
    180_000,
  );

  it.runIf(hasBrowserbase)("unknown session id throws structured error", () => {
    expect(() => getStagehand().getSession("00000000-0000-0000-0000-000000000000")).toThrow(
      /session/i,
    );
  });
});

describe.runIf(liveEnabled)("live Apify (LinkedIn)", () => {
  it.runIf(hasApify)(
    "linkedin profile returns canonical shape with data_quality full",
    async () => {
      const r = await getLinkedInProfile("https://www.linkedin.com/in/satyanadella/");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.url).toBe("https://www.linkedin.com/in/satyanadella/");
        expect(r.value.data_quality).toBe("full");
        expect(r.value.full_name).toBeTruthy();
        expect(r.value.headline).toBeTruthy();
        expect(r.value.experience.length).toBeGreaterThan(0);
      }
    },
    180_000,
  );

  it.runIf(hasApify)(
    "linkedin company returns canonical shape with data_quality full",
    async () => {
      const r = await getLinkedInCompany("https://www.linkedin.com/company/stripe/");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.url).toBe("https://www.linkedin.com/company/stripe/");
        expect(r.value.data_quality).toBe("full");
        expect(r.value.name).toBe("Stripe");
        expect(typeof r.value.employee_count).toBe("number");
      }
    },
    180_000,
  );

  it.runIf(hasApify)(
    "linkedin posts returns canonical post array",
    async () => {
      const r = await getLinkedInPosts("https://www.linkedin.com/in/satyanadella/", {
        limit: 5,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Array.isArray(r.value)).toBe(true);
        expect(r.value.length).toBeGreaterThan(0);
        const first = r.value[0]!;
        expect(first.url).toBeTruthy();
        expect(typeof first.text).toBe("string");
      }
    },
    180_000,
  );

  it.runIf(hasApify)(
    "linkedin employees returns canonical employee array",
    async () => {
      const r = await getLinkedInEmployees("https://www.linkedin.com/company/stripe/", {
        limit: 5,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Array.isArray(r.value)).toBe(true);
        if (r.value.length > 0) {
          expect(r.value[0]!.url).toBeTruthy();
        }
      }
    },
    240_000,
  );
});
