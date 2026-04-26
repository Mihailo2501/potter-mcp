import { loadConfig } from "./config.js";
import { redactSecrets } from "./logging.js";
import { truncateJson } from "./truncation.js";

const sanitizeReason = (reason: string): string => redactSecrets(reason);

export type PotterProvider =
  | "potter"
  | "apify"
  | "firecrawl"
  | "stagehand"
  | "browserbase"
  | "anthropic"
  | "openai";

export interface PotterErrorShape {
  tool: string;
  provider: PotterProvider | string;
  reason: string;
  retryable: boolean;
  status_code?: number;
  recommended_action: string;
}

export class PotterError extends Error {
  readonly tool: string;
  readonly provider: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly status_code: number | undefined;
  readonly recommended_action: string;

  constructor(shape: PotterErrorShape) {
    const safeReason = sanitizeReason(shape.reason);
    const safeAction = sanitizeReason(shape.recommended_action);
    super(safeReason);
    this.name = "PotterError";
    this.tool = shape.tool;
    this.provider = shape.provider;
    this.reason = safeReason;
    this.retryable = shape.retryable;
    this.status_code = shape.status_code;
    this.recommended_action = safeAction;
  }

  toJSON(): PotterErrorShape {
    const base: PotterErrorShape = {
      tool: this.tool,
      provider: this.provider,
      reason: this.reason,
      retryable: this.retryable,
      recommended_action: this.recommended_action,
    };
    if (this.status_code !== undefined) {
      base.status_code = this.status_code;
    }
    return base;
  }
}

export interface ToolErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown;
}

export const errorToContent = (err: unknown, tool: string): ToolErrorResult => {
  const potterErr =
    err instanceof PotterError
      ? err
      : new PotterError({
          tool,
          provider: "potter",
          reason: redactSecrets(err instanceof Error ? err.message : String(err)),
          retryable: false,
          recommended_action:
            "Check Potter stderr logs for the full stack trace and file an issue if reproducible.",
        });
  const cfg = loadConfig();
  const truncated = truncateJson({ error: potterErr.toJSON() }, cfg.maxResponseBytes);
  const payload = truncated.truncated
    ? { ...((truncated.data ?? {}) as object), _truncation: { notes: truncated.notes, original_bytes: truncated.original_bytes, final_bytes: truncated.final_bytes } }
    : truncated.data;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
};
