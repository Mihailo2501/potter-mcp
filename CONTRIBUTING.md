# Contributing

Potter is an open-source MCP for Claude Code. Maintained by one person in spare time. PRs and issues are welcome: bug fixes, provider adapter updates, new Apify actors, docs, examples, prompt patterns. New tools or composites get a discussion first (open an issue) so the surface stays coherent. Everything else is fair game.

## Development setup

```bash
# Clone
git clone https://github.com/Mihailo2501/potter-mcp.git
cd potter-mcp

# Install
npm install

# Build (TypeScript → dist/)
npm run build

# Run the dev MCP from src (auto-reloads on change)
npm run dev

# Tests
npm test               # unit + structural, no API cost
npm run test:safety    # safety guards, no API cost
npm run test:gate      # full gate, includes live composites (~$1-2 in Apify + Firecrawl per run; ~6 actor runs + ~10 Firecrawl calls)
```

You need a `.env` with at minimum `POTTER_APIFY_TOKEN` and `POTTER_FIRECRAWL_API_KEY` for the live tests. See `.env.example` for the full list.

## Project structure

```
src/
  index.ts                    # MCP server entry (stdio transport)
  config.ts                   # POTTER_* env var loading
  errors.ts                   # PotterError shape, redactSecrets, errorToContent
  truncation.ts               # 20KB response cap with truncation markers
  urls.ts                     # URL canonicalization, LinkedIn detection, SSRF guard
  logging.ts                  # stderr logger with secret redaction
  types.ts                    # CanonicalProfile / Company / Post / Employee
  tools/
    registry.ts               # defineTool() helper, JSON schema sanitization
    linkedin.ts               # potter_linkedin_profile / company / posts
    web.ts                    # potter_web_scrape / search / crawl
    browser.ts                # potter_browser_* (open, click, fill, scroll, extract,
                              #   inspect_styles, screenshot, close, act)
    composite.ts              # 5 composites (research_person, research_company,
                              #   summarize_linkedin_posts, find_decision_maker,
                              #   extract_structured)
    provider-status.ts        # potter_provider_status
    ping.ts                   # potter_ping (gated by POTTER_ENABLE_PING)
  providers/
    apify.ts                  # ApifyClient wrapper with retry + backoff
    apify-actors.ts           # per-actor normalizers (raw → canonical)
    firecrawl.ts              # FirecrawlClient wrapper (scrape/search/crawl/extract)
    stagehand.ts              # Browser session manager (Browserbase or local Playwright)
  composite/
    utils.ts                  # resolveCompanyTarget, runParallel, deriveConfidence,
                              #   buildCompositeEnvelope, etc.
    theme-extractor.ts        # tf-idf themes + notable quotes for summarize_linkedin_posts
test/
  truncation.test.ts          # truncation logic
  urls.test.ts                # URL canonicalization + LinkedIn detection
  registry-structure.test.ts  # tool registration drift, doc-count drift,
                              #   Zod default-required gotcha
  providers.smoke.test.ts     # opt-in live smoke (POTTER_SMOKE=1)
  golden/
    safety.golden.test.ts     # 17 safety-guard tests, no API cost
    composites.golden.test.ts # live composite tests (POTTER_GOLDEN=1, ~$1 per run)
docs/                         # tools.md, installation.md, troubleshooting.md
examples/                     # copy-paste prompt examples
```

## How to add an Apify actor

If an actor we ship breaks, or you want a richer alternative, edit `src/providers/apify-actors.ts`:

1. Add the actor slug to the relevant input-builder branch in `buildInputForActor`. Different actors take different input shapes; mirror an existing branch.
2. Write a normalizer (e.g. `normalizeNewActorProfile`) that maps the actor's raw output to the canonical shape: `CanonicalProfile`, `CanonicalCompany`, `CanonicalPost`, or `CanonicalEmployee` from `src/types.ts`.
3. Add the actor → normalizer dispatch in the relevant `getLinkedIn*` function.
4. Document the swap in `docs/provider-benchmarks.md` with cost-per-result, fields returned, and a benchmark date so future contributors know why this actor was chosen.

Users opt into your actor via env var override (`POTTER_APIFY_LINKEDIN_*_ACTOR`). The normalizer is the contract; without it, the tool returns a structured error pointing them at this file.

## How to add a tool

Tools live in `src/tools/<category>.ts` (linkedin, web, browser, or a new file). Each tool is a `defineTool({...})` registration:

