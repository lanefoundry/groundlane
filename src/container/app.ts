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
import { hasValidBearerToken } from "../worker/auth.js";
import { createMcpHttpHandler } from "../mcp/server.js";
import {
  createMcpRegistry,
  type McpRegistryFactory,
} from "../mcp/registry.js";

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
  registryFactory?: McpRegistryFactory | undefined;
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
  const registryFactory =
    options.registryFactory ?? (() => createMcpRegistry());
  const handleMcp = createMcpHttpHandler(registryFactory);

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
    if (authToken.length === 0) {
      errorBody(
        response,
        503,
        "not_ready",
        "GROUNDLANE_AUTH_TOKEN is not configured",
      );
      return;
    }
    response.json({ status: "ready", requestId: requestId(response) });
  });

  app.use(
    "/mcp",
    asyncHandler(async (request, response, next) => {
      if (
        authToken.length === 0 ||
        !(await hasValidBearerToken(
          request.headers.authorization ?? null,
          authToken,
          nodeTimingSafeSubtle,
        ))
      ) {
        response.setHeader("www-authenticate", 'Bearer realm="groundlane"');
        errorBody(
          response,
          401,
          "unauthorized",
          "A valid bearer token is required",
        );
        return;
      }
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