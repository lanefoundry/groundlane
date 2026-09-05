import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { timingSafeEqual } from "node:crypto";

import { CloudflareErrorSink, type ErrorLogSink } from "../core/error-log.js";
import { setErrorLogSink } from "../tools/common.js";
import { resolveWorkerAuthProfile } from "../worker/auth.js";
import { verifyContainerAuth } from "../worker/internal-context.js";
import { systemUtcClock, type ManagedClock } from "../worker/managed-tokens.js";
import {
  createMcpHttpHandler,
  parseMcpProtocolMode,
  type McpProtocolMode,
} from "../mcp/server.js";
import {
  createMcpRegistry,
  type McpRequestContext,
  type McpRegistryFactory,
} from "../mcp/registry.js";
import {
  decodeArtifactParseBridgeMetadata,
  INTERNAL_ARTIFACT_METADATA_HEADER,
  INTERNAL_ARTIFACT_PARSE_PATH,
  INTERNAL_ARTIFACT_PURPOSE,
} from "../mcp/artifact-bridge.js";
import { structuredToolError, structuredToolResult } from "../mcp/results.js";
import { GroundlaneError, toGroundlaneError } from "../core/errors.js";
import type { DocumentParseInput, ResolvedDocumentSource } from "../tools/document-parse.js";

const BODY_LIMIT = "1mb";

const nodeTimingSafeSubtle = {
  digest(
    algorithm: AlgorithmIdentifier,
    data: BufferSource,
  ): Promise<ArrayBuffer> {
    return crypto.subtle.digest(algorithm, data);
  },
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean {
    const leftBytes =
      left instanceof ArrayBuffer
        ? new Uint8Array(left)
        : new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes =
      right instanceof ArrayBuffer
        ? new Uint8Array(right)
        : new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return timingSafeEqual(leftBytes, rightBytes);
  },
};

export interface ContainerAppOptions {
  authToken?: string | undefined;
  authMode?: string | undefined;
  internalSigningSecret?: string | undefined;
  expectedAudience?: string | undefined;
  clock?: ManagedClock | undefined;
  registryFactory?: McpRegistryFactory | undefined;
  mcpProtocolMode?: McpProtocolMode | undefined;
  mcpRequestStateSecret?: string | undefined;
  parseResolvedDocument?: (
    input: DocumentParseInput,
    resolved: ResolvedDocumentSource,
    context: McpRequestContext,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /**
   * Analytics Engine dataset the container writes error events to. When
   * omitted, the container runs with the noop sink and nothing is recorded
   * server-side. Clients should still record their own view with
   * examples/groundlane-debug.ts.
   */
  errorLogWriter?: {
    writeDataPoint(event: { blobs?: readonly string[]; doubles?: readonly number[]; indexes?: readonly string[] }): void;
  } | undefined;
}

function asyncHandler(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
): RequestHandler {
  return (request, response, next): void => {
    handler(request, response, next).catch(next);
  };
}

function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const requestId = crypto.randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);
  next();
}

function requestId(response: Response): string {
  const value: unknown = response.locals.requestId;
  return typeof value === "string" ? value : crypto.randomUUID();
}

function errorBody(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({
    error: { code, message },
    requestId: requestId(response),
  });
}

function buildSink(options: ContainerAppOptions): ErrorLogSink {
  if (options.errorLogWriter === undefined) return { record: () => undefined };
  return new CloudflareErrorSink(options.errorLogWriter);
}

