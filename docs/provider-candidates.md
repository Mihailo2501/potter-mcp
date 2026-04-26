# Apify LinkedIn Actor Candidates

**Date:** 2026-04-24
**Source:** Apify Store API (`https://api.apify.com/v2/store`), sorted by popularity.
**Status:** pre-benchmark. Winners get baked into `src/providers/apify-actors.ts` after `scripts/benchmark-actors.ts` runs.

## Selection criteria

- ≥ 500K total runs (shows market adoption)
- ≥ 10 reviews (enough reviewer signal to trust the rating)
- Rating ≥ 3.7 OR strong case for inclusion despite lower rating
- "No cookies" (no LinkedIn session credential requirement, since Potter is stateless BYOK)
- Active in the last 30 days (checked via `lastRunStartedAt`)

Apollo / email-enrichment-specific actors excluded — those are out of Potter v1 scope per FINAL-SPEC-LOCKED §4 (no `potter_enrich_email`).

## Profile (by LinkedIn profile URL)

| # | Actor ID | Runs | Rating | Reviews | Pricing |
|---|----------|------|--------|---------|---------|
| 1 | `dev_fusion/Linkedin-Profile-Scraper` | 17.2M | 4.77 | 125 | $0.01 / result |
| 2 | `harvestapi/linkedin-profile-scraper` | 6.8M | 4.76 | 24 | pay-per-event |
| 3 | `apimaestro/linkedin-profile-batch-scraper-no-cookies-required` | 3.7M | 4.87 | 15 | $0.005 / result |

Note: the slug on candidate #1 is case-sensitive as `Linkedin-Profile-Scraper` (mixed case). `apimaestro/linkedin-profile-detail` has 26M runs but 3.72★ — skipped in favor of the batch variant.

## Company (by LinkedIn company URL)

| # | Actor ID | Runs | Rating | Reviews | Pricing |
|---|----------|------|--------|---------|---------|
| 1 | `dev_fusion/Linkedin-Company-Scraper` | 2.4M | 4.76 | 33 | pay-per-event |
| 2 | `apimaestro/linkedin-company-detail` | 3.7M | 4.47 | 17 | $0.005 / result |
| 3 | `harvestapi/linkedin-company` | 4.7M | 3.77 | 6 | pay-per-event |

## Posts (by LinkedIn profile URL, recent posts)

| # | Actor ID | Runs | Rating | Reviews | Pricing |
|---|----------|------|--------|---------|---------|
| 1 | `harvestapi/linkedin-profile-posts` | 6.4M | 4.90 | 20 | pay-per-event |
| 2 | `apimaestro/linkedin-profile-posts` | 7.8M | 4.58 | 58 | $0.005 / result (single username per call) |
| 3 | `apimaestro/linkedin-batch-profile-posts-scraper` | 434K | 4.65 | 13 | pay-per-event (batch usernames) |

Note: `supreme_coder/linkedin-post` was initially considered but it takes individual post URLs as input, not profile URLs — wrong shape for `potter_linkedin_posts(profile_url, limit?)`.

## Employees (internal, by LinkedIn company URL)

Used only inside `potter_find_decision_maker` per FINAL-SPEC-LOCKED §4 (cut from the public tool list).

| # | Actor ID | Runs | Rating | Reviews | Pricing |
|---|----------|------|--------|---------|---------|
| 1 | `harvestapi/linkedin-company-employees` | 1.7M | 4.81 | 16 | pay-per-event |
| 2 | `apimaestro/linkedin-company-employees-scraper-no-cookies` | 458K | 3.77 | 16 | $0.01 / result |

Only two clean candidates exist in this category. `bebity/linkedin-premium-actor` was initially considered but its `action` enum is `get-profiles` or `get-companies` only — no employees mode. `memo23/linkedin-company-people-scraper` requires LinkedIn cookies (violates Potter's no-cookie principle) and uses a filter-by-position workflow (wrong shape). `caprolok/linkedin-employees-scraper` sits at 1.26★ — unreliable.

Running the benchmark with 2 candidates in this category is acceptable since the winner still gets real-world validation.

## Test fixtures (5 per category)

Locked after benchmark review, but starting set:

**Profiles:**
- `https://www.linkedin.com/in/mihailoskendzic/`
- `https://www.linkedin.com/in/eliasstravik/`
- `https://www.linkedin.com/in/darioamodei/`
- `https://www.linkedin.com/in/satyanadella/`
- `https://www.linkedin.com/in/patrickcollison/`

**Companies:**
- `https://www.linkedin.com/company/anthropicresearch/`
- `https://www.linkedin.com/company/stripe/`
- `https://www.linkedin.com/company/vercel/`
- `https://www.linkedin.com/company/trustvanta/`
- `https://www.linkedin.com/company/ramp/`

**Posts targets:** same 5 profiles.
**Employees targets:** same 5 companies.

## Scoring

`scripts/benchmark-actors.ts` scores each (actor × fixture) pair on:

1. **Success binary** — non-empty data returned within 60s
2. **Field coverage** — % of canonical-type required fields populated
3. **Cost** — actual USD charged per fixture
4. **Latency** — run start → dataset-ready
5. **Schema stability** — does output shape hold across all 5 fixtures

Winner per category = highest field coverage wins ties; lowest cost breaks further ties. Written to `docs/provider-benchmarks.md` with "tested on" date, then baked into `src/providers/apify-actors.ts` as defaults.
