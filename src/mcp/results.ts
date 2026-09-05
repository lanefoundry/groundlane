import type { CallToolResult } from "@modelcontextprotocol/server";

export type StructuredToolResult<T> =
  CallToolResult & {
    structuredContent: T;
  };

function legacyJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Structured content must be JSON-serializable");
  return encoded;
}

export function structuredToolResult<T>(
  value: T,
  legacyText: string = legacyJson(value),
): StructuredToolResult<T> {
  return {
    structuredContent: value,
    content: [{ type: "text", text: legacyText }],
  };
}

export function structuredToolError<T>(
  value: T,
  legacyText: string = legacyJson(value),
): StructuredToolResult<T> {
  return {
    ...structuredToolResult(value, legacyText),
    isError: true,
  };
}
