import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  createRequestStateCodec,
  isLegacyRequest,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import { ZodError } from "zod";

import type { McpRegistryFactory } from "./registry.js";
import type { McpRequestContext } from "./registry.js";
import { GroundlaneError } from "../core/errors.js";
import { missingRequestMetaVersion, validateMcpRoutingHeaders } from "../core/mcp-routing.js";

export const MCP_SERVER_INFO = {
  name: "groundlane",
  version: "0.1.0",
} as const;

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";

const MCP_PRIVATE_NO_STORE_CACHE_HINTS = {
  "prompts/list": { ttlMs: 0, cacheScope: "private" },
  "resources/list": { ttlMs: 0, cacheScope: "private" },
  "resources/read": { ttlMs: 0, cacheScope: "private" },
  "resources/templates/list": { ttlMs: 0, cacheScope: "private" },
  "server/discover": { ttlMs: 0, cacheScope: "private" },
  "tools/list": { ttlMs: 0, cacheScope: "private" },
} as const;

export type McpProtocolMode = "legacy-only" | "dual" | "modern-only";

export interface McpHttpHandlerOptions {
  readonly protocolMode?: McpProtocolMode;
  readonly requestStateSecret?: string | undefined;
}

const MCP_REQUEST_STATE_TTL_SECONDS = 300;
const MCP_REQUEST_STATE_MAX_PAYLOAD_BYTES = 8 * 1024;
const MCP_REQUEST_STATE_MAX_TOKEN_CHARS = 16 * 1024;
const MCP_TASK_EXTENSION_METHODS = new Set([
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
]);

function isTaskExtensionCandidate(method: string, body: unknown): boolean {
  if (MCP_TASK_EXTENSION_METHODS.has(method)) return true;
  if (method !== "tools/call") return false;
  const params = requestParams(body);
  return typeof params === "object" && params !== null && "name" in params &&
    params.name === "web_research_start";
}

export const MCP_SERVER_INSTRUCTIONS =
  "Groundlane is the required web research and public-page retrieval layer. " +
  "Use web_search to find candidate sources, web_fetch to read a page, and " +
  "web_extract for deterministic selector or bounded pattern extraction. Use parse when a " +
  "caller needs document, metadata, link, media, or table structures. These tools may be " +
  "deferred in clients; inspect the complete callable tool inventory before " +
  "reporting Groundlane unavailable. Do not substitute legacy fetch or browser " +
  "scraping tools when Groundlane is required.";

export function parseMcpProtocolMode(value: string | undefined): McpProtocolMode {
  if (value === undefined || value.length === 0 || value === "legacy-only") {
    return "legacy-only";
  }
  if (value === "dual" || value === "modern-only") return value;
  throw new Error(
    "GROUNDLANE_MCP_PROTOCOL_MODE must be legacy-only, dual, or modern-only",
  );
}

function jsonRpcId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null || !("id" in body)) return null;
  const id: unknown = body.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function requestMethod(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("method" in body)) return undefined;
  return typeof body.method === "string" ? body.method : undefined;
}

function requestParams(body: unknown): unknown {
  return typeof body === "object" && body !== null && "params" in body
    ? body.params
    : undefined;
}

const META_CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/**
 * SEP-2575 request _meta contract (alpha conformance RequestMetaInvalid).
 * The missing-protocol-version carve-out runs before routing-header
 * validation via the shared core helper; this covers the remaining
 * required field (clientCapabilities), which always passes the header
 * ladder. clientInfo remains optional, and an entirely absent _meta keeps
 * existing SDK behavior.
 */
function missingMetaCapabilities(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("id" in body)) return false;
  const params = requestParams(body);
  if (typeof params !== "object" || params === null || !("_meta" in params)) return false;
  const meta = (params as Record<string, unknown>)._meta;
  if (typeof meta !== "object" || meta === null) return false;
  const capabilities = (meta as Record<string, unknown>)[META_CLIENT_CAPABILITIES_KEY];
  return typeof capabilities !== "object" || capabilities === null ||
    Array.isArray(capabilities);
}

function protocolErrorData(error: ProtocolError): unknown {
  return "data" in error ? error.data : undefined;
}

