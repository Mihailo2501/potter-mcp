import { z } from "zod";
import { ApifyClient } from "apify-client";
import { Firecrawl } from "@mendable/firecrawl-js";
import { loadConfig } from "../config.js";
import { redactSecrets } from "../logging.js";
import { defineTool, type ToolDefinition } from "./registry.js";

const ArgsSchema = z
  .object({
    include_live_checks: z
      .boolean()
      .optional()
      .describe(
        "If true, issue a lightweight live call per configured provider to verify the token actually works. Default false (omit) to keep the call free and fast.",
      ),
  })
  .strict();

interface ProviderResult {
  provider: string;
  configured: boolean;
  missing: string[];
  live?: { ok: boolean; detail?: string; status_code?: number };
}

const redactDetail = (detail: string): string => redactSecrets(detail);

const checkApifyLive = async (token: string): Promise<ProviderResult["live"]> => {
  try {
    const client = new ApifyClient({ token });
    const me = await client.user().get();
    return {
      ok: Boolean(me?.username),
      detail: redactDetail(me?.username ? `user=${me.username}` : "no username"),
    };
  } catch (err) {
    return { ok: false, detail: redactDetail(err instanceof Error ? err.message : String(err)) };
  }
};

const checkFirecrawlLive = async (apiKey: string): Promise<ProviderResult["live"]> => {
  try {
    const fc = new Firecrawl({ apiKey });
    const usage = await fc.getCreditUsage();
    return {
      ok: true,
      detail: redactDetail(`credits_remaining=${usage.remainingCredits ?? "unknown"}`),
    };
  } catch (err) {
    return { ok: false, detail: redactDetail(err instanceof Error ? err.message : String(err)) };
  }
};

const checkBrowserbaseLive = async (
  apiKey: string,
  projectId: string,
): Promise<ProviderResult["live"]> => {
  try {
    const res = await fetch(`https://api.browserbase.com/v1/projects/${projectId}`, {
      headers: { "x-bb-api-key": apiKey },
    });
    if (!res.ok) {
      return {
        ok: false,
        status_code: res.status,
        detail: redactDetail(`http ${res.status}`),
      };
    }
    const body = (await res.json()) as { name?: string };
    return { ok: true, detail: redactDetail(`project=${body.name ?? "unknown"}`) };
  } catch (err) {
    return { ok: false, detail: redactDetail(err instanceof Error ? err.message : String(err)) };
  }
};

export const providerStatusTools: ToolDefinition[] = [
  defineTool({
    name: "potter_provider_status",
    description:
      "Report which external providers (Apify, Firecrawl, Browserbase, Anthropic, OpenAI) Potter has credentials for, and optionally verify those credentials with a live API call. Use this after install to confirm setup and after errors to rule out auth issues.",
    argsSchema: ArgsSchema,
    run: async ({ include_live_checks = false }) => {
      const cfg = loadConfig();
      const results: ProviderResult[] = [];

      results.push({
        provider: "apify",
        configured: Boolean(cfg.apifyToken),
        missing: cfg.apifyToken ? [] : ["POTTER_APIFY_TOKEN"],
      });
      results.push({
        provider: "firecrawl",
        configured: Boolean(cfg.firecrawlApiKey),
        missing: cfg.firecrawlApiKey ? [] : ["POTTER_FIRECRAWL_API_KEY"],
      });
      const bbMissing: string[] = [];
      if (!cfg.browserbaseApiKey) bbMissing.push("POTTER_BROWSERBASE_API_KEY");
      if (!cfg.browserbaseProjectId) bbMissing.push("POTTER_BROWSERBASE_PROJECT_ID");
      results.push({
        provider: "browserbase",
        configured: bbMissing.length === 0,
        missing: bbMissing,
      });
      results.push({
        provider: "anthropic",
        configured: Boolean(cfg.anthropicApiKey),
        missing: cfg.anthropicApiKey ? [] : ["POTTER_ANTHROPIC_API_KEY"],
      });
      results.push({
        provider: "openai",
        configured: Boolean(cfg.openaiApiKey),
        missing: cfg.openaiApiKey ? [] : ["POTTER_OPENAI_API_KEY"],
      });

      if (include_live_checks) {
        const live = await Promise.all(
          results.map(async (r) => {
            if (!r.configured) return undefined;
            if (r.provider === "apify") return checkApifyLive(cfg.apifyToken!);
            if (r.provider === "firecrawl") return checkFirecrawlLive(cfg.firecrawlApiKey!);
            if (r.provider === "browserbase")
              return checkBrowserbaseLive(cfg.browserbaseApiKey!, cfg.browserbaseProjectId!);
            return { ok: true, detail: "no live check implemented (key presence only)" };
          }),
        );
        for (let i = 0; i < results.length; i += 1) {
          const l = live[i];
          if (l) results[i]!.live = l;
        }
      }

      return {
        checked_at: new Date().toISOString(),
        include_live_checks,
        providers: results,
      };
    },
  }),
];
