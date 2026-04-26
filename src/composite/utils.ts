import pLimit from "p-limit";
import {
  canonicalizeDomain,
  canonicalizeLinkedInCompanyUrl,
  isLinkedInUrl,
} from "../urls.js";
import { getFirecrawl } from "../providers/firecrawl.js";
import type { ProviderStatusEntry } from "../types.js";

export interface CompanyTarget {
  linkedin_url: string | null;
  domain: string | null;
  raw_input: string;
}

export const resolveCompanyTarget = (input: string): CompanyTarget => {
  const schemed = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  if (isLinkedInUrl(schemed)) {
    const linkedin_url = canonicalizeLinkedInCompanyUrl(schemed);
    return { linkedin_url, domain: null, raw_input: input };
  }
  const domain = canonicalizeDomain(input);
  return { linkedin_url: null, domain, raw_input: input };
};

/**
 * Resolve a company domain to its LinkedIn company URL via a Firecrawl web search.
 *
 * Firecrawl rejects LinkedIn at the `site` parameter level, so we put the site filter in
 * the free-text query instead. Prefers a candidate whose slug exactly matches the domain
 * root (e.g. `linkedin.com/company/vanta` for `vanta.com`); falls back to the first
 * `linkedin.com/company/*` URL in the result list. Returns null if the search fails or no
 * matching URL appears in the first 5 results.
 */
