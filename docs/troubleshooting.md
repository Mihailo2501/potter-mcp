# Troubleshooting

Common Potter issues and fixes.

## Install / connection

### `claude mcp list` shows Potter as `✗ Failed`

Likely causes:
1. Node version too old. Check: `node --version`. Need ≥ 20.
2. The launched process is crashing on startup. Run `npx -y potter-mcp` directly in a terminal; the stderr output will show the failure (typically a config parse error).
3. `npx` cannot reach the npm registry (offline, behind a corporate proxy). Try `npm install -g potter-mcp` once and change the MCP `command` to `potter-mcp` (with empty `args`).

### `tools/list` returns 22 tools instead of 21

`POTTER_ENABLE_PING=true` is set. The `potter_ping` health-check tool is dev-only and gated off by default. Set `POTTER_ENABLE_PING=false` (or remove the env var) to match the locked 21-tool launch surface.

### `tools/list` returns 0 Potter tools

Claude Code didn't pick up Potter for this session. Restart Claude Code. If that doesn't help, run `claude mcp remove potter` then re-add.

## Provider auth

### "POTTER_APIFY_TOKEN is not set"

Set the env var either in `~/.claude.json`'s `potter.env` block or in a `.env` file inside Potter's package directory. Restart Claude Code after.

### Apify returns 401 "User was not found or authentication token is not valid"

Token wrong or expired. Common pitfalls:
- Token doesn't start with `apify_api_`. You may have copied a public key or user ID instead. Get the **Personal API token** from https://console.apify.com/settings/api.
- Whitespace around the token (rare; Potter trims, but worth checking).
- Token is for a deleted Apify account.

### Firecrawl returns 401 "Invalid token"

Token wrong. Firecrawl tokens start with `fc-`. Get one from https://www.firecrawl.dev/app under API Keys.

### Browserbase returns 401 "Unauthorized"

Most common cause: API key and Project ID are **swapped**. The API key starts with `bb_live_`. The Project ID is a UUID (36 chars with dashes). They are two different fields on the Browserbase settings page.

Run `potter_provider_status` with `include_live_checks=true` to see which provider is failing and what the API said.

## Browser tools

### `potter_browser_open` hangs or fails on a LOCAL session

Local mode requires Playwright Chromium. Install once:

```bash
npx playwright install chromium
```

On Linux, also install the system libs:

```bash
sudo apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxshmfence1 libpango-1.0-0 libcairo2 libasound2
```

If Browserbase credentials are present, Potter prefers them. Local Playwright is only the fallback.

### Browser session times out mid-call

Default idle timeout is 10 minutes (`POTTER_BROWSER_SESSION_TIMEOUT_MINUTES=10`). Lease-aware close: in-flight calls reset the timer, so a long `browser_act` won't get killed mid-execution. If you're hitting timeouts on legit long calls, raise the env.

### "Unknown or expired session"

Either the session ID was wrong, or the session timed out. Open a new one with `potter_browser_open`.

### `potter_browser_act` says "EXPERIMENTAL is disabled"

Set `POTTER_ENABLE_EXPERIMENTAL_BROWSER_ACT=true` and restart. The flag default is `true` in `.env.example` but if the Claude Code MCP env block is set explicitly, you may have inherited `false`.

### `potter_browser_act` (or click / fill / extract-with-instruction / scroll-to-selector) fails with "no LLM configured"

These tools route through Stagehand's LLM-driven `act()`. Order of preference:
1. Browserbase session: uses the bundled Browserbase LLM (free with BB).
2. LOCAL session + `POTTER_ANTHROPIC_API_KEY`: Stagehand uses Anthropic.
3. LOCAL session + `POTTER_OPENAI_API_KEY`: Stagehand uses OpenAI.

If you're on LOCAL with no Anthropic/OpenAI key, all of the above fail. The deterministic browser primitives (`open`, direction-only `scroll`, `inspect_styles`, `screenshot`, `close`) work without an LLM.

## Tool selection

### Claude Code keeps firing `potter_research_person` when I just want a profile lookup

The composite description's "use when" is too broad. Edit the description in `src/tools/composite.ts` for `potter_research_person` and add an explicit `Don't use when:` clause that names the lookup case ("for a single profile lookup, use potter_linkedin_profile"). Rebuild + reconnect.

### Claude Code calls `potter_extract_structured` without a schema

The default tool description should disqualify this case, but if it slips through, tighten the description in `src/tools/composite.ts` to require an explicit field list or schema in the prompt.

### Tool selection drifts between runs

LLM tool selection has nondeterminism. Use `npm run qa` to score 50 prompts across 3 runs and find which descriptions are flaky.

## Data / output

### Response is empty but no error

Some Apify actors return zero items for valid-looking inputs (especially the employees actor on certain companies). Check `data_quality.confidence`: `low` or `not_found` means the actor returned nothing scoreable. Try a different fixture.

### `_truncation` appears in the response

Potter caps responses at 20KB (`POTTER_MAX_RESPONSE_BYTES`). When over, it shrinks the largest sub-fields recursively. The `_truncation.notes` field tells you what was shrunk. If you need a bigger cap, raise `POTTER_MAX_RESPONSE_BYTES`, but Claude Code's context cost goes up.

### Composite returns `partial_data` and `failure_point`

That's the partial-failure envelope. A core sub-call failed (typically `apify_profile` or `apify_employees`), but Potter still returned what it could collect. The `provider_status` array's `error` entries have the structured details for retry guidance.

## Performance / rate limits

### Apify 429 errors

Potter retries with exponential backoff capped at 30s cumulative. If you're still seeing 429s, you're hitting Apify's account-level limit; wait or upgrade your Apify plan. Lower `POTTER_CONCURRENCY_LIMIT` (default 5) to space out calls.

### Firecrawl 429 errors

Same retry policy. If you're still hitting 429s, you're out of credits or over your account-level concurrency. Check your Firecrawl dashboard for current credit balance and rate limits.

## Logging / debugging

### Potter writes nothing to stderr

Logs go to stderr only (stdout is reserved for MCP protocol). Check `POTTER_LOG_LEVEL` (default `info`). Set to `debug` for more detail.

### Logs contain `***`: what got redacted?

Any string matching a configured `POTTER_*` token value (length ≥ 4) gets replaced with `***` before write. This applies to error responses and stderr logs. If you're seeing too much redaction, your token might be a substring of unrelated content; rotate the token to a less-common-looking value.

## QA harness

### `npm run qa` fails with "claude: command not found"

Set `CLAUDE_BIN=/path/to/claude` in your env. Default assumes `claude` is on PATH.

### QA harness reports "(no tool)" for many prompts

Two likely causes:
1. Potter isn't loaded in the Claude Code session that `claude -p` spawned. Run from inside the Potter package directory or set `--mcp-config` explicitly. The harness does this automatically by setting cwd to the package root.
2. Claude Code refused the prompt (acceptable for adversarial prompts 47, 48, 50). For those, "(no tool)" is the expected pass condition.

## Filing a bug

Reproduction template:
```
- Potter version: <output of `potter-mcp --version`>
- Node version: <`node --version`>
- Provider: <apify | firecrawl | browserbase | stagehand>
- Tool: <potter_xxx>
- Input: <args>
- Expected:
- Got: <full error envelope or response>
- Reproduces: <every time | sometimes | once>
```

File at https://github.com/Mihailo2501/potter-mcp/issues with that template + the relevant stderr log slice.