function writeModernExtensionError(response: Response, body: unknown, error: unknown): void {
  const protocol = error instanceof ProtocolError;
  const invalidInput = error instanceof ZodError || (error instanceof GroundlaneError &&
    (error.code === "INVALID_INPUT" || error.code === "DEADLINE_EXCEEDED"));
  const code = protocol
    ? error.code
    : invalidInput
      ? ProtocolErrorCode.InvalidParams
      : ProtocolErrorCode.InternalError;
  const message = protocol
    ? error.message
    : invalidInput
      ? error instanceof GroundlaneError
        ? error.message
        : "Invalid task request"
      : "Task operation failed";
  const data = protocol ? protocolErrorData(error) : undefined;
  response.status(protocol || invalidInput ? 400 : 500).json({
    jsonrpc: "2.0",
    id: jsonRpcId(body),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function rejectModernRequest(response: Response, body: unknown): void {
  response.status(400).json({
    jsonrpc: "2.0",
    id: jsonRpcId(body),
    error: {
      code: ProtocolErrorCode.UnsupportedProtocolVersion,
      message: "Unsupported protocol version: modern MCP serving is disabled",
      data: {
        requested: MCP_MODERN_PROTOCOL_VERSION,
        supported: ["2025-11-25"],
      },
    },
  });
}

function requestContext(response: Response): McpRequestContext | undefined {
  const contextValue: unknown = response.locals.mcpRequestContext;
  return typeof contextValue === "object" && contextValue !== null
    ? (contextValue as McpRequestContext)
    : undefined;
}

async function serveLegacyRequest(
  request: Request,
  response: Response,
  registryFactory: McpRegistryFactory,
  context: McpRequestContext | undefined,
): Promise<void> {
  const registry = await registryFactory(context);
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: MCP_SERVER_INSTRUCTIONS,
  });
  // Omitting the session generator selects the frozen SDK v2-hosted 2025
  // stateless compatibility transport.
  const transport = new NodeStreamableHTTPServerTransport();

  try {
    await registry.registerAll(server);
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body as unknown);
  } finally {
    if (server.isConnected()) {
      await server.close();
    }
  }
}

async function serveModernRequest(
  request: Request,
  response: Response,
  registryFactory: McpRegistryFactory,
  context: McpRequestContext | undefined,
  requestStateSecret: string | undefined,
): Promise<void> {
  const handler = createMcpHandler(
    async () => {
      const owner = context === undefined
        ? undefined
        : {
            ownerId: context.principal.principalId,
            credentialBinding: context.credentialBinding,
          };
      const requestStateCodec = requestStateSecret === undefined || owner === undefined
        ? undefined
        : createRequestStateCodec<Record<string, unknown>>({
            key: requestStateSecret,
            ttlSeconds: MCP_REQUEST_STATE_TTL_SECONDS,
            bind: (serverContext) =>
              `${owner.ownerId}\0${owner.credentialBinding}\0${serverContext.mcpReq.method}`,
          });
      let requestContext = context;
      if (context !== undefined && requestStateCodec !== undefined) {
        requestContext = {
          ...context,
          requestState: {
            mint: async <T extends Record<string, unknown>>(
              state: T,
              serverContext: ServerContext,
            ) => {
              const payloadBytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
              if (payloadBytes > MCP_REQUEST_STATE_MAX_PAYLOAD_BYTES) {
                throw new RangeError("MCP request-state payload exceeds 8192 bytes");
              }
              return requestStateCodec.mint(state, serverContext);
            },
          },
        };
      }
      const registry = await registryFactory(requestContext);
      const server = new McpServer(MCP_SERVER_INFO, {
        cacheHints: MCP_PRIVATE_NO_STORE_CACHE_HINTS,
        inputRequired: { maxRounds: 3 },
        instructions: MCP_SERVER_INSTRUCTIONS,
        requestState: {
          verify: async (state, serverContext) => {
            if (requestStateCodec === undefined || owner === undefined) {
              throw new Error("MCP request-state verification is not configured");
            }
            if (state.length === 0 || state.length > MCP_REQUEST_STATE_MAX_TOKEN_CHARS) {
              throw new Error("invalid request state");
            }
            return requestStateCodec.verify(state, serverContext);
          },
        },
        supportedProtocolVersions: [MCP_MODERN_PROTOCOL_VERSION],
      });
      await registry.registerAll(server);
      return server;
    },
    {
      legacy: "reject",
      responseMode: "auto",
    },
  );

  try {
    await toNodeHandler(handler)(request, response, request.body as unknown);
  } finally {
    await handler.close();
  }
}

