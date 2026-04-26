import { z } from "zod";
import { loadConfig } from "../config.js";
import { PotterError } from "../errors.js";
import { getStagehand } from "../providers/stagehand.js";
import { ensureUrlAllowed, isLinkedInUrl } from "../urls.js";
import { defineTool, type ToolDefinition } from "./registry.js";
import type { StagehandSession } from "../providers/stagehand.js";

const NO_LINKEDIN_NOTE =
  " Do not use this tool to automate LinkedIn; LinkedIn is covered by the potter_linkedin_* primitives and browser automation against LinkedIn violates their terms.";

const rejectIfLinkedInPage = (tool: string, session: StagehandSession): void => {
  const page = session.stagehand.context.activePage();
  const url = page?.url();
  if (url && isLinkedInUrl(url)) {
    throw new PotterError({
      tool,
      provider: "stagehand",
      reason: `Browser page is on LinkedIn (${url}). Browser automation against LinkedIn is not permitted.`,
      retryable: false,
      recommended_action:
        "Navigate to a non-LinkedIn URL or use potter_linkedin_* primitives for LinkedIn data.",
    });
  }
};

const rejectIfLinkedInUrl = (tool: string, url: string): void => {
  if (isLinkedInUrl(url)) {
    throw new PotterError({
      tool,
      provider: "stagehand",
      reason: `LinkedIn URL rejected: ${url}. Browser automation against LinkedIn is not permitted.`,
      retryable: false,
      recommended_action:
        "Use potter_linkedin_profile / potter_linkedin_company / potter_linkedin_posts for LinkedIn data.",
    });
  }
};

const envelopeFor = (
  session: StagehandSession,
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const page = session.stagehand.context.activePage();
  const url = page?.url();
  const provider = session.env === "BROWSERBASE" ? "browserbase" : "stagehand";
  return {
    source_urls: url ? [url] : [],
    provider_status: [{ provider, ok: true }],
    warnings: [],
    ...payload,
  };
};

const HttpUrl = z.string().url();

const OpenArgs = z
  .object({
    url: HttpUrl.describe("URL to open. http/https only; private IPs blocked unless POTTER_ALLOW_PRIVATE_URLS=true."),
    stealth: z
      .boolean()
      .optional()
      .describe("Best-effort stealth mode. Only honored in LOCAL Playwright runs; ignored on Browserbase."),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(320).max(2160),
      })
      .optional(),
    user_agent: z.string().optional(),
    force_local: z
      .boolean()
      .optional()
      .describe("Force LOCAL Playwright even if Browserbase credentials are present."),
  })
  .strict();

const SessionOnlyArgs = z
  .object({
    session_id: z.string().describe("Session id from potter_browser_open."),
  })
  .strict();

const ClickArgs = z
  .object({
    session_id: z.string(),
    selector_or_description: z
      .string()
      .describe(
        "Either a CSS selector (e.g. '#submit', '.btn-primary', '[data-test=cta]') or a natural-language description (e.g. 'the Submit button'). Inputs starting with '#', '.', or '[' route deterministically through Playwright; everything else routes through Stagehand's LLM act() and needs a Browserbase session or a configured POTTER_ANTHROPIC_API_KEY / POTTER_OPENAI_API_KEY.",
      ),
    mode: z
      .enum(["selector", "description", "auto"])
      .optional()
      .describe(
        "Force a routing mode. 'auto' (default) picks 'selector' when the input starts with '#', '.', or '['; otherwise 'description'.",
      ),
  })
  .strict();

const FillArgs = z
  .object({
    session_id: z.string(),
    selector_or_description: z.string(),
    value: z.string().describe("Value to type into the matched field."),
    submit: z
      .boolean()
      .optional()
      .describe("Press Enter after typing. Defaults to false."),
    mode: z
      .enum(["selector", "description", "auto"])
      .optional()
      .describe(
        "Force a routing mode. 'auto' (default) picks 'selector' when the input starts with '#', '.', or '['; otherwise 'description'.",
      ),
  })
  .strict();

