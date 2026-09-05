import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import {
  createOAuthPrincipal,
  type AuthenticatedPrincipal,
  type TimingSafeSubtleCrypto,
} from "./auth.js";
import { createAuthorizeHandler } from "./authorize.js";
import { proxyToContainer, type WorkerEnv } from "./proxy.js";

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
    scopesSupported: ["mcp"],
  });
}
