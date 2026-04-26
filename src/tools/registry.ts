import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";
import { z } from "zod";
import { PotterError, errorToContent } from "../errors.js";
import { byteSize, safeStringify, truncateJson } from "../truncation.js";
import { loadConfig } from "../config.js";

// _truncation envelope wrapper costs ~150-200 bytes; reserve headroom so adding it
// after a max-budget truncation doesn't push the final payload over cap.
const TRUNCATION_ENVELOPE_HEADROOM = 250;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface ToolRegistrationInput<T> {
  name: string;
  description: string;
  argsSchema: ZodType<T>;
  run: (args: T) => Promise<unknown>;
}

const sanitizeJsonSchema = (schema: unknown): Record<string, unknown> => {
  if (typeof schema !== "object" || schema === null) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  delete copy["$schema"];
  if (!("additionalProperties" in copy)) {
    copy.additionalProperties = false;
  }
  return copy;
};

export const toolSuccess = (payload: unknown): CallToolResult => {
  const cfg = loadConfig();
  let wrapped = truncateJson(payload, cfg.maxResponseBytes);
  if (wrapped.truncated) {
    const reservedBudget = Math.max(cfg.maxResponseBytes - TRUNCATION_ENVELOPE_HEADROOM, 256);
    if (wrapped.final_bytes > reservedBudget) {
      wrapped = truncateJson(payload, reservedBudget);
    }
  }
  const envelope = wrapped.truncated
    ? { ...((wrapped.data ?? {}) as object), _truncation: { notes: wrapped.notes, original_bytes: wrapped.original_bytes, final_bytes: wrapped.final_bytes } }
    : wrapped.data;
  // safeStringify (not raw JSON.stringify) so a circular ref or BigInt in the wrapped
  // envelope can never convert a successful tool result into a runtime serialization error.
  let text = typeof envelope === "string" ? envelope : safeStringify(envelope, 2);
  if (Buffer.byteLength(text, "utf8") > cfg.maxResponseBytes) {
    const fallback = {
      _truncated: true,
      _note: "response_exceeded_cap_after_envelope_assembly",
      original_bytes: byteSize(payload),
    };
    text = safeStringify(fallback, 2);
  }
  // Ultimate hard cap: if even the fallback marker overshoots a pathologically small
  // configured cap, byte-slice the text. May produce invalid JSON but respects the cap.
  if (Buffer.byteLength(text, "utf8") > cfg.maxResponseBytes) {
    text = Buffer.from(text, "utf8").subarray(0, cfg.maxResponseBytes).toString("utf8");
  }
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
};

export const defineTool = <T>(input: ToolRegistrationInput<T>): ToolDefinition => {
  const inputSchema = sanitizeJsonSchema(
    z.toJSONSchema(input.argsSchema as ZodType<unknown>),
  );
  return {
    name: input.name,
    description: input.description,
    inputSchema,
    handler: async (rawArgs) => {
      let parsed: T;
      try {
        const result = input.argsSchema.safeParse(rawArgs ?? {});
        if (!result.success) {
          throw new PotterError({
            tool: input.name,
            provider: "potter",
            reason: `Invalid arguments: ${result.error.message.slice(0, 300)}`,
            retryable: false,
            recommended_action: "Fix the argument shape and retry. See inputSchema.",
          });
        }
        parsed = result.data;
      } catch (err) {
        return errorToContent(err, input.name);
      }
      const cfg = loadConfig();
      if (cfg.qaStubMode) {
        return toolSuccess({
          qa_stub: true,
          tool: input.name,
          args: parsed,
          note: "Potter is running in QA_STUB_MODE; no providers were called.",
        });
      }
      try {
        const value = await input.run(parsed);
        return toolSuccess(value);
      } catch (err) {
        return errorToContent(err, input.name);
      }
    },
  };
};
