# Security policy

The opt-in document-output edge bridge binds the signed principal/credential to
the exact body, method, route and purpose. Worker policy owns storage identity
and TTL. Request bodies are streaming-bounded to 16 MiB and cancellable;
result read/delete share the MCP limiter and deadline. Cleanup preserves the
canonical tombstone until retained source bytes are removed. Uploaded-source
deletion and expiry revoke derived output access through credential-bound reverse
bindings; reads revalidate the original source and failed cleanup retains a
durable cursor. These paths have deterministic coverage; live deployed acceptance
remains open.

Groundlane provides network and browser access on behalf of remote clients. Security is part of the product contract, not an optional deployment add-on.

## Supported versions

Groundlane is currently an early preview. Security fixes are applied to the latest commit on the default branch. No tagged release line is guaranteed to receive backports until the project publishes a stable release policy.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, discussion, pull request, or chat.

Use GitHub's **Report a vulnerability** flow on the repository Security tab to submit a private report. If private vulnerability reporting is unavailable, contact the repository maintainers privately through the contact method on the repository owner's GitHub profile and ask for a secure reporting channel without including exploit details in the first message.

Include, where possible:

- the affected commit or version;
- the component and deployment mode;
- reproduction steps or a minimal proof of concept;
- expected and observed behavior;
- security impact and required preconditions;
- suggested mitigations, if known.

Maintainers will acknowledge a complete report as soon as practical, coordinate validation and remediation, and credit reporters who want attribution. Timelines depend on severity and project capacity; please allow a fix to be prepared before public disclosure.

## Security model

Groundlane assumes:

- the public MCP endpoint is authenticated with a strong bearer token;
- operators keep provider credentials and deployment secrets outside source control;
- callers may provide malicious URLs, selectors, search queries, and field definitions;
- destination hosts, DNS responses, redirects, provider results, page scripts, subresources, and browser traffic are untrusted;
- an application-level URL check alone is not a complete egress boundary.

The intended defenses include public HTTP(S)-only URL validation, rejection of embedded credentials, DNS and redirect validation, IP pinning for direct/local connections, local-browser subresource policy, one end-to-end deadline, byte/output/result limits, bounded concurrency and queues, stable public errors, and metadata-only audit logging.

Modern MCP routing headers are untrusted hints. After authentication, the
Worker performs a bounded early consistency check over a cloned JSON body and
preserves the original body, headers, and cancellation signal across the
Container boundary. The Container then repeats authoritative JSON-RPC,
request-envelope, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, capability,
and parameter validation in the SDK transport. Neither layer derives a
principal or authorization decision from routing headers. Caller credentials
are replaced with a short-lived signed principal context and non-secret
credential binding before the managed Container boundary.

Durable MCP Tasks use opaque Groundlane IDs and bind every lookup, update, and
cancel to the authenticated owner plus credential binding. Provider task IDs,
keys, authorization headers, and raw provider failures are not returned. Small
lifecycle state is revision-fenced in SQLite or D1 and capped before storage;
large output requires a future ArtifactRef path. A provider-create effect is
claimed before network dispatch, and an ambiguous crash becomes terminal
instead of automatically repeating a possibly paid call. HTTP disconnect only
aborts that request leg. Task cancellation records Groundlane intent separately
from upstream acknowledgement and never reports upstream cancellation without
provider evidence.

Cloudflare source uploads use short-lived, conditional, single-object R2 S3
PUT handoffs. The URL is an expiring transfer capability: it may be returned
only by `document_upload_create` and must not appear in logs, ArtifactRefs,
later tool arguments, or durable metadata. D1 intent/artifact state binds the
authenticated owner and exact credential binding; R2 staging metadata stores a
credential hash, declared MIME/size, expiry, and optional expected digest.
Complete reads and verifies the object through the native binding before an
immutable opaque source ref is minted. Artifact parsing crosses the
Worker-to-Container boundary only through a signed purpose-, path-, request-,
credential-, and body-hash-bound binary route. The Container receives neither
R2/D1 bindings nor presigning/caller credentials. The reference Worker runs a
bounded hourly cleanup: access is CAS-revoked before final bytes are removed,
staging deletion rechecks immutable owner/credential/expiry metadata, and
partial failures remain cleanup-pending for retry. Current tests do not replace
a controlled production smoke, so the deployed cleanup schedule remains a
release-evidence gate.

