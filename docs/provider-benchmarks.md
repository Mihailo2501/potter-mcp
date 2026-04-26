# Potter Apify Actor Benchmark Results

**Tested on:** 2026-04-24T21-15-14
**Fixtures per category:** 5
**Run timeout:** 120s each

## profile

| Actor | Success | Median latency (s) | Total cost (USD) | Avg first-item (kB) |
|-------|---------|--------------------|------------------|---------------------|
| `dev_fusion/Linkedin-Profile-Scraper` | 5/5 | 3.1 | 0.0000 | 0.1 |
| `harvestapi/linkedin-profile-scraper` | 5/5 | 4.8 | 0.0000 | 13.6 |
| `apimaestro/linkedin-profile-batch-scraper-no-cookies-required` | 5/5 | 4.7 | 0.0000 | 5.4 |

## company

| Actor | Success | Median latency (s) | Total cost (USD) | Avg first-item (kB) |
|-------|---------|--------------------|------------------|---------------------|
| `dev_fusion/Linkedin-Company-Scraper` | 4/5 | 4.3 | 0.0000 | 15.4 |
| `apimaestro/linkedin-company-detail` | 5/5 | 3.6 | 0.0000 | 3.1 |
| `harvestapi/linkedin-company` | 5/5 | 5.2 | 0.0002 | 20.2 |

## posts

| Actor | Success | Median latency (s) | Total cost (USD) | Avg first-item (kB) |
|-------|---------|--------------------|------------------|---------------------|
| `harvestapi/linkedin-profile-posts` | 3/5 | 5.6 | 0.0002 | 4.8 |
| `apimaestro/linkedin-profile-posts` | 5/5 | 4.0 | 0.0000 | 1.8 |
| `apimaestro/linkedin-batch-profile-posts-scraper` | 5/5 | 5.9 | 0.0000 | 1.8 |

## employees

| Actor | Success | Median latency (s) | Total cost (USD) | Avg first-item (kB) |
|-------|---------|--------------------|------------------|---------------------|
| `harvestapi/linkedin-company-employees` | 4/5 | 13.8 | 0.0840 | 54.5 |
| `apimaestro/linkedin-company-employees-scraper-no-cookies` | 4/5 | 8.1 | 0.0000 | 0.8 |

## Winner selection rules
1. Highest success count wins the category.
2. On tie: best median latency.
3. On further tie: lowest total cost.
4. Spot-check raw field completeness before baking the winner into `src/providers/apify-actors.ts`.

## Winners (after raw sample review)

| Category | Winner | Reason |
|---|---|---|
| profile | `harvestapi/linkedin-profile-scraper` | Rich flat schema (firstName, headline, experience[5], education[3], location, about). `dev_fusion` reported 5/5 runs SUCCEEDED but the actor emitted error items — a scoring bug in the benchmark; `dev_fusion` is **not** a viable fallback. |
| company | `harvestapi/linkedin-company` | 5/5 success with the richest schema: name, tagline, description, website, employeeCount, followerCount, foundedOn, specialities, industries, locations. `dev_fusion` missed vanta (4/5). |
| posts | `apimaestro/linkedin-profile-posts` | 5/5 success; `harvestapi/linkedin-profile-posts` only 3/5. Flat schema (urn, posted_at, text, url, author, stats, media). |
| employees | `apimaestro/linkedin-company-employees-scraper-no-cookies` | Both candidates 4/5 in the 2026-04-24 benchmark. Initially picked `harvestapi` for its richer payload (54.5 kB vs 0.8 kB per first item). Reverted on 2026-04-25 after discovering: (a) `composite.ts:scoreEmployee` only reads `headline` + `current_title`, so the extra data wasn't consumed; (b) `harvestapi` enforces a hard 10-run-lifetime cap on Apify Free-plan users, refusing to return data after that, then asking users to upgrade to Apify Starter ($49/mo). That breaks Potter's BYOK pitch for new users. `apimaestro` is pay-per-result with no subscription wall ($10/1,000 results = $0.25 per find_decision_maker run at the default 25-cap), so the $5 Apify sign-up credit covers ~20 trial runs without forcing a plan upgrade. Switched the default in `src/providers/apify-actors.ts`. `harvestapi` remains a valid override via `POTTER_APIFY_LINKEDIN_EMPLOYEES_ACTOR_INTERNAL` for users on Apify paid plans who want richer per-employee data for downstream tooling. |

Known benchmark scoring bug: `run.status === "SUCCEEDED"` plus `items.length > 0` doesn't catch actors that emit `{error: ...}` dataset items. Worked around by spot-checking raw samples; tighten the script before re-running.