export function createMcpHttpHandler(
  registryFactory: McpRegistryFactory,
  options: McpHttpHandlerOptions = {},
): (request: Request, response: Response) => Promise<void> {
  const protocolMode = options.protocolMode ?? "legacy-only";
  const requestStateSecret = options.requestStateSecret === undefined ||
      options.requestStateSecret.length === 0
    ? undefined
    : options.requestStateSecret;
  if (
    requestStateSecret !== undefined &&
    new TextEncoder().encode(requestStateSecret).byteLength < 32
  ) {
    throw new Error("MCP request-state signing secret must be at least 32 bytes");
  }

  return async (request, response) => {
    const context = requestContext(response);
    const webRequest = await toWebRequest(request, request.body as unknown);
    const legacy = await isLegacyRequest(webRequest, request.body as unknown);

    if (legacy && protocolMode !== "modern-only") {
      await serveLegacyRequest(request, response, registryFactory, context);
      return;
    }

    if (!legacy && protocolMode === "legacy-only") {
      rejectModernRequest(response, request.body as unknown);
      return;
    }

    if (!legacy) {
      const routingHeaders = {
        protocolVersion: request.header("mcp-protocol-version"),
        method: request.header("mcp-method"),
        name: request.header("mcp-name"),
      };
      const missingMetaVersion = missingRequestMetaVersion(
        routingHeaders,
        request.body as unknown,
      );
      if (missingMetaVersion !== undefined) {
        response.status(400).json({
          jsonrpc: "2.0",
          id: jsonRpcId(request.body as unknown),
          error: {
            code: -32602,
            message: "Bad Request: the request _meta is missing required MCP fields",
            data: { missing: missingMetaVersion },
          },
        });
        return;
      }
      const rejected = validateMcpRoutingHeaders(
        request.method,
        routingHeaders,
        request.body as unknown,
      );
      if (rejected !== undefined) {
        response.status(rejected.httpStatus).json({
          jsonrpc: "2.0",
          id: jsonRpcId(request.body as unknown),
          error: {
            code: rejected.code,
            message: rejected.message,
            ...(rejected.data === undefined ? {} : { data: rejected.data }),
          },
        });
        return;
      }

      if (missingMetaCapabilities(request.body as unknown)) {
        response.status(400).json({
          jsonrpc: "2.0",
          id: jsonRpcId(request.body as unknown),
          error: {
            code: -32602,
            message: "Bad Request: the request _meta is missing required MCP fields",
            data: { missing: ["io.modelcontextprotocol/clientCapabilities"] },
          },
        });
        return;
      }

      const method = requestMethod(request.body as unknown);
      if (method !== undefined && isTaskExtensionCandidate(method, request.body as unknown)) {
        const registry = await registryFactory(context);
        try {
          const extensionResult = await registry.handleModernRequest(
            method,
            requestParams(request.body as unknown),
            request.body as unknown,
            webRequest.signal,
          );
          if (extensionResult !== undefined) {
            response.json({
              jsonrpc: "2.0",
              id: jsonRpcId(request.body as unknown),
              result: {
                ...extensionResult,
                _meta: {
                  ...(typeof extensionResult._meta === "object" &&
                    extensionResult._meta !== null
                    ? extensionResult._meta
                    : {}),
                  "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO,
                },
              },
            });
            return;
          }
        } catch (error) {
          writeModernExtensionError(response, request.body as unknown, error);
          return;
        }
      }
    }

    // The official strict handler owns both modern serving and the exact
    // unsupported-version response when modern-only mode receives legacy.
    await serveModernRequest(
      request,
      response,
      registryFactory,
      context,
      requestStateSecret,
    );
  };
}
