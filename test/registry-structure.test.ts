import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { browserTools } from "../src/tools/browser.js";
import { compositeTools } from "../src/tools/composite.js";
import { linkedinTools } from "../src/tools/linkedin.js";
import { providerStatusTools } from "../src/tools/provider-status.js";
import { webTools } from "../src/tools/web.js";


const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");
const readDoc = (relPath: string): string => readFileSync(join(PROJECT_ROOT, relPath), "utf8");

// Canonical launch surface (excludes pingTools which is gated by POTTER_ENABLE_PING).
const launchTools = [
  ...providerStatusTools,
  ...linkedinTools,
  ...webTools,
  ...browserTools,
  ...compositeTools,
];

describe("potter_browser_inspect_styles registration", () => {
  const tool = browserTools.find((t) => t.name === "potter_browser_inspect_styles");

  it("is registered in browserTools", () => {
    expect(tool).toBeDefined();
  });

  it("description mentions getComputedStyle", () => {
    expect(tool!.description).toMatch(/getComputedStyle/);
  });

  it("description signals deterministic / read-only behavior", () => {
    expect(tool!.description).toMatch(/(read-only|deterministic|fixed Potter-owned)/);
  });

  it("description does not advertise LLM routing", () => {
    expect(tool!.description).not.toMatch(
      /(LLM-backed|llm-driven|stagehand'?s? extract\(\)|requires .*anthropic|requires .*openai)/i,
    );
  });

  it("max_matches_per_selector is NOT in inputSchema.required (Zod default-makes-required gotcha)", () => {
    const required = (tool!.inputSchema.required as string[] | undefined) ?? [];
    expect(required).not.toContain("max_matches_per_selector");
  });

  it("session_id and selectors ARE in inputSchema.required", () => {
    const required = (tool!.inputSchema.required as string[] | undefined) ?? [];
    expect(required).toContain("session_id");
    expect(required).toContain("selectors");
  });

  it("potter_browser_extract description redirects to inspect_styles for CSS / style-token values", () => {
    const extract = browserTools.find((t) => t.name === "potter_browser_extract");
    expect(extract).toBeDefined();
    expect(extract!.description).toMatch(/inspect_styles/);
  });
});

// Zod's `.default(...)` puts the field in JSON-schema `required`, which advertises
// optional MCP args as required. Defaults belong in the run handler via `?? fallback`,
// not in the Zod schema. This test scans every registered tool and fails if any field
// has a JSON-schema default.
describe("no Zod .default() in tool schemas (defaults belong in run handlers)", () => {
  for (const tool of launchTools) {
    it(`${tool.name} has no field with a JSON-schema default`, () => {
      const properties = (tool.inputSchema.properties as Record<string, { default?: unknown }> | undefined) ?? {};
      const fieldsWithDefaults = Object.entries(properties)
        .filter(([, def]) => def && typeof def === "object" && "default" in def)
        .map(([name]) => name);
      expect(fieldsWithDefaults).toEqual([]);
    });
  }
});

describe("potter_web_scrape description nudges format='html' for stack-fingerprinting", () => {
  const scrape = webTools.find((t) => t.name === "potter_web_scrape");
  it("is registered", () => expect(scrape).toBeDefined());
  it("mentions html + script tag / vendor / fingerprinting use case", () => {
    expect(scrape!.description).toMatch(/html/i);
    expect(scrape!.description).toMatch(/(script\s*tag|fingerprint|vendor|analytics)/i);
  });
});

describe("docs-to-registry count parity", () => {
  const totalCount = launchTools.length;
  const browserCount = browserTools.length;

  it("README total tool count matches the registry", () => {
    const readme = readDoc("README.md");
    expect(readme).toContain(`${totalCount} tools for B2B research`);
    expect(readme).toContain(`What's in the box (${totalCount} tools)`);
    expect(readme).toMatch(new RegExp(`\\*\\*Browser \\(${browserCount}\\):`));
  });

  it("docs/tools.md totals match the registry", () => {
    const doc = readDoc("docs/tools.md");
    expect(doc).toContain(`${totalCount} tools, plus`);
    expect(doc).toContain(`Browser tools (${browserCount})`);
  });

  it("docs/installation.md tool count matches the registry", () => {
    const doc = readDoc("docs/installation.md");
    expect(doc).toContain(`lists ${totalCount} tools`);
  });
});
