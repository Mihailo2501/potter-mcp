import { z } from "zod";
import { loadConfig } from "../config.js";
import { defineTool, type ToolDefinition } from "./registry.js";

const PingArgsSchema = z
  .object({
    message: z
      .string()
      .optional()
      .describe("Optional message echoed back in the response."),
  })
  .strict();

export const pingTools: ToolDefinition[] = [
  defineTool({
    name: "potter_ping",
    description:
      "Health check for the Potter MCP server. Returns pong plus server version, timestamp, and provider-key availability. Use this to confirm Potter is reachable from Claude Code and to see which providers are configured.",
    argsSchema: PingArgsSchema,
    run: async ({ message }) => {
      const cfg = loadConfig();
      return {
        pong: true,
        server: "potter-mcp",
        version: "1.0.2",
        timestamp: new Date().toISOString(),
        echo: message ?? null,
        providers: {
          apify: Boolean(cfg.apifyToken),
          firecrawl: Boolean(cfg.firecrawlApiKey),
          browserbase: Boolean(cfg.browserbaseApiKey && cfg.browserbaseProjectId),
          anthropic: Boolean(cfg.anthropicApiKey),
          openai: Boolean(cfg.openaiApiKey),
        },
      };
    },
  }),
];
