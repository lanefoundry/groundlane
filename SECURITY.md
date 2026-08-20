# Security policy

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