1. Define a Zod schema for the args. Keep optional fields as `.optional()` without `.default()`. Zod's JSON schema serializer marks defaulted fields as required, which surfaces wrong in the MCP `inputSchema`. Apply defaults in the run function via `?? fallback`. The structural test enforces this.
2. Write the run function. Validate URLs with the helpers in `src/urls.ts` (`isLinkedInUrl`, `canonicalizeWebUrl`, `ensureUrlAllowed` for SSRF). For LinkedIn rejection in non-LinkedIn tools, mirror the local `rejectIfLinkedInUrl` helper at the top of `src/tools/web.ts` or `src/tools/browser.ts` (it's a per-file convenience wrapper around `isLinkedInUrl` + `PotterError`).
3. Wrap responses in the canonical envelope: `{ source_urls, provider_status, warnings, ...payload }`. The truncation layer caps the final JSON at 20KB and adds a marker.
4. Append the tool to its category's exported array in `src/tools/<category>.ts` (e.g. `webTools`, `browserTools`, `compositeTools`). The arrays are imported by `src/index.ts` `buildToolRegistry()`; you only need to touch `src/index.ts` if you're adding an entirely new category file.
5. Write the tool description carefully. Tool selection is sensitive to wording. Name what the tool does AND when to prefer it over alternatives. Look at existing descriptions for the pattern.
6. Add a structural test in `test/registry-structure.test.ts` if the tool has a non-obvious schema invariant or description claim.
7. Update `docs/tools.md` and the README's "What's in the box" section. The tool count in both must match `launchTools.length`; the structural test enforces this.

## How to add a composite

Composites live in `src/tools/composite.ts` and orchestrate multiple primitive calls:

1. Define the args schema and `defineTool` registration the same way as a primitive.
2. Use `runParallel` from `src/composite/utils.ts` to fan out provider calls with bounded concurrency.
3. Use `outcomeFromSettled` or `outcomeFromResult` to capture per-call success/failure.
4. Use `buildCompositeEnvelope` to assemble the response. It populates `data_quality` (confidence + missing fields), partial-failure handling, and `provider_status`. Composites must always return partial data on partial failure; never silently drop a sub-call's results.
5. Append the tool to the `compositeTools` exported array at the bottom of `src/tools/composite.ts` so it surfaces through `buildToolRegistry()`.
6. Add a live golden test in `test/golden/composites.golden.test.ts`. Composites are expensive to test; the golden suite is gated by `POTTER_GOLDEN=1`.

## How to add a test

- **Unit tests** (no API cost): `test/<name>.test.ts`. Run via `npm test`.
- **Structural tests** (registry / doc-drift / schema invariants): add to `test/registry-structure.test.ts`.
- **Safety tests** (guards must reject specific inputs): add to `test/golden/safety.golden.test.ts`. Run via `npm run test:safety`. No API cost.
- **Live tests** (real providers, real money): add to `test/golden/composites.golden.test.ts`. Run via `npm run test:golden` with `POTTER_GOLDEN=1`. Note the estimated cost in the test name or comment.

## Code style

- TypeScript strict mode. `noUncheckedIndexedAccess` enabled.
- kebab-case file names throughout.
- Pure functions where possible; side effects at provider and transport boundaries.
- No comments on what code does; well-named identifiers do that. Comments only for non-obvious WHY (a workaround, a hidden constraint, a subtle invariant).
- Errors always return `PotterError` with `tool`, `provider`, `reason`, `retryable`, `recommended_action`, optional `status_code`.
- Logs go to stderr only. stdout is reserved for the MCP protocol. Every token-bearing string passes through `redactSecrets()` before any log or error response.
- Pin every new dependency to an exact version. No `^`-range.

## Scope

**Always welcome (PR away):**
- Bug fixes with a reproducing test
- Provider adapter updates (Apify actor schema drift, Firecrawl SDK migrations, Stagehand version bumps)
- New Apify actors with a normalizer (per the walkthrough above)
- Documentation, examples, prompt patterns
- Performance improvements with a before/after measurement
- Cross-platform fixes (Linux libnss3, Windows path separators, etc.)

**Discussion first (open an issue):**
- New tools or composites
- New provider integrations
- Schema changes to canonical types in `src/types.ts`
- Anything that changes the response envelope shape

**Permanently closed:**
- Caching, telemetry, hosted-tier hooks, billing of any kind
- Any LLM call inside the MCP except `potter_browser_act`
- LinkedIn cookie or self-scrape paths (Apify only is locked)

## Issue template

```
- Potter version: <output of `potter-mcp --version`>
- Node version: <`node --version`>
- OS: <macOS / Linux distro / Windows-WSL>
- Provider: <apify | firecrawl | browserbase | stagehand | composite>
- Tool: <potter_xxx>
- Args: <redacted args>
- Expected:
- Got: <full structured error envelope>
- Reproduces: <every time | sometimes | once>
- Repro steps:
```

## Response time

Best-effort. I check issues weekly. Critical bugs (security, data loss) get same-day attention. Everything else may take a week or two.

## Releases

Releases follow semver. Canonical types in `src/types.ts` count as public API; any change there bumps minor at minimum.

A release ships when:
- A critical bug fix is merged
- A breaking provider change requires an adapter update
- 5+ minor fixes have stacked
