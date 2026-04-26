import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, "..");
loadDotenv({ path: path.join(packageRoot, ".env"), quiet: true });

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const numberFromEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boolFromEnv = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.toLowerCase().trim();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return fallback;
};

const optionalString = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
};

const logLevelFromEnv = (raw: string | undefined): z.infer<typeof LogLevelSchema> => {
  const parsed = LogLevelSchema.safeParse(raw);
  return parsed.success ? parsed.data : "info";
};

export const ConfigSchema = z.object({
  apifyToken: z.string().optional(),
  firecrawlApiKey: z.string().optional(),
  browserbaseApiKey: z.string().optional(),
  browserbaseProjectId: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),

  maxResponseBytes: z.number().int().positive(),
  logLevel: LogLevelSchema,
  providerTimeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0),
  concurrencyLimit: z.number().int().positive(),
  browserSessionTimeoutMinutes: z.number().int().positive(),
  browserActMaxSteps: z.number().int().positive(),
  browserActTimeoutSeconds: z.number().int().positive(),

  apifyLinkedinProfileActor: z.string().optional(),
  apifyLinkedinCompanyActor: z.string().optional(),
  apifyLinkedinPostsActor: z.string().optional(),
  apifyLinkedinEmployeesActorInternal: z.string().optional(),

  enableExperimentalBrowserAct: z.boolean(),
  allowPrivateUrls: z.boolean(),
  enablePing: z.boolean(),
  qaStubMode: z.boolean(),
});

export type PotterConfig = z.infer<typeof ConfigSchema>;

let cached: PotterConfig | null = null;

export const loadConfig = (): PotterConfig => {
  if (cached !== null) return cached;
  cached = ConfigSchema.parse({
    apifyToken: optionalString(process.env.POTTER_APIFY_TOKEN),
    firecrawlApiKey: optionalString(process.env.POTTER_FIRECRAWL_API_KEY),
    browserbaseApiKey: optionalString(process.env.POTTER_BROWSERBASE_API_KEY),
    browserbaseProjectId: optionalString(process.env.POTTER_BROWSERBASE_PROJECT_ID),
    anthropicApiKey: optionalString(process.env.POTTER_ANTHROPIC_API_KEY),
    openaiApiKey: optionalString(process.env.POTTER_OPENAI_API_KEY),

    maxResponseBytes: numberFromEnv(process.env.POTTER_MAX_RESPONSE_BYTES, 20000),
    logLevel: logLevelFromEnv(process.env.POTTER_LOG_LEVEL),
    providerTimeoutMs: numberFromEnv(process.env.POTTER_PROVIDER_TIMEOUT_MS, 60000),
    maxRetries: numberFromEnv(process.env.POTTER_MAX_RETRIES, 3),
    concurrencyLimit: numberFromEnv(process.env.POTTER_CONCURRENCY_LIMIT, 5),
    browserSessionTimeoutMinutes: numberFromEnv(process.env.POTTER_BROWSER_SESSION_TIMEOUT_MINUTES, 10),
    browserActMaxSteps: numberFromEnv(process.env.POTTER_BROWSER_ACT_MAX_STEPS, 10),
    browserActTimeoutSeconds: numberFromEnv(process.env.POTTER_BROWSER_ACT_TIMEOUT_SECONDS, 120),

    apifyLinkedinProfileActor: optionalString(process.env.POTTER_APIFY_LINKEDIN_PROFILE_ACTOR),
    apifyLinkedinCompanyActor: optionalString(process.env.POTTER_APIFY_LINKEDIN_COMPANY_ACTOR),
    apifyLinkedinPostsActor: optionalString(process.env.POTTER_APIFY_LINKEDIN_POSTS_ACTOR),
    apifyLinkedinEmployeesActorInternal: optionalString(
      process.env.POTTER_APIFY_LINKEDIN_EMPLOYEES_ACTOR_INTERNAL,
    ),

    enableExperimentalBrowserAct: boolFromEnv(
      process.env.POTTER_ENABLE_EXPERIMENTAL_BROWSER_ACT,
      true,
    ),
    allowPrivateUrls: boolFromEnv(process.env.POTTER_ALLOW_PRIVATE_URLS, false),
    enablePing: boolFromEnv(process.env.POTTER_ENABLE_PING, false),
    qaStubMode: boolFromEnv(process.env.POTTER_QA_STUB_MODE, false),
  });
  return cached;
};
