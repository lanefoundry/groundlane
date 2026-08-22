import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import type { TimingSafeSubtleCrypto } from "./auth.js";
import { createAuthorizeHandler } from "./authorize.js";
import { proxyToContainer, type WorkerEnv } from "./proxy.js";

/**
 * Interactive cloud connectors (claude.ai, ChatGPT) expect OAuth 2.1, not the
 * static bearer token used by headless/CLI clients. This provider is only
 * consulted when that legacy token check fails — see handler.ts.
 */
export function buildOAuthProvider(
  subtle: TimingSafeSubtleCrypto,
): OAuthProvider<WorkerEnv> {
  return new OAuthProvider<WorkerEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env) {
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
