import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";
import { GroundlaneError, hint } from "./errors.js";

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type DnsLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<readonly ResolvedAddress[]>;
export interface UrlPolicyOptions {
  lookup?: DnsLookup;
  cache?: Map<string, readonly ResolvedAddress[]>;
  allowedPorts?: ReadonlySet<number>;
  signal?: AbortSignal | undefined;
}
export interface SafeDestination { url: URL; hostname: string; port: number; addresses: readonly ResolvedAddress[] }

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::",128],["::1",128],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["2001::",32],["2001:db8::",32],["2002::",16],["fc00::",7],["fe80::",10],["ff00::",8]] as const) blocked.addSubnet(address, prefix, "ipv6");

export function parsePublicUrl(value: string, allowedPorts: ReadonlySet<number> = new Set([80, 443])): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new GroundlaneError("INVALID_INPUT", "url", "URL must be valid", false, undefined, hint("url.invalid", "Pass an absolute http:// or https:// URL, including scheme, host, and path.")); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GroundlaneError("URL_BLOCKED", "url", "Only HTTP and HTTPS URLs are allowed", false, undefined, hint("url.blocked.invalid_protocol", "Groundlane only fetches public HTTP and HTTPS. Convert the URL scheme (e.g. ftp://, file://, ws://) or self-host the resource behind HTTPS."));
  }
  if (url.username || url.password) {
    throw new GroundlaneError("URL_BLOCKED", "url", "URLs containing credentials are not allowed", false, undefined, hint("url.blocked.credentials", "Strip user:pass@ from the URL and pass credentials via the provider's normal auth mechanism (API key, OAuth) instead."));
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || !allowedPorts.has(port)) {
    throw new GroundlaneError("URL_BLOCKED", "url", "Destination port is not allowed", false, undefined, hint("url.blocked.invalid_port", "Allowed ports are 80 (http) and 443 (https). Use a service on a standard port, or run an operator-side proxy that exposes it on 443."));
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function throwIfAborted(signal: AbortSignal | undefined, stage: string, message: string): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof GroundlaneError) throw signal.reason;
  throw new GroundlaneError("CANCELLED", stage, message, false, undefined, hint(`${stage}.cancelled`, message));
}

export async function resolvePublicUrl(value: string, options: UrlPolicyOptions = {}): Promise<SafeDestination> {
  throwIfAborted(options.signal, "url", "URL validation was cancelled");
  const url = parsePublicUrl(value, options.allowedPorts);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new GroundlaneError("URL_BLOCKED", "dns", "Local destinations are not allowed", false, undefined, hint("dns.blocked.localhost", "localhost and *.localhost resolve to the local machine and are blocked to prevent SSRF. Use a public hostname, an operator-side proxy, or run Groundlane locally with overrides."));
  }
  let addresses = options.cache?.get(hostname);
  if (!addresses) {
    if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
    else {
      try { addresses = await (options.lookup ?? dns.lookup)(hostname, { all: true, verbatim: true }) as readonly ResolvedAddress[]; }
      catch { throw new GroundlaneError("UPSTREAM_ERROR", "dns", "Destination hostname could not be resolved", true, undefined, hint("dns.unresolved", "DNS lookup returned no answers. Verify the hostname, ensure the deployment has egress DNS, and check for typos or stale cache.")); }
      throwIfAborted(options.signal, "url", "URL validation was cancelled");
    }
    options.cache?.set(hostname, addresses);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new GroundlaneError("URL_BLOCKED", "dns", "Private or reserved destinations are not allowed", false, undefined, hint("dns.blocked.private_address", "Every resolved address must be a public IP. The hostname may have public CNAMEs that resolve to private/link-local/cloud-metadata ranges; block it or expose it via a public proxy."));
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { url, hostname, port, addresses };
}

export function resolveRedirect(base: URL, location: string): string {
  try { return new URL(location, base).href; }
  catch { throw new GroundlaneError("UPSTREAM_ERROR", "redirect", "Upstream returned an invalid redirect", true, undefined, hint("redirect.invalid_location", "Upstream sent a Location header that did not resolve relative to the request URL. Try the page again or use the provider-backed content APIs which normalise redirects.")); }
}