The Cloudflare document cache uses a different signed Container-to-Worker
route on the fixed `groundlane-cache.internal` host. Requests are versioned,
bounded, tied to the authenticated principal and credential binding, and carry
lookup/commit data or a source-binding revocation; the Worker retains the D1/R2 bindings and operator TTL
policy. Source-binding identifiers contain a one-way credential hash, and an
artifact-derived binding cannot outlive the verified artifact. Cache/backend
failures expose only a stable fail-open error. Expiry cleanup is page-bounded
and removes immutable payload bytes before the metadata CAS so a crash leaves
retryable metadata rather than an orphaned payload. Public artifact deletion
and expiry cleanup invoke credential-scoped cache-binding revocation before
settling immutable bytes. Corpus update/remove/delete invalidates normalized-source
cache bindings, including through the signed private revoke route. A Cloudflare
corpus backend and its controlled lifecycle acceptance remain separate gates.
Private cache and output handlers register through the Container SDK's inherited
outbound setter; static-block assignment avoids shadowing that registration with
an ES2022 class field.

Modern multi-round request state uses a dedicated SDK HMAC codec and a secret
that is separate from caller, admin, Worker-to-Container, and provider
credentials. State expires after five minutes and is bound to the authenticated
principal, credential binding, and JSON-RPC method; tool arguments are checked
against the signed flow payload on retry. The state is integrity-protected but
not encrypted, so payloads must never contain secrets. Key rotation invalidates
outstanding flows. Replay protection is workflow-specific: the initial
`document_policy` flow is deliberately read-only and deterministic, while any
future side-effectful flow requires a durable receipt before dispatch.

OAuth discovery pins the `/mcp` protected resource to the authorization-server
issuer, advertises CIMD only with Cloudflare's strictly-public fetch flag, and
uses RFC 9207 `iss` on success and redirect errors. Access tokens retain their
requested resource audience; a token for another resource is rejected before
the Container. The bearer-protected DCR compatibility endpoint requires an
explicit application type and accepts only HTTPS redirects for web clients or
HTTP loopback redirects for native clients. Admin credentials, internal
context signatures, provider keys, and OAuth/data-plane credentials remain
separate roles.

Hosted Jina Reader and Browserless backends are opt-in trust boundaries. They receive the requested public URL and perform retrieval from their own infrastructure. Groundlane validates the original URL and any final URL reported back, bounds the response, and never sends Groundlane/provider secrets to a target page. It cannot IP-pin the hosted provider's target connection or independently inspect every hosted-browser subrequest. Operators who require self-controlled egress should leave Reader disabled and use the `local` browser backend.

Operators should also enforce network egress policy outside the process, rotate credentials, limit token distribution, monitor unusual usage, and isolate browser workloads from secrets and internal services.

## Out of scope and responsible use

Groundlane does not promise universal anti-bot bypass, CAPTCHA solving, anonymous browsing, or authorization to access restricted content. A report that only demonstrates a target website blocking automated access is not a Groundlane vulnerability.

The following may still be valid security reports when they cross a Groundlane trust boundary:

- SSRF or DNS-rebinding paths;
- authentication or tenant-isolation bypass;
- secret or private-content disclosure;
- browser/container escape;
- policy bypass through redirects, subresources, WebSockets, or alternate address forms;
- denial of service that defeats documented resource limits;
- injection into logs, protocol responses, or deployment control paths.

Use test systems you own or are authorized to assess. Do not include live credentials, personal data, or unnecessary third-party data in reports.
