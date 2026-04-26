# Potter Tools Reference

21 tools, plus `potter_ping` (dev-only, gated by `POTTER_ENABLE_PING`).

## Composites (5)

### `potter_research_person(linkedin_url, context?, include_github?)`

BETA. Fans out: LinkedIn profile + recent posts + current company + Firecrawl news search (optionally GitHub search). Returns a consolidated dossier with `data_quality.confidence` and partial-failure envelope when sub-calls fail.

- **Use when:** "Research [LinkedIn URL]," "Tell me about [LinkedIn URL]," "Brief me on [LinkedIn URL]."
- **Don't use when:** No URL provided. Claude Code should ask first.
- **Provider mix:** Apify (profile, posts, company), Firecrawl (news search).
- **Returns:** `{ source_urls, provider_status, warnings, data_quality, person: { profile, posts, current_company?, news?, github? } }` or `{ ..., partial_data, failure_point }` when the profile call itself fails.

### `potter_research_company(url_or_domain, focus?)`

Fans out: LinkedIn company page (if URL given) + 6 site pages (root, about, pricing, careers, blog, press) + a news search. Optional `focus` adds extra terms to the news query (does not change page selection).

- **Use when:** "Research [company]," "Get the rundown on [domain]," "Is [company] hiring [role]?"
- **Don't use when:** You only need a single page; use `potter_web_scrape`.
- **Provider mix:** Apify (LinkedIn company), Firecrawl (page scrapes + search).

### `potter_summarize_linkedin_posts(linkedin_url, limit?, time_window?)`

BETA. Fetches recent posts and computes heuristic themes via tf-idf (no LLM) + ranks notable quotes by engagement (reactions + 3 × comments). `time_window` filters to `week`/`month`/`quarter`/`year`/`all`.

- **Use when:** "What does [person] post about?", "Themes from [LinkedIn]'s recent posts."
- **Don't use when:** User asked for raw posts; use `potter_linkedin_posts`.
- **Returns:** `{ heuristic_themes[], notable_quotes[], posts[], post_count, date_unknown_count, data_quality }`.

### `potter_find_decision_maker(company_url_or_domain, role_description, seniority?, num_candidates?)`

BETA. Pulls company employees via the internal Apify employees actor, scores each by token-overlap + char-similarity against `role_description`, applies seniority boost (one of `ic`, `lead`, `manager`, `director`, `vp`, `c_suite`). Returns ranked candidates with `match_reason`.

- **Use when:** "Find me the [role] at [company]," "Who runs [department] at [company]?"
- **Don't use when:** No role provided. Claude Code should ask.
- **Returns:** `{ candidates[], candidate_count, company, role_description, seniority, data_quality }` or partial-failure envelope when the LinkedIn URL is missing.

### `potter_extract_structured(url, schema, prompt?)`

Extracts structured data from a public web page using Firecrawl's JSON format. Schema is depth-capped at 5 levels and `additionalProperties: false` is forced on every object. Rejects LinkedIn URLs (use the LinkedIn primitives).

- **Use when:** User provides an explicit field list or JSON schema.
- **Don't use when:** No schema hint; prefer `potter_web_scrape`.
- **Returns:** `{ extracted, data_quality }`.

## LinkedIn primitives (3)

### `potter_linkedin_profile(url, include?)`
Single profile fetch. Returns canonical profile with `data_quality: full | sparse | not_found | protected`. `include` accepts extra section tokens (currently echoed in warnings if unsupported).

### `potter_linkedin_company(url, include?)`
Company page. Same canonical/quality pattern.

### `potter_linkedin_posts(url, limit?, since?)`
Recent posts. `since` is an ISO date filter applied client-side after the fetch.

## Web primitives (3)

### `potter_web_scrape(url, format?, wait_for?)`
Single page via Firecrawl. `format` ∈ `markdown | html | links` (default markdown). Use `format: "html"` for raw markup when you need `<script>` / `<link>` / `<meta>` tags (vendor fingerprinting, analytics IDs, third-party widgets, marketing-stack reverse-engineering); markdown strips these. `wait_for` is a millisecond delay for client-rendered pages. Rejects LinkedIn URLs.

