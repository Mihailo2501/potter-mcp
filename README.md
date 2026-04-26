<p align="center">
  <img src="https://raw.githubusercontent.com/Mihailo2501/potter-mcp/main/assets/logo.png" width="120" alt="Potter logo" />
</p>

<h1 align="center">Potter</h1>

<p align="center">
  GTM research tools as an MCP for Claude Code. Open source, BYOK, no hosted tier.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/potter-mcp"><img src="https://img.shields.io/npm/v/potter-mcp.svg" alt="npm" /></a>
  <a href="https://github.com/Mihailo2501/potter-mcp/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js" /></a>
  <a href="https://github.com/Mihailo2501/potter-mcp/actions"><img src="https://github.com/Mihailo2501/potter-mcp/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
</p>

---

## What it is

Install Potter and Claude Code gets 21 tools for B2B research: LinkedIn profile/company/posts lookups, web scrape and search, browser automation primitives, and five composite tools that fan out across providers in one call.

Reasoning runs on your existing Claude subscription (Pro or Max). Bring your own keys for Apify, Firecrawl, and Browserbase. Pay the providers directly. No billing, no auth, no hosted tier. MIT.

## Quick install

```bash
claude mcp add potter --scope user -- npx -y potter-mcp
```

Then edit `~/.claude.json` under `mcpServers` to add your provider keys:

```json
"potter": {
  "command": "npx",
  "args": ["-y", "potter-mcp"],
  "env": {
    "POTTER_APIFY_TOKEN": "apify_api_xxx",
    "POTTER_FIRECRAWL_API_KEY": "fc-xxx",
    "POTTER_BROWSERBASE_API_KEY": "bb_live_xxx",
    "POTTER_BROWSERBASE_PROJECT_ID": "xxx"
  }
}
```

`npx -y` auto-pulls the latest published version on each Claude Code session start; no global install needed.

One-time for browser tools in LOCAL mode: `npx playwright install chromium`. Restart Claude Code.

## Try it

In Claude Code:

- "Research this person: https://www.linkedin.com/in/satyanadella/"
- "Find me the head of platform engineering at Vercel"
- "Is Linear hiring backend engineers? linear.app"
- "Extract the pricing plans at https://www.anthropic.com/pricing as JSON"

