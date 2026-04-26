import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";
import { z } from "zod";
import { PotterError, errorToContent } from "../errors.js";
import { truncateJson } from "../truncation.js";
import { loadConfig } from "../config.js";

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
  const wrapped = truncateJson(payload, cfg.maxResponseBytes);
  const envelope = wrapped.truncated
    ? { ...((wrapped.data ?? {}) as object), _truncation: { notes: wrapped.notes, original_bytes: wrapped.original_bytes, final_bytes: wrapped.final_bytes } }
    : wrapped.data;
  return {
    content: [
      {
        type: "text",
        text: typeof envelope === "string" ? envelope : JSON.stringify(envelope, null, 2),
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