### `potter_web_search(query, limit?, site?)`
Firecrawl search. `site` is canonicalized and appended as a `site:` operator; LinkedIn domains rejected. Defaults to ~10 results.

### `potter_web_crawl(url, max_pages?, include_patterns?, exclude_patterns?)`
Sitemap-aware crawl. `max_pages` defaults to 5, hard max 50. `include_patterns` / `exclude_patterns` are glob-style path filters. Rejects LinkedIn URLs.

## Browser tools (9)

All browser tools reject LinkedIn URLs and refuse to operate on a session whose active page is on `linkedin.com`.

### `potter_browser_open(url, stealth?, viewport?, user_agent?, force_local?)`
Creates a new browser session. Auto-selects Browserbase if `POTTER_BROWSERBASE_*` are set; falls back to LOCAL Playwright. Returns `{ session_id, env, url }`.

### `potter_browser_click(session_id, selector_or_description)`
LLM-backed via Stagehand's `act()`. CSS selectors and natural language both work. Requires Browserbase OR an Anthropic/OpenAI key for LOCAL.

### `potter_browser_fill(session_id, selector_or_description, value, submit?)`
Same backing. `submit=true` presses Enter after typing.

### `potter_browser_scroll(session_id, direction, amount?, to_selector?)`
`direction` ∈ `up | down | top | bottom`. With `to_selector`, scrolls that element into view via Stagehand. Otherwise uses raw page evaluate (no LLM).

### `potter_browser_extract(session_id, instruction?, schema?)`
With no instruction: returns full page text. With instruction: routes through Stagehand's LLM extract. Optional JSON schema gets passed to Stagehand's `extract()`.

### `potter_browser_inspect_styles(session_id, selectors, properties?, max_matches_per_selector?)`
Read computed CSS via `getComputedStyle` on the rendered DOM. Deterministic, read-only, no LLM. Returns `{ matches: { [selector]: [{ [property]: value }] } }` per matched element. `properties` defaults to a curated set: `color`, `background-color`, `font-family`, `font-size`, `font-weight`, `line-height`, `padding`, `margin`, `border-radius`, `box-shadow`, `max-width`. `max_matches_per_selector` defaults to 5, capped at 20. Selectors that match nothing or are syntactically invalid return `[]` for that key (no error). Values are the browser's resolved values (`rgb()` not hex; pixel sizes not rem). Use this for design-system extraction where `potter_browser_extract` would only hallucinate values against the accessibility tree.

### `potter_browser_screenshot(session_id, full_page?)`
Returns base64-encoded PNG.

### `potter_browser_close(session_id)`
Lease-aware close. Waits up to 30s for in-flight operations to drain before terminating the session.

### `potter_browser_act(session_id, goal, max_steps?, allow_providers?)`
EXPERIMENTAL. Stagehand-driven multi-step browser action against a natural-language goal. Requires Browserbase (bundled LLM) or LOCAL + Anthropic/OpenAI key. `max_steps` and `allow_providers` are accepted but not strictly enforced in v1; Stagehand's internal policy is used.

## Utility (1)

### `potter_provider_status(include_live_checks?)`
Reports which providers Potter has credentials for. With `include_live_checks=true`, also fires a lightweight live API call per provider to validate the token. Live-check error details pass through Potter's redaction layer, so token-bearing error strings are masked.

## Output envelope shapes

Every provider-backed tool wraps its payload in:
```json
{
  "source_urls": [],
  "provider_status": [{ "provider": "apify", "ok": true }],
  "warnings": [],
  ...payload
}
```

Composites add:
```json
"data_quality": {
  "confidence": "high|medium|low",
  "missing_fields": [],
  "limitations": []
}
```

Composites with a core sub-call failure return:
```json
{
  "partial_data": {},
  "failure_point": "apify_profile|apify_posts|...",
  "provider_status": [...],
  "warnings": [...]
}
```

All errors return:
```json
{
  "error": {
    "tool": "...",
    "provider": "apify|firecrawl|stagehand|potter|...",
    "reason": "...",
    "retryable": true,
    "status_code": 429,
    "recommended_action": "..."
  }
}
```

`reason` and `recommended_action` are passed through `redactSecrets()` so configured tokens never leak through error responses.