export const resolveLinkedInCompanyUrlFromDomain = async (
  domain: string,
): Promise<string | null> => {
  if (!domain) return null;
  const firecrawl = getFirecrawl();
  const query = `site:linkedin.com/company "${domain}"`;
  const result = await firecrawl.search({ query, limit: 5 });
  if (!result.ok) return null;
  const web = (result.value as { web?: Array<{ url?: unknown }> }).web ?? [];
  const candidates: string[] = [];
  for (const r of web) {
    if (typeof r?.url !== "string") continue;
    if (/linkedin\.com\/company\/[^/?#]+/i.test(r.url)) {
      candidates.push(r.url);
    }
  }
  if (candidates.length === 0) return null;
  const root = domain.split(".")[0]?.toLowerCase() ?? "";
  if (root) {
    for (const url of candidates) {
      const m = url.match(/linkedin\.com\/company\/([^/?#]+)/i);
      if (m && m[1]!.toLowerCase() === root) {
        return canonicalizeLinkedInCompanyUrl(url);
      }
    }
  }
  return canonicalizeLinkedInCompanyUrl(candidates[0]!);
};

export const runParallel = async <T>(
  tasks: Array<() => Promise<T>>,
  concurrency = COMPOSITE_CONCURRENCY_LIMIT,
): Promise<Array<PromiseSettledResult<T>>> => {
  const limit = pLimit(concurrency);
  return Promise.all(
    tasks.map((task) => limit(() => task()).then(
      (value) => ({ status: "fulfilled", value } as PromiseFulfilledResult<T>),
      (reason) => ({ status: "rejected", reason } as PromiseRejectedResult),
    )),
  );
};

export const levenshtein = (a: string, b: string): number => {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  if (aa === bb) return 0;
  const m = aa.length;
  const n = bb.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
};

export const similarity = (a: string, b: string): number => {
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - d / maxLen;
};

export interface CompositeEnvelopeArgs {
  source_urls: string[];
  provider_statuses: ProviderStatusEntry[];
  warnings: string[];
  missing_fields: string[];
  limitations: string[];
}

export const deriveConfidence = (args: {
  ok_count: number;
  total_count: number;
  missing_fields_count: number;
}): "high" | "medium" | "low" => {
  const successRate = args.total_count === 0 ? 0 : args.ok_count / args.total_count;
  if (successRate >= 0.8 && args.missing_fields_count <= 2) return "high";
  if (successRate >= 0.5) return "medium";
  return "low";
};

export const MAX_SCHEMA_DEPTH = 5;
export const COMPOSITE_CONCURRENCY_LIMIT = 4;

const traverseSchema = (
  node: unknown,
  depth: number,
  seen: WeakSet<object>,
): void => {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(`Schema depth exceeds max ${MAX_SCHEMA_DEPTH}`);
  }
  if ("$ref" in obj) {
    throw new Error("Schema $ref is not supported; inline all references before calling.");
  }

  if (obj.type === "object" || obj.properties || obj.patternProperties) {
    obj.additionalProperties = false;
    if (obj.properties && typeof obj.properties === "object") {
      for (const v of Object.values(obj.properties as Record<string, unknown>)) {
        traverseSchema(v, depth + 1, seen);
      }
    }
    if (obj.patternProperties && typeof obj.patternProperties === "object") {
      for (const v of Object.values(obj.patternProperties as Record<string, unknown>)) {
        traverseSchema(v, depth + 1, seen);
      }
    }
  }
  if (obj.items) {
    if (Array.isArray(obj.items)) {
      for (const item of obj.items) traverseSchema(item, depth + 1, seen);
    } else {
      traverseSchema(obj.items, depth + 1, seen);
    }
  }
  if (Array.isArray(obj.prefixItems)) {
    for (const item of obj.prefixItems) traverseSchema(item, depth + 1, seen);
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const list = obj[key];
    if (Array.isArray(list)) {
      for (const branch of list) traverseSchema(branch, depth + 1, seen);
    }
  }
  for (const key of ["$defs", "definitions"] as const) {
    const defs = obj[key];
    if (defs && typeof defs === "object") {
      for (const v of Object.values(defs as Record<string, unknown>)) {
        traverseSchema(v, depth + 1, seen);
      }
    }
  }
};

export const enforceSchemaConstraints = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  traverseSchema(schema, 0, new WeakSet());
  return schema;
};

export const escapeSearchTerm = (input: string): string => {
  return input
    .replace(/[\r\n]+/g, " ")
    .replace(/\s*site:\S*/gi, " ")
    .replace(/\s*(?:inurl|intitle|intext|filetype|cache|link|related|allintext|allintitle|allinurl):\S*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export const quotedPhrase = (input: string): string => {
  const safe = escapeSearchTerm(input).replace(/"/g, "");
  return safe ? `"${safe}"` : "";
};

export const isSettledOk = <T>(
  r: PromiseSettledResult<T>,
): r is PromiseFulfilledResult<T> => r.status === "fulfilled";

export type CompositeProvider = "apify" | "firecrawl" | "stagehand" | "potter";

export interface SubCallOutcome {
  key: string;
  provider: CompositeProvider;
  ok: boolean;
  value?: unknown;
  error?: {
    tool: string;
    provider: string;
    reason: string;
    retryable: boolean;
    status_code?: number;
    recommended_action: string;
  };
}

export interface CompositeAssembly {
  source_urls: string[];
  outcomes: SubCallOutcome[];
  core_failure?: {
    key: string;
    provider: CompositeProvider;
    failure_point: string;
  };
  warnings: string[];
  limitations: string[];
  weights?: Record<string, number>;
}

export const buildCompositeEnvelope = (
  assembly: CompositeAssembly,
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  const provider_status = assembly.outcomes.map((o) => {
    const entry: Record<string, unknown> = { provider: o.provider, ok: o.ok };
    if (!o.ok && o.error) entry.error = o.error;
    return entry;
  });

  if (assembly.core_failure) {
    const partial: Record<string, unknown> = {};
    for (const o of assembly.outcomes) {
      if (o.ok) partial[o.key] = o.value;
    }
    return {
      source_urls: assembly.source_urls,
      provider_status,
      warnings: [
        ...assembly.warnings,
        `core ${assembly.core_failure.key} failed — returning partial_data with failure_point=${assembly.core_failure.failure_point}`,
      ],
      partial_data: partial,
      failure_point: assembly.core_failure.failure_point,
      ...payload,
    };
  }

  const weights = assembly.weights ?? {};
  let weightedOk = 0;
  let weightedTotal = 0;
  for (const o of assembly.outcomes) {
    const w = weights[o.key] ?? 1;
    weightedTotal += w;
    if (o.ok) weightedOk += w;
  }
  const missingFields = assembly.outcomes.filter((o) => !o.ok).map((o) => o.key);
  const confidence = deriveConfidence({
    ok_count: weightedOk,
    total_count: weightedTotal,
    missing_fields_count: missingFields.length,
  });
  return {
    source_urls: assembly.source_urls,
    provider_status,
    warnings: assembly.warnings,
    data_quality: {
      confidence,
      missing_fields: missingFields,
      limitations: assembly.limitations,
    },
    ...payload,
  };
};

export const outcomeFromResult = (
  key: string,
  provider: CompositeProvider,
  result:
    | { ok: true; value: unknown }
    | { ok: false; error: { toJSON: () => SubCallOutcome["error"] } },
): SubCallOutcome => {
  if (result.ok) {
    return { key, provider, ok: true, value: result.value };
  }
  return {
    key,
    provider,
    ok: false,
    error: result.error.toJSON(),
  };
};

export const outcomeFromSettled = (
  key: string,
  provider: CompositeProvider,
  settled: PromiseSettledResult<unknown>,
): SubCallOutcome => {
  if (isSettledOk(settled)) {
    const v = settled.value;
    // Defensive: a task that returns a Result-shape {ok:false, error} or just an error-like
    // payload should be treated as a failed outcome, not a success. Without this, the composite
    // envelope inflates data_quality.confidence because the sub-call looks like it succeeded.
    if (v && typeof v === "object") {
      const obj = v as { ok?: unknown; error?: SubCallOutcome["error"] };
      const isExplicitFailure = obj.ok === false;
      const hasError = Boolean(obj.error);
      if (isExplicitFailure || hasError) {
        return {
          key,
          provider,
          ok: false,
          error:
            obj.error ?? {
              tool: key,
              provider,
              reason: "Sub-call returned ok=false without an error payload.",
              retryable: false,
              recommended_action: "Inspect the sub-call output for failure context.",
            },
        };
      }
    }
    return { key, provider, ok: true, value: settled.value };
  }
  const reason = settled.reason;
  const errMsg = reason instanceof Error ? reason.message : String(reason);
  return {
    key,
    provider,
    ok: false,
    error: {
      tool: key,
      provider,
      reason: errMsg.slice(0, 300),
      retryable: false,
      recommended_action: "Check provider status and retry the composite.",
    },
  };
};
