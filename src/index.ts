#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type PotterConfig } from "./config.js";
import { PotterError, errorToContent } from "./errors.js";
import { makeLogger, type Logger } from "./logging.js";
import { closeAllStagehandSessions } from "./providers/stagehand.js";
import { browserTools } from "./tools/browser.js";
import { compositeTools } from "./tools/composite.js";
import { linkedinTools } from "./tools/linkedin.js";
import { pingTools } from "./tools/ping.js";
import { providerStatusTools } from "./tools/provider-status.js";
import type { ToolDefinition } from "./tools/registry.js";
import { webTools } from "./tools/web.js";

const SERVER_NAME = "potter-mcp";
const SERVER_VERSION = "1.0.5";

interface ProviderCheck {
  provider: string;
  ok: boolean;
  missing: string[];
}

const checkProviders = (cfg: PotterConfig): ProviderCheck[] => {
  const checks: ProviderCheck[] = [];
  checks.push({
    provider: "apify",
    ok: Boolean(cfg.apifyToken),
    missing: cfg.apifyToken ? [] : ["POTTER_APIFY_TOKEN"],
  });
  checks.push({
    provider: "firecrawl",
    ok: Boolean(cfg.firecrawlApiKey),
    missing: cfg.firecrawlApiKey ? [] : ["POTTER_FIRECRAWL_API_KEY"],
  });
  const bbMissing: string[] = [];
  if (!cfg.browserbaseApiKey) bbMissing.push("POTTER_BROWSERBASE_API_KEY");
  if (!cfg.browserbaseProjectId) bbMissing.push("POTTER_BROWSERBASE_PROJECT_ID");
  checks.push({
    provider: "browserbase",
    ok: bbMissing.length === 0,
    missing: bbMissing,
  });
  checks.push({
    provider: "anthropic",
    ok: Boolean(cfg.anthropicApiKey),
    missing: cfg.anthropicApiKey ? [] : ["POTTER_ANTHROPIC_API_KEY"],
  });
  checks.push({
    provider: "openai",
    ok: Boolean(cfg.openaiApiKey),
    missing: cfg.openaiApiKey ? [] : ["POTTER_OPENAI_API_KEY"],
  });
  return checks;
};

const logStartupDiagnostics = (log: Logger, checks: ProviderCheck[]): void => {
  for (const check of checks) {
    log(check.ok ? "info" : "warn", "provider_check", {
      provider: check.provider,
      ok: check.ok,
      missing: check.missing,
    });
  }
  const criticalMissing = checks.filter(
    (c) => (c.provider === "apify" || c.provider === "firecrawl") && !c.ok,
  );
  if (criticalMissing.length > 0) {
    log("warn", "startup_warning", {
      msg: "Core provider(s) unavailable — LinkedIn and web tools will return structured errors.",
      providers: criticalMissing.map((c) => c.provider),
    });
  }
};

const buildToolRegistry = (cfg: PotterConfig): ToolDefinition[] => [
  ...(cfg.enablePing ? pingTools : []),
  ...providerStatusTools,
  ...linkedinTools,
  ...webTools,
  ...browserTools,
  ...compositeTools,
];

async function main(): Promise<void> {
  if (process.argv.slice(2).some((a) => a === "--version" || a === "-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    process.exit(0);
  }
  const config = loadConfig();
  const log: Logger = makeLogger(config.logLevel);
  const checks = checkProviders(config);
  const tools = buildToolRegistry(config);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = req.params;
    const tool = toolsByName.get(name);
    if (!tool) {
      const err = new PotterError({
        tool: name,
        provider: "potter",
        reason: `Unknown tool: ${name}`,
        retryable: false,
        recommended_action:
          "Verify Claude Code is pointed at a current build and the tool name is spelled correctly.",
      });
      log("error", "tool_call_failed", { tool: name, error: err.message });
      return errorToContent(err, name);
    }
    try {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const result = await tool.handler(args);
      log("info", "tool_call", { tool: name, ok: !result.isError });
      return result;
    } catch (err) {
      log("error", "tool_call_failed", {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorToContent(err, name);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStartupDiagnostics(log, checks);
  log("info", "potter_mcp_started", {
    version: SERVER_VERSION,
    tool_count: tools.length,
  });

  let shuttingDown = false;
  const HARD_EXIT_GRACE_MS = 5_000;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      log("warn", "potter_mcp_force_exit", { signal, msg: "second signal; forcing exit" });
      process.exit(1);
      return;
    }
    shuttingDown = true;
    log("info", "potter_mcp_shutdown", { signal });
    const hardExit = setTimeout(() => {
      log("error", "potter_mcp_shutdown_timeout", {
        msg: "graceful shutdown exceeded 5s; forcing exit",
      });
      process.exit(1);
    }, HARD_EXIT_GRACE_MS);
    hardExit.unref();
    try {
      await closeAllStagehandSessions();
    } catch (err) {
      log("warn", "stagehand_shutdown_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await server.close();
    } catch (err) {
      log("error", "server_close_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    clearTimeout(hardExit);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`Potter MCP failed to start: ${detail}\n`);
  process.exit(1);
});
