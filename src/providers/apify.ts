import { ApifyClient } from "apify-client";
import pLimit from "p-limit";
import { loadConfig } from "../config.js";
import { PotterError } from "../errors.js";

const PROVIDER = "apify" as const;
const MAX_BACKOFF_MS = 30_000;

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: PotterError };

export interface RunActorOptions {
  tool: string;
  actorId: string;
  input: Record<string, unknown>;
  timeoutSeconds?: number;
  resultLimit?: number;
}

export interface RunActorSuccess<T = unknown> {
  items: T[];
  run_id: string;
  status: string;
  usage_total_usd: number | null;
  dataset_id: string;
}

const retryableStatus = (status: number | undefined): boolean =>
  status === 429 || status === 502 || status === 503 || status === 504;

const TERMINAL_SUCCESS = new Set(["SUCCEEDED"]);
const TERMINAL_RETRYABLE = new Set(["FAILED", "TIMED-OUT"]);
const TERMINAL_NON_RETRYABLE = new Set(["ABORTED"]);

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);

const extractStatus = (err: unknown): number | undefined => {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as {
    statusCode?: number;
    status?: number;
    response?: { status?: number };
  };
  return e.statusCode ?? e.status ?? e.response?.status;
};

const toPotterError = (tool: string, err: unknown): PotterError => {
  if (err instanceof PotterError) return err;
  const status = extractStatus(err);
  return new PotterError({
    tool,
    provider: PROVIDER,
    reason: messageOf(err),
    retryable: retryableStatus(status),
    status_code: status,
    recommended_action:
      status === 401 || status === 403
        ? "Check POTTER_APIFY_TOKEN — current token was rejected by Apify."
        : status === 429
          ? "Apify rate-limited this run. Retry later or lower POTTER_CONCURRENCY_LIMIT."
          : "Check Apify console for the run; the actor may be offline or your account may lack access.",
  });
};

class ApifyProvider {
  private client: ApifyClient | null = null;
  private readonly limit = pLimit(loadConfig().concurrencyLimit);

  private getClient(tool: string): ApifyClient {
    if (this.client) return this.client;
    const cfg = loadConfig();
    if (!cfg.apifyToken) {
      throw new PotterError({
        tool,
        provider: PROVIDER,
        reason: "POTTER_APIFY_TOKEN is not set.",
        retryable: false,
        recommended_action:
          "Add POTTER_APIFY_TOKEN to .env (get one at https://console.apify.com/settings/api) and restart Potter.",
      });
    }
    this.client = new ApifyClient({ token: cfg.apifyToken });
    return this.client;
  }

  private async withRetries<T>(
    tool: string,
    op: () => Promise<T>,
    isRetryable: (err: unknown) => boolean = (err) => {
      if (err instanceof PotterError) return err.retryable;
      return retryableStatus(extractStatus(err));
    },
  ): Promise<T> {
    const cfg = loadConfig();
    const maxAttempts = cfg.maxRetries + 1;
    let attempt = 0;
    let delay = 500;
    let cumulativeWait = 0;
    while (true) {
      try {
        return await op();
      } catch (err) {
        attempt += 1;
        if (attempt >= maxAttempts || !isRetryable(err)) {
          throw toPotterError(tool, err);
        }
        const jitter = Math.random() * 250;
        const nextWait = Math.min(delay + jitter, MAX_BACKOFF_MS - cumulativeWait);
        if (nextWait <= 0) throw toPotterError(tool, err);
        cumulativeWait += nextWait;
        await new Promise((resolve) => setTimeout(resolve, nextWait));
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async runActor<T = unknown>(
    options: RunActorOptions,
  ): Promise<Result<RunActorSuccess<T>>> {
    const { tool, actorId, input, timeoutSeconds, resultLimit } = options;
    return this.limit(async () => {
      try {
        const cfg = loadConfig();
        const timeout = timeoutSeconds ?? Math.ceil(cfg.providerTimeoutMs / 1000);
        const run = await this.withRetries(tool, async () => {
          const client = this.getClient(tool);
          const started = await client.actor(actorId).call(input, {
            timeout,
            waitSecs: timeout,
          });
          if (TERMINAL_SUCCESS.has(started.status)) return started;
          const retryable = TERMINAL_RETRYABLE.has(started.status);
          if (TERMINAL_NON_RETRYABLE.has(started.status) || retryable) {
            throw new PotterError({
              tool,
              provider: PROVIDER,
              reason: `Apify run finished with status ${started.status}`,
              retryable,
              recommended_action: `See Apify console for run ${started.id}.`,
            });
          }
          throw new PotterError({
            tool,
            provider: PROVIDER,
            reason: `Apify run exited waitSecs with non-terminal status ${started.status}`,
            retryable: true,
            recommended_action: `Run ${started.id} did not finish within ${timeout}s. Try again or raise POTTER_PROVIDER_TIMEOUT_MS.`,
          });
        });
        const dataset = await this.withRetries(
          tool,
          async () =>
            this.getClient(tool)
              .dataset(run.defaultDatasetId)
              .listItems(resultLimit !== undefined ? { limit: resultLimit } : undefined),
          (err) => retryableStatus(extractStatus(err)),
        );
        return {
          ok: true as const,
          value: {
            items: dataset.items as T[],
            run_id: run.id,
            status: run.status,
            usage_total_usd:
              typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null,
            dataset_id: run.defaultDatasetId,
          },
        };
      } catch (err) {
        return { ok: false as const, error: toPotterError(tool, err) };
      }
    });
  }
}

let instance: ApifyProvider | null = null;

export const getApify = (): ApifyProvider => {
  if (instance === null) instance = new ApifyProvider();
  return instance;
};