const ScrollArgs = z
  .object({
    session_id: z.string(),
    direction: z.enum(["up", "down", "top", "bottom"]),
    amount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Pixels to scroll for up/down. Ignored for top/bottom."),
    to_selector: z
      .string()
      .optional()
      .describe("CSS selector or description to scroll into view; overrides direction."),
  })
  .strict();

const ExtractArgs = z
  .object({
    session_id: z.string(),
    instruction: z
      .string()
      .optional()
      .describe(
        "Optional natural-language instruction. If absent, returns the full page text. If present, routes through Stagehand's extract() with an LLM.",
      ),
    schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional JSON Schema describing the desired extraction shape."),
  })
  .strict();

const DEFAULT_INSPECT_PROPERTIES = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "padding",
  "margin",
  "border-radius",
  "box-shadow",
  "max-width",
];

const InspectStylesArgs = z
  .object({
    session_id: z.string(),
    selectors: z
      .array(z.string().min(1).max(500))
      .min(1)
      .max(20)
      .describe("CSS selectors to inspect on the active page. Max 20 selectors per call."),
    properties: z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(40)
      .optional()
      .describe(
        "CSS property names to read via getComputedStyle. Defaults to a curated set: color, background-color, font-family, font-size, font-weight, line-height, padding, margin, border-radius, box-shadow, max-width.",
      ),
    max_matches_per_selector: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Cap on elements inspected per selector. Default 5 if omitted."),
  })
  .strict();

const ScreenshotArgs = z
  .object({
    session_id: z.string(),
    full_page: z.boolean().optional().describe("Capture beyond the viewport. Defaults to false."),
  })
  .strict();

const ActArgs = z
  .object({
    session_id: z.string(),
    goal: z.string().describe("Natural-language goal, e.g. 'click the Learn More link'."),
  })
  .strict();

const requireUrlAllowed = async (url: string): Promise<void> => {
  const cfg = loadConfig();
  await ensureUrlAllowed(url, cfg.allowPrivateUrls);
};

