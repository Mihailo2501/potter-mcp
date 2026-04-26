import { beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { browserTools } from "../../src/tools/browser.js";
import { compositeTools } from "../../src/tools/composite.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import { webTools } from "../../src/tools/web.js";

const allTools: ToolDefinition[] = [...compositeTools, ...webTools, ...browserTools];

const findTool = (name: string): ToolDefinition => {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

const callTool = async (
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> => findTool(name).handler(args);

interface ErrorPayload {
  error: {
    tool: string;
    provider: string;
    reason: string;
    retryable: boolean;
    recommended_action: string;
  };
}

const parseError = (result: CallToolResult): ErrorPayload["error"] => {
  expect(result.isError).toBe(true);
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text content block");
  const payload = JSON.parse(block.text) as ErrorPayload;
  expect(payload.error).toBeDefined();
  return payload.error;
};

beforeAll(() => {
  if (process.env.POTTER_QA_STUB_MODE === "true") {
    throw new Error(
      "Safety tests require POTTER_QA_STUB_MODE to be unset; got true. Stub mode short-circuits before guards run.",
    );
  }
});

describe("LinkedIn guard on web tools", () => {
  it("potter_web_scrape rejects a LinkedIn profile URL with a redirect hint", async () => {
    const result = await callTool("potter_web_scrape", {
      url: "https://www.linkedin.com/in/satyanadella/",
    });
    const err = parseError(result);
    expect(err.tool).toBe("potter_web_scrape");
    expect(err.reason).toMatch(/linkedin/i);
    expect(err.recommended_action).toMatch(/potter_linkedin_/);
  });

  it("potter_web_crawl rejects a LinkedIn URL", async () => {
    const result = await callTool("potter_web_crawl", {
      url: "https://www.linkedin.com/company/stripe/",
    });
    const err = parseError(result);
    expect(err.tool).toBe("potter_web_crawl");
    expect(err.reason).toMatch(/linkedin/i);
  });
});

describe("LinkedIn + SSRF guards on extract_structured", () => {
  const minimalSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };

  it("rejects a LinkedIn URL with a redirect hint to potter_linkedin_*", async () => {
    const result = await callTool("potter_extract_structured", {
      url: "https://www.linkedin.com/in/satyanadella/",
      schema: minimalSchema,
    });
    const err = parseError(result);
    expect(err.tool).toBe("potter_extract_structured");
    expect(err.reason).toMatch(/linkedin/i);
    expect(err.recommended_action).toMatch(/potter_linkedin_/);
  });

  it("rejects a localhost URL (SSRF guard)", async () => {
    const result = await callTool("potter_extract_structured", {
      url: "http://localhost:3000/admin/api",
      schema: minimalSchema,
    });
    const err = parseError(result);
    expect(err.tool).toBe("potter_extract_structured");
    expect(err.reason.toLowerCase()).toMatch(/localhost|private|blocked/);
  });

  it("rejects a 127.0.0.1 URL (SSRF guard)", async () => {
    const result = await callTool("potter_extract_structured", {
      url: "http://127.0.0.1/internal",
      schema: minimalSchema,
    });
    const err = parseError(result);
    expect(err.tool).toBe("potter_extract_structured");
    expect(err.reason.toLowerCase()).toMatch(/private|blocked|127/);
  });

  it("rejects an RFC1918 IP (SSRF guard)", async () => {
    const result = await callTool("potter_extract_structured", {
      url: "http://10.0.0.5/",
      schema: minimalSchema,
    });
    const err = parseError(result);
    expect(err.tool).toBe("potter_extract_structured");
    expect(err.reason.toLowerCase()).toMatch(/private|blocked|10\./);
  });
});

describe("Browser-on-LinkedIn guard", () => {
  it("potter_browser_open rejects a LinkedIn URL pre-session", async () => {
    const result = await callTool("potter_browser_open", {
      url: "https://www.linkedin.com/in/satyanadella/",
    });
    const err = parseError(result);
    expect(err.tool).toBe("potter_browser_open");
    expect(err.reason).toMatch(/linkedin/i);
    expect(err.recommended_action).toMatch(/potter_linkedin_/);
  });
});

describe("Bulk-employee enumeration guard on find_decision_maker", () => {
  const target = "https://www.linkedin.com/company/stripe/";

  it.each([
    "employees",
    "employee",
    "people",
    "staff",
    "workers",
    "everyone",
    "anyone",
    "everybody",
    "all employees",
    "all people",
  ])("rejects generic role_description %j", async (role) => {
    const result = await callTool("potter_find_decision_maker", {
      company_url_or_domain: target,
      role_description: role,
    });
    const err = parseError(result);
    expect(err.tool).toBe("potter_find_decision_maker");
    expect(err.reason.toLowerCase()).toMatch(/generic|bulk|enumeration|role_description/);
    expect(err.recommended_action.toLowerCase()).toMatch(/concrete|specific|seniority|role/);
  });
});
