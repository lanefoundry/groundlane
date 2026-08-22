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
  const scopeBadges =
    options.scope.length > 0
      ? options.scope.map((scope) => `<span class="scope">${escapeHtml(scope)}</span>`).join("")
      : `<span class="scope scope-empty">no scopes requested</span>`;
  const errorHtml =
    options.errorMessage !== undefined
      ? `<p class="error" role="alert">${escapeHtml(options.errorMessage)}</p>`
      : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize groundlane</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f5f3;
    --card: #ffffff;
    --border: #e4e2dd;
    --text: #1c1b1a;
    --muted: #68655f;
    --accent: #211f1c;
    --accent-contrast: #ffffff;
    --input-bg: #ffffff;
    --input-border: #d7d4cd;
    --error-bg: #fbecec;
    --error-text: #8a2f2f;
    --shadow: 0 20px 45px -20px rgba(28, 26, 23, 0.35);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #171614;
      --card: #201f1c;
      --border: #34322d;
      --text: #f2f0ec;
      --muted: #a6a29a;
      --accent: #f2f0ec;
      --accent-contrast: #171614;
      --input-bg: #171614;
      --input-border: #423f38;
      --error-bg: #3a2020;
      --error-text: #f3a99a;
      --shadow: 0 20px 45px -20px rgba(0, 0, 0, 0.6);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    min-height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 400px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow);
    padding: 32px;
  }
  .mark {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: var(--accent);
    color: var(--accent-contrast);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 18px;
    margin-bottom: 20px;
  }
  h1 {
    font-size: 19px;
    line-height: 1.4;
    margin: 0 0 6px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .subtitle {
    margin: 0 0 20px;
    color: var(--muted);
    font-size: 14px;
  }
  .scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 24px;
  }
  .scope {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .scope-empty {
    color: var(--muted);
    font-family: inherit;
  }
  .error {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--error-bg);
    color: var(--error-text);
    font-size: 13px;
  }
  form { margin: 0; }
  label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  input[type="password"] {
    width: 100%;
    padding: 11px 12px;
    border-radius: 10px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font-size: 15px;
    margin-bottom: 16px;
  }
  input[type="password"]:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  button {
    width: 100%;
    padding: 12px;
    border: none;
    border-radius: 10px;
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.05); }
  button:active { filter: brightness(0.95); }
  .footer {
    margin-top: 20px;
    font-size: 12px;
    color: var(--muted);
    text-align: center;
  }
</style>
</head>
<body>
<div class="card">
  <div class="mark">G</div>
  <h1>${escapeHtml(options.clientName)} wants to access groundlane</h1>
  <p class="subtitle">Enter the owner passphrase to approve this connection.</p>
  <div class="scopes">${scopeBadges}</div>
  ${errorHtml}
  <form method="POST">
    <label for="passphrase">Owner passphrase</label>
    <input id="passphrase" type="password" name="passphrase" autocomplete="off" autofocus required>
    <button type="submit">Approve</button>
  </form>
  <p class="footer">groundlane · single-user OAuth gate</p>
</div>
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