21 example prompts in [examples/](https://github.com/Mihailo2501/potter-mcp/tree/main/examples).

## What's in the box (21 tools)

**Composites (5)** (fan out across providers in one call):
- `potter_research_person`: profile + posts + current company + news
- `potter_research_company`: LinkedIn page + 6 site pages + news, optional `focus` bias
- `potter_summarize_linkedin_posts`: posts + tf-idf themes + notable quotes
- `potter_find_decision_maker`: company + employees + token-overlap scoring
- `potter_extract_structured`: Firecrawl JSON-format extraction with depth-capped schema

**LinkedIn primitives (3):** `potter_linkedin_profile`, `potter_linkedin_company`, `potter_linkedin_posts`.

**Web primitives (3):** `potter_web_scrape`, `potter_web_search`, `potter_web_crawl`.

**Browser (9):** `potter_browser_open`, `_click`, `_fill`, `_scroll`, `_extract`, `_inspect_styles`, `_screenshot`, `_close`, `_act` (experimental, gated by `POTTER_ENABLE_EXPERIMENTAL_BROWSER_ACT`).

**Utility (1):** `potter_provider_status`: verifies provider keys, optionally with live API calls.

Full reference in [docs/tools.md](https://github.com/Mihailo2501/potter-mcp/blob/main/docs/tools.md).

## Provider stack

| Provider | What Potter calls it for | Signup |
|---|---|---|
| Apify | LinkedIn profile / company / posts / employees (actor choices in `docs/provider-benchmarks.md`) | https://apify.com |
| Firecrawl | Web scrape / search / crawl / structured extract | https://firecrawl.dev |
| Browserbase | Stagehand-managed browser sessions (alternative to local Playwright) | https://browserbase.com |
| Anthropic | Required for natural-language browser actions in LOCAL mode | https://console.anthropic.com |
| OpenAI | Alternative LLM for natural-language browser actions in LOCAL mode | https://platform.openai.com |

All providers charge against your own account credits; Potter takes nothing. Free / paid tiers vary; check each provider's current pricing page.

**Required:** Apify + Firecrawl. **Required for browser tools:** Browserbase OR local Playwright. **Required for natural-language browser actions** (`potter_browser_click`, `potter_browser_fill`, `potter_browser_extract` with instruction, `potter_browser_scroll` with `to_selector`, and `potter_browser_act`): Browserbase (bundled LLM) OR an Anthropic/OpenAI key on LOCAL. The other browser primitives (`open`, `direction`-only `scroll`, `inspect_styles`, `screenshot`, `close`) work without any LLM.

## Apify actor overrides

Potter ships with benchmarked defaults (see `docs/provider-benchmarks.md`). If an actor breaks or you want a different one, override by env var:

```bash
POTTER_APIFY_LINKEDIN_PROFILE_ACTOR=apimaestro/linkedin-profile-batch-scraper-no-cookies-required
POTTER_APIFY_LINKEDIN_COMPANY_ACTOR=apimaestro/linkedin-company-detail
POTTER_APIFY_LINKEDIN_POSTS_ACTOR=apimaestro/linkedin-batch-profile-posts-scraper
# default already; override to harvestapi if you're on an Apify paid plan and want richer per-employee data
POTTER_APIFY_LINKEDIN_EMPLOYEES_ACTOR_INTERNAL=harvestapi/linkedin-company-employees
```

Potter has a hard-coded normalizer per actor; if you override to an actor we don't have a normalizer for, the tool returns a structured error pointing you at `src/providers/apify-actors.ts` to add one.

**Note on `find_decision_maker`:** the default `apimaestro` employees actor is pay-per-result with no subscription, so it works on the free Apify $5 sign-up credit (~20 runs). The alternative `harvestapi` employees actor returns richer per-employee data but hard-walls free Apify users at 10 runs total, requiring an Apify Starter plan ($49/mo) afterward. See `docs/provider-benchmarks.md` for full rationale.

## Acceptable use

Potter is for legitimate B2B research: prospecting, account intelligence, candidate research, market research, competitive analysis. It is not for:

- Mass cold-outreach automation
- Scraping personal information at scale for redistribution
- Automating LinkedIn actions (connection requests, messaging, comment spam)

You are responsible for complying with the terms of service of every third-party provider Potter integrates with (Apify, Firecrawl, Browserbase, LinkedIn, Anthropic, OpenAI). Browser tools (`potter_browser_*`) actively reject any URL or active page on `linkedin.com`; use the LinkedIn primitives instead.

Potter stores nothing. Every call is pass-through.

## LinkedIn operational note

Potter does not scrape LinkedIn directly. It calls third-party data providers (Apify Harvest, Apimaestro) with your own API keys. Those providers run their own scraping infrastructure and absorb the LinkedIn-side risk.

For high-volume use, run Potter from a dedicated machine or VPN. Heavy LinkedIn calls under your normal IP could trigger LinkedIn's anti-automation against accounts on your network.

## Configuration reference

All Potter env vars are prefixed `POTTER_`. Full list in `.env.example`. Critical ones:

- `POTTER_APIFY_TOKEN`, `POTTER_FIRECRAWL_API_KEY`: required for LinkedIn + web tools.
- `POTTER_BROWSERBASE_API_KEY` + `POTTER_BROWSERBASE_PROJECT_ID`: required for browser tools (or fall back to local Playwright).
- `POTTER_ANTHROPIC_API_KEY` / `POTTER_OPENAI_API_KEY`: optional, only for `potter_browser_act` LLM fallback when Browserbase isn't available.
- `POTTER_MAX_RESPONSE_BYTES=20000`: response cap (recommend not raising; Claude Code's context cost goes up fast).
- `POTTER_CONCURRENCY_LIMIT=5`: provider call concurrency.
- `POTTER_BROWSER_SESSION_TIMEOUT_MINUTES=10`: browser session idle timeout.
- `POTTER_ENABLE_EXPERIMENTAL_BROWSER_ACT=true`: enable LLM-driven `potter_browser_act` (experimental in v1).
- `POTTER_ENABLE_PING=false`: `potter_ping` health check, off by default to match the locked 21-tool surface.

## Troubleshooting

See [docs/troubleshooting.md](https://github.com/Mihailo2501/potter-mcp/blob/main/docs/troubleshooting.md) for: Playwright install failures, libnss3 on Linux, Node version mismatches, stuck browser sessions, tool-selection misfires, partial-failure envelope shapes.

## Contributing

See [CONTRIBUTING.md](https://github.com/Mihailo2501/potter-mcp/blob/main/CONTRIBUTING.md). Maintained by one person in spare time. Bug fixes, provider-adapter PRs, docs, and example prompts all welcome. New tools or composites get a discussion first (open an issue) so we can keep the surface coherent.

## Security and data handling

Potter stores nothing. Every request is pass-through to the configured provider with your own keys. Logs go to stderr only and pass through a redaction layer that masks any configured token value before write. No telemetry, no analytics, no remote calls outside the providers you configure.

## Acknowledgments

Thanks to Brandon Guerrero, my Clay Bootcamp mentor, who encouraged me to build this.

## License

MIT. See [LICENSE](https://github.com/Mihailo2501/potter-mcp/blob/main/LICENSE).
