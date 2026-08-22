import { AuthorizationError, type AuthRequest, type ClientInfo } from "@cloudflare/workers-oauth-provider";

import { timingSafeTokenEqual, type TimingSafeSubtleCrypto } from "./auth.js";
import type { WorkerEnv } from "./proxy.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function clientDisplayName(client: ClientInfo): string {
  return client.clientName !== undefined && client.clientName.trim().length > 0
    ? client.clientName
    : client.clientId;
}

function renderForm(options: {
  clientName: string;
  scope: readonly string[];
  errorMessage?: string;
}): Response {
  const scopeText =
    options.scope.length > 0 ? options.scope.join(", ") : "(no scopes requested)";
  const errorHtml =
    options.errorMessage !== undefined
      ? `<p role="alert">${escapeHtml(options.errorMessage)}</p>`
      : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize groundlane</title>
</head>
<body>
<h1>${escapeHtml(options.clientName)} wants to access groundlane</h1>
<p>Requested scope: ${escapeHtml(scopeText)}</p>
${errorHtml}
<form method="POST">
<label for="passphrase">Owner passphrase</label>
<input id="passphrase" type="password" name="passphrase" autocomplete="off" autofocus required>
<button type="submit">Approve</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * `/authorize` is owned by the application, not the library: the provider only
 * references it in OAuth metadata. This single-user deployment gates consent
 * with a dedicated owner passphrase (never the raw MCP bearer token, so a
 * phished consent page can't leak the credential every static-token client
 * also uses) instead of a real identity provider.
 */
export interface AuthorizeHandler {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response>;
}

export function createAuthorizeHandler(subtle: TimingSafeSubtleCrypto): AuthorizeHandler {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== "/authorize") {
        return new Response("Not found", { status: 404 });
      }
      if (env.OAUTH_PROVIDER === undefined) {
        return new Response("OAuth is not configured", { status: 500 });
      }

      let oauthRequest: AuthRequest;
      try {
        oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
        if (error.redirectUri === undefined) {
          return new Response(error.description, { status: 400 });
        }
        const redirect = new URL(error.redirectUri);
        redirect.searchParams.set("error", error.code);
        redirect.searchParams.set("error_description", error.description);
        if (error.state !== undefined) redirect.searchParams.set("state", error.state);
        if (error.issuer !== undefined) redirect.searchParams.set("iss", error.issuer);
        return Response.redirect(redirect.toString(), 302);
      }

      const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
      if (client === null) {
        return new Response("Unknown OAuth client", { status: 400 });
      }
      const clientName = clientDisplayName(client);

      if (request.method !== "POST") {
        return renderForm({ clientName, scope: oauthRequest.scope });
      }

      const form = await request.formData();
      const passphrase = form.get("passphrase");
      const isValid =
        typeof passphrase === "string" &&
        env.OAUTH_OWNER_PASSPHRASE.length > 0 &&
        (await timingSafeTokenEqual(passphrase, env.OAUTH_OWNER_PASSPHRASE, subtle));

      if (!isValid) {
        return renderForm({
          clientName,
          scope: oauthRequest.scope,
          errorMessage: "Incorrect passphrase.",
        });
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthRequest,
        userId: "owner",
        metadata: { clientName },
        scope: oauthRequest.scope,
        props: {},
      });

      return Response.redirect(redirectTo, 302);
    },
  };
}
