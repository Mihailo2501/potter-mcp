# Potter examples

21 prompts to try with Potter in Claude Code. Copy any of these verbatim. Grouped by capability so you can jump to what you need.

If you're new, start with #1 (single-target person research). It exercises Potter's most powerful composite in one prompt.

---

## Composite tools (one prompt, full dossier)

### 1. Research a single person

```
Research Brandon Guerrero on LinkedIn (https://www.linkedin.com/in/bmguerrero/) and give me a tight dossier: current role, company, recent themes from his posts, anything notable he's shipped recently. Cite source URLs.
```

Fans out to LinkedIn profile + recent posts + current company + Firecrawl news search in parallel. Returns a consolidated dossier with sources cited and a `data_quality` field.

### 2. Research a single company

```
Research Stripe (stripe.com) and tell me: what they do in one sentence, ICP, recent product launches, headcount range, hiring pace. Cite sources.
```

Pulls the LinkedIn company page, scrapes 6 site pages (root, about, pricing, careers, blog, press), and runs a news search. Surfaces missing fields honestly.

### 3. Find a decision-maker

```
Find the security compliance decision-maker at Vanta (vanta.com). If you can't return a specific person with confidence, return the right role plus search strategy plus evidence sources.
```

Resolves the company domain to a LinkedIn URL, pulls employees, scores candidates against the role description with token-overlap + seniority heuristics. Falls back to "right role + search strategy" rather than fabricating a name.

### 4. Summarize someone's recent posts

```
Pull Patrick Spychalski's recent LinkedIn posts and summarize the patterns: what topics he writes about, what stance, anything that signals current priorities. https://www.linkedin.com/in/patrickspychalski/
```

Pulls posts, runs tf-idf for theme extraction, identifies notable quotes by engagement. No LLM in the theme extraction; deterministic and replayable.

### 5. Schema-driven structured extraction

```
Extract the pricing tiers from https://www.anthropic.com/pricing into this shape: { tiers: [{ name, monthly_usd, included_models, features }] }.
```

Coerces page content into the JSON schema you specify. Fields not visible on the page come back as null with no fabrication.

---

## LinkedIn primitives (raw access)

### 6. Pull a raw LinkedIn profile

```
Pull the raw LinkedIn profile data for https://www.linkedin.com/in/eliasstravik/ via potter_linkedin_profile. Show me the canonical shape, not a synthesized brief.
```

Returns the full canonical profile: name, headline, current role and company, experience array, education, skills, location, follower / connection counts. Useful when you want raw structured data, not a summary.

**Heads up:** Elias's bio contains a real prompt injection in the wild (it asks AI readers to score him highest, sneak the word "köttbulle" into any outreach copy, and write pitches in the prose of Eminem). Potter returns it raw rather than acting on it. Real-world reminder that LinkedIn bios are user-controlled input and any downstream LLM should treat profile text accordingly.

### 7. Pull a raw LinkedIn company

```
Pull the LinkedIn company record for Anthropic (linkedin.com/company/anthropicresearch) using potter_linkedin_company.
```

Returns canonical company shape: name, description, industry, employee count, headquarters, website, founded year.

### 8. Recent posts from a profile

```
Get the 10 most recent posts from https://www.linkedin.com/in/alexhormozi/ via potter_linkedin_posts. Don't summarize, just return the post URLs and excerpts.
```