const looksLikeCssSelector = (s: string): boolean => /^[#.\[]/.test(s.trim());

const resolveBrowserMode = (
  mode: "selector" | "description" | "auto" | undefined,
  input: string,
): "selector" | "description" => {
  if (mode === "selector" || mode === "description") return mode;
  return looksLikeCssSelector(input) ? "selector" : "description";
};

const requireActivePage = (session: StagehandSession, tool: string) => {
  const page = session.stagehand.context.activePage();
  if (!page) {
    throw new PotterError({
      tool,
      provider: "stagehand",
      reason: "No active page.",
      retryable: true,
      recommended_action: "Reopen the session with potter_browser_open.",
    });
  }
  return page;
};

export const browserTools: ToolDefinition[] = [
  defineTool({
    name: "potter_browser_open",
    description:
      `Open a new browser session and navigate to a URL. Returns a session_id used by the other potter_browser_* tools. Picks Browserbase when POTTER_BROWSERBASE_* creds are set; falls back to local Playwright otherwise (requires \`npx playwright install chromium\` on first run).${NO_LINKEDIN_NOTE}`,
    argsSchema: OpenArgs,
    run: async ({ url, stealth, viewport, user_agent, force_local }) => {
      rejectIfLinkedInUrl("potter_browser_open", url);
      await requireUrlAllowed(url);
      const manager = getStagehand();
      const options: Parameters<typeof manager.createSession>[0] = {};
      if (stealth !== undefined) options.stealth = stealth;
      if (viewport) options.viewport = viewport;
      if (user_agent) options.userAgent = user_agent;
      if (force_local) options.forceLocal = force_local;
      const session = await manager.createSession(options);
      try {
        const page = session.stagehand.context.activePage();
        if (!page) {
          throw new PotterError({
            tool: "potter_browser_open",
            provider: "stagehand",
            reason: "Stagehand initialized but no active page is available.",
            retryable: true,
            recommended_action: "Retry; if it persists, close any stale sessions via potter_browser_close.",
          });
        }
        await page.goto(url);
        return envelopeFor(session, {
          session_id: session.id,
          env: session.env,
          url: page.url(),
        });
      } catch (err) {
        await manager.closeSession(session.id).catch(() => undefined);
        throw err;
      }
    },
  }),
  defineTool({
    name: "potter_browser_click",
    description:
      `Click an element in a browser session. Accepts a CSS selector (deterministic via Playwright) or a natural-language description (routed through Stagehand's LLM act()). Selector inputs start with '#', '.', or '[' and run with no LLM; descriptions need a Browserbase session or POTTER_ANTHROPIC_API_KEY / POTTER_OPENAI_API_KEY.${NO_LINKEDIN_NOTE}`,
    argsSchema: ClickArgs,
    run: async ({ session_id, selector_or_description, mode }) => {
      const manager = getStagehand();
      return manager.withLease(session_id, "potter_browser_click", async (session) => {
        rejectIfLinkedInPage("potter_browser_click", session);
        const resolved = resolveBrowserMode(mode, selector_or_description);
        if (resolved === "selector") {
          const page = requireActivePage(session, "potter_browser_click");
          await page.locator(selector_or_description).click();
          return envelopeFor(session, {
            session_id,
            action: "click",
            mode: "selector",
            selector: selector_or_description,
          });
        }
        const result = await session.stagehand.act(`click ${selector_or_description}`);
        return envelopeFor(session, {
          session_id,
          action: "click",
          mode: "description",
          result,
        });
      });
    },
  }),
  defineTool({
    name: "potter_browser_fill",
    description:
      `Type a value into a form field. Accepts a CSS selector (deterministic via Playwright) or a natural-language description (LLM-routed via Stagehand). Selectors run with no LLM; descriptions follow the same provider rules as potter_browser_click. Optional submit=true presses Enter after typing.${NO_LINKEDIN_NOTE}`,
    argsSchema: FillArgs,
    run: async ({ session_id, selector_or_description, value, submit, mode }) => {
      const manager = getStagehand();
      return manager.withLease(session_id, "potter_browser_fill", async (session) => {
        rejectIfLinkedInPage("potter_browser_fill", session);
        const resolved = resolveBrowserMode(mode, selector_or_description);
        if (resolved === "selector") {
          const page = requireActivePage(session, "potter_browser_fill");
          await page.locator(selector_or_description).fill(value);
          if (submit) await page.keyPress("Enter");
          return envelopeFor(session, {
            session_id,
            action: "fill",
            mode: "selector",
            selector: selector_or_description,
            submit: submit ?? false,
          });
        }
        const instruction = submit
          ? `type ${JSON.stringify(value)} into ${selector_or_description} and press Enter`
          : `type ${JSON.stringify(value)} into ${selector_or_description}`;
        const result = await session.stagehand.act(instruction);
        return envelopeFor(session, {
          session_id,
          action: "fill",
          mode: "description",
          submit: submit ?? false,
          result,
        });
      });
    },
  }),
  defineTool({
    name: "potter_browser_scroll",
    description: `Scroll the active page up, down, to top, to bottom, or to a specific selector.${NO_LINKEDIN_NOTE}`,
    argsSchema: ScrollArgs,
    run: async ({ session_id, direction, amount, to_selector }) => {
      const manager = getStagehand();
      return manager.withLease(session_id, "potter_browser_scroll", async (session) => {
        rejectIfLinkedInPage("potter_browser_scroll", session);
        const page = session.stagehand.context.activePage();
        if (!page) {
          throw new PotterError({
            tool: "potter_browser_scroll",
            provider: "stagehand",
            reason: "No active page.",
            retryable: true,
            recommended_action: "Reopen the session with potter_browser_open.",
          });
        }
        const px = amount ?? 800;
        if (to_selector) {
          await session.stagehand.act(`scroll ${to_selector} into view`);
        } else if (direction === "top") {
          await page.evaluate("window.scrollTo({top: 0, behavior: 'instant'})");
        } else if (direction === "bottom") {
          await page.evaluate("window.scrollTo({top: document.body.scrollHeight, behavior: 'instant'})");
        } else if (direction === "down") {
          await page.evaluate(`window.scrollBy(0, ${px})`);
        } else {
          await page.evaluate(`window.scrollBy(0, ${-px})`);
        }
        return envelopeFor(session, {
          session_id,
          direction,
          amount: px,
          to_selector: to_selector ?? null,
        });
      });
    },
  }),
  defineTool({
    name: "potter_browser_extract",
    description:
      `Extract content from the active page. With no arguments, returns full page text. With instruction, routes through Stagehand's extract() for LLM-backed extraction. Provide schema to coerce into a structured shape. Do not use for exact CSS, computed style, design-token, or style-guide values; use potter_browser_inspect_styles for those.${NO_LINKEDIN_NOTE}`,
    argsSchema: ExtractArgs,
    run: async ({ session_id, instruction, schema }) => {
      const manager = getStagehand();
      return manager.withLease(session_id, "potter_browser_extract", async (session) => {
        rejectIfLinkedInPage("potter_browser_extract", session);
        let extraction: unknown;
        if (!instruction) {
          extraction = await session.stagehand.extract();
        } else if (schema) {
          const { jsonSchemaToZod } = await import("@browserbasehq/stagehand");
          type JsonSchemaInput = Parameters<typeof jsonSchemaToZod>[0];
          const zodSchema = jsonSchemaToZod(schema as unknown as JsonSchemaInput);
          extraction = await session.stagehand.extract(instruction, zodSchema);
        } else {
          extraction = await session.stagehand.extract(instruction);
        }
        return envelopeFor(session, { session_id, extraction });
      });
    },
  }),
  defineTool({
    name: "potter_browser_inspect_styles",
    description:
      `Read computed CSS values from the rendered page in an open browser session via getComputedStyle. Returns one map of property→value per matched element. Use after potter_browser_open. Runs a fixed Potter-owned read-only evaluation script; selector and property inputs are serialized data and are never evaluated as JavaScript. Prefer this over potter_browser_extract and potter_browser_act whenever the user asks for exact or computed CSS, brand colors, fonts, spacing, radii, shadows, design tokens, or style-guide values. Limits: inspects the active document only (not iframes, not shadow DOM internals, not ::before/::after pseudo-elements).${NO_LINKEDIN_NOTE}`,
    argsSchema: InspectStylesArgs,
    run: async ({ session_id, selectors, properties, max_matches_per_selector }) => {
      const manager = getStagehand();
      return manager.withLease(session_id, "potter_browser_inspect_styles", async (session) => {
        rejectIfLinkedInPage("potter_browser_inspect_styles", session);
        const page = session.stagehand.context.activePage();
        if (!page) {
          throw new PotterError({
            tool: "potter_browser_inspect_styles",
            provider: "stagehand",
            reason: "No active page.",
            retryable: true,
            recommended_action: "Reopen the session with potter_browser_open.",
          });
        }
        const propsToRead = properties ?? DEFAULT_INSPECT_PROPERTIES;
        const cap = max_matches_per_selector ?? 5;
        const matches = (await page.evaluate(
          ({ sels, props, max }: { sels: string[]; props: string[]; max: number }) => {
            // Function body runs in the browser context; DOM globals are available at runtime
            // but not in the Node TypeScript lib. globalThis cast keeps the wider tsconfig clean.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc: any = (globalThis as any).document;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const win: any = (globalThis as any).window;
            // Object.create(null) avoids prototype-key collisions if a selector or property is named __proto__ etc.
            const out: Record<string, Array<Record<string, string>>> = Object.create(null);
            for (const sel of sels) {
              try {
                const nodes = doc.querySelectorAll(sel);
                const els: unknown[] = [];
                for (let i = 0; i < nodes.length && els.length < max; i++) {
                  els.push(nodes[i]);
                }
                out[sel] = els.map((el) => {
                  const cs = win.getComputedStyle(el);
                  const styles: Record<string, string> = Object.create(null);
                  for (const p of props) {
                    styles[p] = cs.getPropertyValue(p);
                  }
                  return styles;
                });
              } catch {
                out[sel] = [];
              }
            }
            return out;
          },
          { sels: selectors, props: propsToRead, max: cap },
        )) as Record<string, Array<Record<string, string>>>;
        return envelopeFor(session, {
          session_id,
          selectors,
          properties: propsToRead,
          max_matches_per_selector: cap,
          matches,
          notes: [
            "Computed values are the browser's resolved values (rgb() not hex; pixel sizes not rem).",
            "Selectors that match nothing return an empty array for that key.",
            "Invalid selectors return an empty array; they do not error the call.",
          ],
        });
      });
    },
  }),
  defineTool({
    name: "potter_browser_screenshot",
    description:
      `Capture a screenshot of the active page and return it as a base64-encoded PNG. full_page=true captures beyond the viewport.${NO_LINKEDIN_NOTE}`,
    argsSchema: ScreenshotArgs,
    run: async ({ session_id, full_page }) => {
      const manager = getStagehand();
      return manager.withLease(session_id, "potter_browser_screenshot", async (session) => {
        rejectIfLinkedInPage("potter_browser_screenshot", session);
        const page = session.stagehand.context.activePage();
        if (!page) {
          throw new PotterError({
            tool: "potter_browser_screenshot",
            provider: "stagehand",
            reason: "No active page.",
            retryable: true,
            recommended_action: "Reopen the session with potter_browser_open.",
          });
        }
        const buffer = await page.screenshot({ fullPage: full_page ?? false });
        return envelopeFor(session, {
          session_id,
          format: "png",
          encoding: "base64",
          full_page: full_page ?? false,
          image_base64: buffer.toString("base64"),
          byte_length: buffer.byteLength,
        });
      });
    },
  }),
  defineTool({
    name: "potter_browser_close",
    description: `Close a browser session and free its resources. Always call this when you are done to avoid hitting Browserbase session limits.${NO_LINKEDIN_NOTE}`,
    argsSchema: SessionOnlyArgs,
    run: async ({ session_id }) => {
      const manager = getStagehand();
      await manager.closeSessionSafely(session_id);
      return {
        source_urls: [],
        provider_status: [{ provider: "stagehand", ok: true }],
        warnings: [],
        session_id,
        closed: true,
      };
    },
  }),
  defineTool({
    name: "potter_browser_act",
    description:
      `EXPERIMENTAL: Accomplish a natural-language goal in a browser session via Stagehand's LLM-driven agent. Example goal: 'Click the Learn More link under the pricing section.' On Browserbase sessions, uses the bundled LLM. On LOCAL sessions, requires a configured Anthropic or OpenAI key.${NO_LINKEDIN_NOTE}`,
    argsSchema: ActArgs,
    run: async ({ session_id, goal }) => {
      const cfg = loadConfig();
      if (!cfg.enableExperimentalBrowserAct) {
        throw new PotterError({
          tool: "potter_browser_act",
          provider: "stagehand",
          reason:
            "potter_browser_act is currently disabled. The experimental flag defaults to enabled; remove POTTER_ENABLE_EXPERIMENTAL_BROWSER_ACT or set it to true to use this tool.",
          retryable: false,
          recommended_action:
            "Unset POTTER_ENABLE_EXPERIMENTAL_BROWSER_ACT in your environment, or set it to true, and restart Potter.",
        });
      }
      const manager = getStagehand();
      return manager.withLease(session_id, "potter_browser_act", async (session) => {
        rejectIfLinkedInPage("potter_browser_act", session);
        const result = await session.stagehand.act(goal, {
          timeout: cfg.browserActTimeoutSeconds * 1000,
        });
        return envelopeFor(session, {
          session_id,
          goal_accepted: true,
          result,
        });
      });
    },
  }),
];
