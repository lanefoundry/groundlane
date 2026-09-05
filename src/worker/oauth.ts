import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import {
  createOAuthPrincipal,
  type AuthenticatedPrincipal,
  type TimingSafeSubtleCrypto,
} from "./auth.js";
import { createAuthorizeHandler } from "./authorize.js";
import { proxyToContainer, type WorkerEnv } from "./proxy.js";

interface RegistrationRejection {
  readonly code: "invalid_client_metadata";
  readonly description: string;
  readonly status: 400;
}

function registrationRejection(description: string): RegistrationRejection {
  return { code: "invalid_client_metadata", description, status: 400 };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** MCP-specific compatibility policy layered over the generic RFC 7591 DCR. */
export function validateDcrClientMetadata(
  clientMetadata: Record<string, unknown>,
): RegistrationRejection | undefined {
  const applicationType = clientMetadata.application_type;
  if (applicationType !== "native" && applicationType !== "web") {
    return registrationRejection("application_type must be 'native' or 'web'");
  }
  const redirectUris = clientMetadata.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((uri): uri is string => typeof uri === "string")
  ) {
    return registrationRejection("redirect_uris must be a non-empty string array");
  }
  for (const value of redirectUris) {
    let uri: URL;
    try {
      uri = new URL(value);
    } catch {
      return registrationRejection("redirect_uris contains an invalid URL");
    }
    if (applicationType === "web" && uri.protocol !== "https:") {
      return registrationRejection("web clients require HTTPS redirect URIs");
    }
    if (
      applicationType === "native" &&
      (uri.protocol !== "http:" || !isLoopback(uri.hostname))
    ) {
      return registrationRejection("native clients require an HTTP loopback redirect URI");
    }
  }
  return undefined;
}

/**
 * Interactive cloud connectors (claude.ai, ChatGPT) expect OAuth 2.1, not the
 * static bearer token used by headless/CLI clients. This provider is only
 * consulted when that legacy token check fails — see handler.ts.
 */
export function buildOAuthProvider(
  subtle: TimingSafeSubtleCrypto,
  authenticatedProxy?: (
    request: Request,
    env: WorkerEnv,
    principal: AuthenticatedPrincipal,
    credentialBinding: string,
  ) => Promise<Response>,
): OAuthProvider<WorkerEnv> {
  return new OAuthProvider<WorkerEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        if (authenticatedProxy !== undefined) {
          const props: unknown = ctx.props;
          if (
            typeof props !== "object" ||
            props === null ||
            !("clientId" in props) ||
            typeof props.clientId !== "string" ||
            props.clientId.length === 0 ||
            !("scopes" in props) ||
            !Array.isArray(props.scopes) ||
            !props.scopes.every((scope): scope is string => typeof scope === "string")
          ) {
            return Response.json(
              { error: { code: "invalid_oauth_context", message: "OAuth context is invalid" } },
              { status: 401 },
            );
          }
          return authenticatedProxy(
            request,
            env,
            createOAuthPrincipal(props.clientId, props.scopes.length > 0 ? props.scopes : ["mcp"]),
            `oauth:${props.clientId}`,
          );
        }
        return proxyToContainer(request, env, crypto.randomUUID());
      },
    },
    defaultHandler: createAuthorizeHandler(subtle),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // Preferred client-registration path (no pre-registration step needed).
    clientIdMetadataDocumentEnabled: true,
    // Compatibility fallback for clients that don't support CIMD yet.
    clientRegistrationEndpoint: "/register",
    clientRegistrationCallback: ({ clientMetadata }) =>
      validateDcrClientMetadata(clientMetadata),
    scopesSupported: ["mcp"],
  });
}
