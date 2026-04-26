# Installation

## Requirements

- Node.js ≥ 20
- macOS or Linux (Windows works through WSL; native Windows is best-effort)
- Claude Code (`brew install claude-code` or via Anthropic's installer)
- Provider accounts:
  - **Required:** Apify, Firecrawl
  - **Required for browser tools:** Browserbase OR local Playwright Chromium via `npx playwright install`
  - **Required for natural-language browser actions in LOCAL mode** (click, fill, extract with instruction, scroll-to-selector, act): an Anthropic OR OpenAI key. Browserbase sessions ship with a bundled LLM and don't need this.

## Step 1: Get provider keys

| Provider | Where | Format |
|---|---|---|
| Apify | https://console.apify.com/settings/api | starts with `apify_api_` |
| Firecrawl | https://www.firecrawl.dev/app (API Keys tab) | starts with `fc-` |
| Browserbase | https://www.browserbase.com/settings | API key starts with `bb_live_`; Project ID is a UUID. They are two different fields. |

Common pitfall: pasting the Browserbase Project ID into the API key slot, or vice versa. The values look similar; read the labels carefully.

## Step 2: Register Potter with Claude Code

Inline (recommended):

```bash
claude mcp add potter -e POTTER_APIFY_TOKEN=apify_api_xxx -e POTTER_FIRECRAWL_API_KEY=fc-xxx -e POTTER_BROWSERBASE_API_KEY=bb_live_xxx -e POTTER_BROWSERBASE_PROJECT_ID=xxx -- npx -y potter-mcp
```

Or, edit `~/.claude.json` directly under `mcpServers`:

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

`npx -y` auto-pulls the latest published version on each session start; no global install needed.

## Step 3: Verify

```bash
claude mcp list
```

Look for: `potter: ... ✓ Connected`.

In a fresh Claude Code session, type `/mcp` and confirm `potter` lists 21 tools.

Quick functional check from any session:

> "Check which providers Potter has credentials for"

Claude Code should fire `potter_provider_status`. If you set `include_live_checks=true`, it'll verify each token actually works against the provider's API.

## Step 4 (only for browser tools): Playwright

If you plan to use any `potter_browser_*` tool **and** are NOT using Browserbase (i.e., running local Chromium):

```bash
npx playwright install chromium
```

On Linux, you may also need:

```bash
sudo apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxshmfence1 libpango-1.0-0 libcairo2 libasound2
```

Browserbase users don't need any of this. Stagehand drives the remote browser.

## Linux specifics

CI runs on Ubuntu in `.github/workflows/test.yml`. Local Playwright Chromium needs the libs above. Otherwise no Linux-specific wiring.

## Windows

Best-effort. If you're on Windows, use WSL2 + Ubuntu. Native Windows is not in the test matrix.

## Uninstall

```bash
claude mcp remove potter
```

`npx -y` doesn't install globally, so there's nothing else to remove.

## Updating

`npx -y potter-mcp` always pulls the latest published version, so updating is automatic. Check the changelog before major versions land; the canonical schemas may change.
