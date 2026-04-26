import { loadConfig } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SECRET_CONFIG_KEYS = [
  "apifyToken",
  "firecrawlApiKey",
  "browserbaseApiKey",
  "anthropicApiKey",
  "openaiApiKey",
] as const;

const REDACTION_MIN_LENGTH = 4;

let cachedSecrets: string[] | null = null;

const getSecrets = (): string[] => {
  if (cachedSecrets !== null) return cachedSecrets;
  try {
    const cfg = loadConfig();
    const secrets: string[] = [];
    for (const key of SECRET_CONFIG_KEYS) {
      const value = cfg[key];
      if (typeof value === "string" && value.length >= REDACTION_MIN_LENGTH) {
        secrets.push(value);
      }
    }
    cachedSecrets = secrets;
  } catch {
    cachedSecrets = [];
  }
  return cachedSecrets;
};

export const redactSecrets = (input: string): string => {
  if (input === "") return input;
  const secrets = getSecrets();
  if (secrets.length === 0) return input;
  let out = input;
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join("***");
    }
  }
  return out;
};

export type Logger = (
  level: LogLevel,
  msg: string,
  extra?: Record<string, unknown>,
) => void;

export const makeLogger = (threshold: LogLevel): Logger => {
  const minRank = LOG_LEVEL_ORDER[threshold];
  return (level, msg, extra) => {
    if (LOG_LEVEL_ORDER[level] < minRank) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(extra ?? {}),
    });
    process.stderr.write(`${redactSecrets(line)}\n`);
  };
};
