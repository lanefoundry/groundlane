import {
  classifyInboundRequest,
  type InboundLadderRejection,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";

const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";
const BASE64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const EDGE_HEADER_REJECTION_CELLS = new Set([
  "header-body-version-mismatch",
  "initialize-with-modern-header",
  "method-header-mismatch",
  "modern-header-without-claim",
  "notification-header-body-version-mismatch",
  "notification-method-header-mismatch",
]);

export interface McpRoutingHeaders {
  readonly protocolVersion?: string | undefined;
  readonly method?: string | undefined;
  readonly name?: string | undefined;
}

function base64ToUtf8(value: string): string | undefined {
  if (!BASE64_CANONICAL.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.codePointAt(index) ?? 0;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeMcpHeaderValue(value: string): string | undefined {
  const normalized = value.trim();
  if (
    !normalized.startsWith(BASE64_SENTINEL_PREFIX) ||
    !normalized.endsWith(BASE64_SENTINEL_SUFFIX)
  ) {
    return normalized;
  }
  return base64ToUtf8(
    normalized.slice(BASE64_SENTINEL_PREFIX.length, -BASE64_SENTINEL_SUFFIX.length),
  );
}

function headerMismatch(
  cell: string,
  headerState: "missing" | "present" | "invalid",
  detail: string,
): InboundLadderRejection {
  return {
    kind: "reject",
    rung: "standard-header-validation",
    cell,
    httpStatus: 400,
    code: -32020,
    // Never reflect header/body values here. Mcp-Name and JSON-RPC params are
    // attacker-controlled and can contain credentials or provider payloads.
    message: `Bad Request: the request headers and body disagree: ${detail}`,
    data: { mismatch: { header: headerState, body: "present" } },
    settled: true,
  };
}

/**
 * Worker-edge validation for the standard headers used for early policy and
 * metering. The Container's SDK handler independently repeats full body,
 * envelope, header, capability, and tool-parameter validation before dispatch.
 */
export function validateMcpRoutingHeaders(
  httpMethod: string,
  headers: McpRoutingHeaders,
  body: unknown,
): InboundLadderRejection | undefined {
  const classified = classifyInboundRequest({
    httpMethod,
    ...(headers.protocolVersion === undefined
      ? {}
      : { protocolVersionHeader: headers.protocolVersion }),
    ...(headers.method === undefined ? {} : { mcpMethodHeader: headers.method }),
    ...(headers.name === undefined ? {} : { mcpNameHeader: headers.name }),
    body,
  });
  if (classified.kind === "reject") {
    return EDGE_HEADER_REJECTION_CELLS.has(classified.cell)
      ? headerMismatch(
          classified.cell,
          headers.protocolVersion === undefined && headers.method === undefined
            ? "missing"
            : "present",
          "the standard routing headers do not match the JSON-RPC envelope",
        )
      : undefined;
  }
  if (classified.kind !== "modern" || classified.messageKind !== "request") {
    return undefined;
  }

  const bodyMethod = classified.message.method;
  if (headers.protocolVersion === undefined) {
    return headerMismatch(
      "protocol-version-header-missing",
      "missing",
      "the request envelope names a modern protocol version but the required MCP-Protocol-Version header is absent",
    );
  }
  if (headers.method === undefined) {
    return headerMismatch(
      "method-header-missing",
      "missing",
      "the body names a method but the required Mcp-Method header is absent",
    );
  }

  const sourceField = bodyMethod === "tools/call" || bodyMethod === "prompts/get"
    ? "name"
    : bodyMethod === "resources/read"
      ? "uri"
      : bodyMethod.startsWith("tasks/")
        ? "taskId"
      : undefined;
  if (sourceField === undefined) return undefined;
  const params: unknown = classified.message.params;
  if (typeof params !== "object" || params === null) return undefined;
  const paramsRecord = params as Record<string, unknown>;
  const bodyValue: unknown = sourceField in paramsRecord ? paramsRecord[sourceField] : undefined;
  if (typeof bodyValue !== "string") return undefined;
  if (headers.name === undefined) {
    return headerMismatch(
      "name-header-missing",
      "missing",
      `the body carries params.${sourceField} but the required Mcp-Name header is absent`,
    );
  }
  const decoded = decodeMcpHeaderValue(headers.name);
  if (decoded === undefined) {
    return headerMismatch(
      "name-header-invalid-encoding",
      "invalid",
      "the Mcp-Name header carries an invalid Base64 sentinel value",
    );
  }
  if (decoded !== bodyValue) {
    return headerMismatch(
      "name-header-mismatch",
      "present",
      `the body params.${sourceField} and Mcp-Name header name different targets`,
    );
  }
  return undefined;
}

/**
 * SEP-2575 carve-out shared by the Worker edge and the Container handler.
 * When routing headers are coherent but the envelope lacks `_meta` entirely
 * or its `_meta` omits the required protocol version, the request is
 * Invalid params (-32602), not a header/body routing disagreement (-32020).
 * Returns the missing field list, or undefined when this carve-out does not
 * apply. Bodies without an id (notifications) and requests sent without a
 * protocol-version header are left to the existing ladder.
 */
export function missingRequestMetaVersion(
  headers: McpRoutingHeaders,
  body: unknown,
): string[] | undefined {
  if (headers.protocolVersion === undefined || headers.protocolVersion.length === 0) {
    return undefined;
  }
  if (typeof body !== "object" || body === null || !("id" in body)) return undefined;
  if (
    "method" in body &&
    (body.method === "initialize" || body.method === "notifications/initialized")
  ) {
    // Legacy handshake stays on the routing ladder even with modern headers.
    return undefined;
  }
  const params: unknown =
    "params" in body ? (body as Record<string, unknown>).params : undefined;
  if (typeof params !== "object" || params === null || !("_meta" in params)) {
    return ["_meta"];
  }
  const meta = (params as Record<string, unknown>)._meta;
  if (typeof meta !== "object" || meta === null) return ["_meta"];
  const version = (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
  if (typeof version !== "string" || version.length === 0) {
    return [PROTOCOL_VERSION_META_KEY];
  }
  return undefined;
}

export function mcpInvalidMetaResponse(
  requestId: string,
  body: unknown,
  missing: readonly string[],
): Response {
  let id: string | number | null = null;
  if (typeof body === "object" && body !== null && "id" in body) {
    const candidate: unknown = (body as Record<string, unknown>).id;
    if (typeof candidate === "string" || typeof candidate === "number") id = candidate;
  }
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: "Bad Request: the request _meta is missing required MCP fields",
        data: { missing: [...missing] },
      },
    },
    { status: 400, headers: { "x-request-id": requestId } },
  );
}

export function mcpRoutingRejectionResponse(
  rejection: InboundLadderRejection,
  requestId: string,
  body: unknown,
): Response {
  let id: string | number | null = null;
  if (typeof body === "object" && body !== null && "id" in body) {
    const candidate: unknown = body.id;
    if (typeof candidate === "string" || typeof candidate === "number") id = candidate;
  }
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code: rejection.code,
        message: rejection.message,
        ...(rejection.data === undefined ? {} : { data: rejection.data }),
      },
    },
    { status: rejection.httpStatus, headers: { "x-request-id": requestId } },
  );
}

export function mcpBodyTooLargeResponse(requestId: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: ProtocolErrorCode.InvalidRequest,
        message: "MCP request body exceeds the 1 MiB limit",
      },
    },
    { status: 413, headers: { "x-request-id": requestId } },
  );
}
