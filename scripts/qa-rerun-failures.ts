#!/usr/bin/env tsx
/**
 * Targeted re-run for the prompts that failed in docs/qa-results.md.
 *
 * Runs only the 19 failure ids against the CURRENT tool descriptions / handlers,
 * writes results to docs/qa-results-failures.md, and uses a separate checkpoint
 * (docs/qa-progress-failures.jsonl) so the full-suite checkpoint stays intact.
 *
 * By default, disables Claude Code's built-in WebFetch + WebSearch via
 * --disallowedTools so we measure Potter's tool descriptions in isolation
 * instead of losing every neutral-verb prompt to built-ins. Pass
 * --allow-builtin-web to opt back in.
 *
 * Usage:
 *   npx tsx scripts/qa-rerun-failures.ts                      # all 19, built-ins disabled
 *   npx tsx scripts/qa-rerun-failures.ts --ids=8,49           # subset
 *   npx tsx scripts/qa-rerun-failures.ts --resume             # honor existing checkpoint
 *   npx tsx scripts/qa-rerun-failures.ts --allow-builtin-web  # let WebFetch + WebSearch compete
 *
 * Cost estimate at the prior $0.20 / run avg: 19 * 3 * $0.20 ≈ $11.40 worst case.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runQa } from "./qa-runner.js";

const FAILURE_IDS = [8, 10, 13, 17, 20, 22, 24, 25, 26, 27, 28, 30, 33, 36, 41, 42, 43, 46, 49];

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, "..");

const argv = process.argv.slice(2);
const idsArg = argv.find((a) => a.startsWith("--ids="));
const ids = idsArg
  ? idsArg
      .slice("--ids=".length)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
  : FAILURE_IDS;

const resume = argv.includes("--resume");
const allowBuiltinWeb = argv.includes("--allow-builtin-web");

if (!allowBuiltinWeb && process.env.POTTER_QA_DISALLOW_BUILTIN_WEB === undefined) {
  process.env.POTTER_QA_DISALLOW_BUILTIN_WEB = "true";
}

await runQa({
  ids,
  outPath: path.join(packageRoot, "docs", "qa-results-failures.md"),
  checkpointPath: path.join(packageRoot, "docs", "qa-progress-failures.jsonl"),
  ignoreCheckpoint: !resume,
  reset: !resume,
});