export function createContainerApp(options: ContainerAppOptions = {}): express.Express {
  setErrorLogSink(buildSink(options));
  const app = express();
  const authToken = options.authToken ?? process.env.GROUNDLANE_AUTH_TOKEN ?? "";
  const internalSigningSecret =
    options.internalSigningSecret ?? process.env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "";
  const authProfile = resolveWorkerAuthProfile({
    GROUNDLANE_AUTH_MODE: options.authMode ?? process.env.GROUNDLANE_AUTH_MODE,
    GROUNDLANE_INTERNAL_SIGNING_SECRET: internalSigningSecret,
  });
  const expectedAudience = options.expectedAudience ?? "groundlane-mcp-v2";
  const clock = options.clock ?? systemUtcClock();
  const registryFactory =
    options.registryFactory ?? (() => createMcpRegistry());
  const mcpProtocolMode = options.mcpProtocolMode ?? parseMcpProtocolMode(
    process.env.GROUNDLANE_MCP_PROTOCOL_MODE,
  );
  const handleMcp = createMcpHttpHandler(registryFactory, {
    protocolMode: mcpProtocolMode,
    requestStateSecret:
      options.mcpRequestStateSecret ?? process.env.GROUNDLANE_MCP_REQUEST_STATE_SECRET,
  });

  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: BODY_LIMIT, strict: true }));

  app.get("/healthz", (_request, response) => {
    response.json({
      status: "ok",
      service: "groundlane-container",
      requestId: requestId(response),
    });
  });

  app.get("/readyz", (_request, response) => {
    const ready = authProfile === "worker_internal_context"
      ? internalSigningSecret.length > 0
      : authToken.length > 0;
    if (!ready) {
      errorBody(
        response,
        503,
        "not_ready",
        "Container authentication is not configured",
      );
      return;
    }
    response.json({ status: "ready", requestId: requestId(response) });
  });

  app.post(
    INTERNAL_ARTIFACT_PARSE_PATH,
    express.raw({ type: "application/octet-stream", limit: "10mb" }),
    asyncHandler(async (request, response) => {
      if (authProfile !== "worker_internal_context" || options.parseResolvedDocument === undefined ||
          !(request.body instanceof Buffer)) {
        errorBody(response, 404, "not_found", "Route not found");
        return;
      }
      const bytes = new Uint8Array(request.body.buffer, request.body.byteOffset, request.body.byteLength).slice();
      const hashBytes = await crypto.subtle.digest("SHA-256", bytes);
      const bodySha256 = `sha256-${[...new Uint8Array(hashBytes)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
      const url = new URL(request.originalUrl, "http://groundlane-container.internal");
      const authRequest = new globalThis.Request(url, {
        method: request.method,
        headers: request.headers as HeadersInit,
      });
      const decision = await verifyContainerAuth(authRequest, authProfile, {
        signingSecret: internalSigningSecret,
        expectedAudience,
        expectedMethod: request.method,
        expectedPath: url.pathname,
        expectedPurpose: INTERNAL_ARTIFACT_PURPOSE,
        expectedBodySha256: bodySha256,
      }, nodeTimingSafeSubtle, clock);
      if (!decision.ok || decision.principal === undefined || decision.credentialBinding === undefined) {
        errorBody(response, 401, "unauthorized", "A valid internal context is required");
        return;
      }
      let responseId: string | number | null = null;
      try {
        const metadata = decodeArtifactParseBridgeMetadata(
          request.header(INTERNAL_ARTIFACT_METADATA_HEADER) ?? null,
        );
        responseId = metadata.id;
        if (metadata.source.contentHash !== bodySha256 || clock.now() >= metadata.source.expiresAt) {
          throw new Error("artifact parse bridge source binding is invalid");
        }
        const remainingMs = metadata.deadlineAt - clock.now();
        if (remainingMs < 1_000) {
          throw new GroundlaneError("DEADLINE_EXCEEDED", "document_parse", "Document parse deadline exceeded");
        }
        const input: DocumentParseInput = {
          ...metadata.input,
          timeoutMs: Math.min(metadata.input.timeoutMs ?? remainingMs, remainingMs),
          source: { kind: "artifact", refId: metadata.source.refId, artifactKind: "source" },
        };
        const operation = new AbortController();
        const abort = (): void => operation.abort(new Error("Artifact parse request disconnected"));
        request.once("aborted", abort);
        let data: unknown;
        try {
          data = await options.parseResolvedDocument(input, {
            bytes,
            mimeType: metadata.source.mimeType,
            filename: metadata.source.filename,
            sourceIdentity: {
              contentHash: metadata.source.contentHash,
              artifactRef: metadata.source.refId,
              filename: metadata.source.filename,
            },
            cacheBindingIdentity: {
              kind: "artifact",
              contentHash: metadata.source.contentHash,
              artifactRef: metadata.source.refId,
              filename: metadata.source.filename,
            },
            sourceExpiresAt: metadata.source.expiresAt,
          }, {
            principal: decision.principal,
            credentialBinding: decision.credentialBinding,
          }, operation.signal);
        } finally {
          request.off("aborted", abort);
        }
        response.json({
          jsonrpc: "2.0",
          id: metadata.id,
          result: {
            ...structuredToolResult({ ok: true, data }),
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "groundlane", version: "0.1.0" } },
          },
        });
      } catch (error) {
        const safe = toGroundlaneError(error, "document_parse");
        response.json({
          jsonrpc: "2.0",
          id: responseId,
          result: {
            ...structuredToolError({
              ok: false,
              error: {
                code: safe.code,
                stage: safe.stage,
                message: safe.message,
                retryable: safe.retryable,
                ...(safe.hint === undefined ? {} : { hint: safe.hint }),
              },
            }),
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "groundlane", version: "0.1.0" } },
          },
        });
      }
    }),
  );

  app.use(
    "/mcp",
    asyncHandler(async (request, response, next) => {
      const url = new URL(request.originalUrl, "http://groundlane-container.internal");
      const authRequest = new globalThis.Request(url, {
        method: request.method,
        headers: request.headers as HeadersInit,
      });
      const decision = await verifyContainerAuth(
        authRequest,
        authProfile,
        {
          legacyToken: authToken,
          signingSecret: internalSigningSecret,
          expectedAudience,
          expectedMethod: request.method,
          expectedPath: url.pathname,
        },
        nodeTimingSafeSubtle,
        clock,
      );
      if (!decision.ok) {
        response.setHeader("www-authenticate", 'Bearer realm="groundlane"');
        errorBody(
          response,
          401,
          "unauthorized",
          "A valid bearer token is required",
        );
        return;
      }
      if (decision.principal === undefined || decision.credentialBinding === undefined) {
        errorBody(response, 401, "invalid_context", "Authenticated context is incomplete");
        return;
      }
      response.locals.mcpRequestContext = {
        principal: decision.principal,
        credentialBinding: decision.credentialBinding,
      };
      next();
    }),
  );

  app.all(
    "/mcp",
    asyncHandler(async (request, response) => {
      await handleMcp(request, response);
    }),
  );

  app.use((_request, response) => {
    errorBody(response, 404, "not_found", "Route not found");
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    next,
  ) => {
    void next;
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 500;
    const clientError = status >= 400 && status < 500;
    console.error(
      JSON.stringify({
        level: "error",
        event: clientError ? "invalid_request" : "request_failed",
        requestId: requestId(response),
        status,
      }),
    );
    if (!response.headersSent) {
      errorBody(
        response,
        status,
        clientError ? "invalid_request" : "internal_error",
        clientError ? "The request is invalid" : "An internal error occurred",
      );
    }
  };
  app.use(errorHandler);

  return app;
}
