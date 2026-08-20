import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type StructuredToolResult<T extends Record<string, unknown>> =
  CallToolResult & {
    structuredContent: T;
  };

function legacyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export function structuredToolResult<T extends Record<string, unknown>>(
  value: T,
  legacyText: string = legacyJson(value),
): StructuredToolResult<T> {
  return {
    structuredContent: value,
    content: [{ type: "text", text: legacyText }],
  };
}

export function structuredToolError<T extends Record<string, unknown>>(
  value: T,
  legacyText: string = legacyJson(value),
): StructuredToolResult<T> {
  return {
    ...structuredToolResult(value, legacyText),
    isError: true,
  };
}