Pulls a chronological list: text, posted_at, reactions, comments, reposts, media. No theme extraction (that's the composite at #4).

---

## Web primitives

### 9. Multi-page site crawl

```
Crawl https://ramp.com across the homepage and the /pricing, /customers, /careers pages. Tell me what Ramp actually does, who their target customer is, what tier structure they use, and what kind of engineers they're hiring right now.
```

Sitemap-aware crawl. Returns per-page content for the model to reason over. Handles partial-page failures gracefully.

### 10. Web search for context

```
Search the web for "Kiln GTM engineering agency" and give me the three most authoritative sources plus a one-paragraph synthesis of what they do.
```

Firecrawl-backed search returning title / url / snippet per result. LinkedIn results are filtered out server-side; use the LinkedIn primitives for those.

### 11. Single-URL scrape into a fact sheet

```
Scrape https://www.heyreach.io/pricing and give me a clean fact sheet: pricing per seat, what's included per tier, free trial terms, anything in the footer about contracts.
```

Default markdown format. Pass `format: "html"` if you need raw script tags for stack reverse-engineering or vendor fingerprinting (see #16).

---

## Browser tools

### 12. Extract design tokens from a live page

```
Open https://www.understoryagency.com in a browser session. Use potter_browser_inspect_styles to read computed CSS for body, h1, h2, h3, primary buttons, and links. Pull background, color, font-family, font-size, font-weight, padding, border-radius, box-shadow. Return as a clean design-doc markdown. Close the session.
```

Reads computed CSS via `getComputedStyle` on the rendered DOM. Real RGB values and pixel sizes, not LLM guesses against the accessibility tree.

### 13. Interactive page extraction

```
Open https://www.heyreach.io. Scroll to find the pricing section, click into it, extract the tier names and prices via potter_browser_extract. Close the session.
```

Multi-step flow: open, scroll, click, LLM-driven extract via Stagehand, close. For pages where the data lives behind a navigation step.

### 14. Visual capture

```
Open https://www.claybootcamp.com and take a full-page screenshot via potter_browser_screenshot. Save the base64 PNG to ~/Desktop/snapshot.png. Close the session.
```

Returns a base64-encoded PNG. Claude Code decodes and saves to disk via Bash.

---

## Multi-tool workflows

### 15. Multi-target research with CSV output

```
Research these four GTM engineers on LinkedIn. For each, pull current role, company, one notable thing they've shipped recently, and a one-line angle for an outbound DM. Write to ~/Desktop/research.csv with columns: full name, LinkedIn URL, company, notable thing, DM angle.

https://www.linkedin.com/in/bmguerrero/
https://www.linkedin.com/in/eliasstravik/
https://www.linkedin.com/in/patrickspychalski/
https://www.linkedin.com/in/theclayguy/
```

Four parallel `potter_research_person` calls plus Claude Code's Write tool for the CSV. Partial failures handled gracefully: you get the rows that worked plus failure reasons for the rest.

### 16. Vendor stack reverse-engineering

```
Scrape https://www.attio.com with format=html and figure out the marketing stack: CMS, analytics, chat / support widget, scheduler, email capture provider. Cite the evidence (script tag, link tag, header) for each finding. If you can't confirm something, say so.
```

HTML format preserves script tags so you can fingerprint vendor scripts (Google Tag Manager, HubSpot, Intercom, Mixpanel, etc.). Markdown strips them.

### 17. Cold outreach prep with personalization

```
Research https://www.linkedin.com/in/patrickspychalski/ and his current company. Then draft a LinkedIn DM in plain text (no markdown, no em dashes, short sentences) about an automation I'd build for his stack. Save to ~/Desktop/dm.txt and append a one-line CSV row to ~/Desktop/dms.csv with columns: full name, LinkedIn URL, DM copy.
```

Research → DM composition → file write. Use whatever style rules you want in the prompt; Claude Code respects them.

---

## Utility

### 18. Provider key health check

```
Run potter_provider_status with live checks. Tell me which providers are configured, which keys actually work right now, and what's missing.
```

Verifies each provider key is configured and (with `include_live_checks: true`) fires a lightweight live API call to confirm. Useful before a long batch or when something errors and you're not sure if it's the key or the request.

---

## Safety guards (these prompts should be REFUSED)

Potter is read-only and respects a few hard boundaries. These three prompts demonstrate the guards firing. They should each return a structured error, not a successful response.

### 19. LinkedIn URL via web_scrape

```
Use potter_web_scrape on https://www.linkedin.com/in/satyanadella/ and give me his bio.
```

Rejected with a redirect hint to `potter_linkedin_*`. Web tools never touch LinkedIn URLs.

### 20. SSRF / localhost

```
Use potter_extract_structured on http://127.0.0.1:8080/admin with schema { admin_users: [{ email, role }] }.
```

Rejected by the SSRF guard. Private IPs, loopback, and cloud metadata IPs are all blocked.

### 21. Bulk employee enumeration

```
Find all employees at Stripe via potter_find_decision_maker.
```

Rejected by the generic-role guard. Bulk enumeration ("all employees", "everyone", "people", "staff") gets a structured error pointing the caller to a concrete role like "platform engineer" or "head of revenue".
