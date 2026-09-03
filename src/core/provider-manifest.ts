import { createHash } from "node:crypto";

export const MANIFEST_SCHEMA_VERSION = "1.0.0";

export interface ProviderManifestEntry {
  readonly id: string;
  readonly baseUrl: string;
  readonly protocol: "groundlane-provider-v1";
}

export interface ProviderManifest {
  readonly schemaVersion: string;
  readonly digest: string;
  readonly providers: readonly ProviderManifestEntry[];
}

export interface EndpointAllowlist {
  readonly allowedOrigins: readonly string[];
}

const CUSTOM_ID_RE = /^custom\.[a-z0-9][a-z0-9-]*$/u;

function canonicalJson(manifest: Omit<ProviderManifest, "digest">): string {
  const sorted = [...manifest.providers].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ schemaVersion: manifest.schemaVersion, providers: sorted });
}

export function computeManifestDigest(manifest: Omit<ProviderManifest, "digest">): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function verifyManifestDigest(manifest: ProviderManifest): boolean {
  const expected = computeManifestDigest({
    schemaVersion: manifest.schemaVersion,
    providers: manifest.providers,
  });
  return manifest.digest === expected;
}

export function verifyManifestConsistency(
  worker: ProviderManifest,
  container: ProviderManifest,
): void {
  if (worker.schemaVersion !== container.schemaVersion) {
    throw new Error(
      `Manifest schema version mismatch: worker=${worker.schemaVersion}, container=${container.schemaVersion}`,
    );
  }
  if (worker.digest !== container.digest) {
    throw new Error(
      `Manifest digest mismatch: worker=${worker.digest}, container=${container.digest}`,
    );
  }
  if (!verifyManifestDigest(worker)) {
    throw new Error("Worker manifest digest does not match content");
  }
  if (!verifyManifestDigest(container)) {
    throw new Error("Container manifest digest does not match content");
  }
}

export function validateManifestEntry(entry: ProviderManifestEntry): void {
  if (!CUSTOM_ID_RE.test(entry.id)) {
    throw new Error(`Manifest entry ID "${entry.id}" must match custom.<lowercase-alphanumeric-hyphens>`);
  }
  if (entry.protocol !== "groundlane-provider-v1") {
    throw new Error(`Manifest entry "${entry.id}" has unsupported protocol "${String(entry.protocol)}"`);
  }
  if (!entry.baseUrl || typeof entry.baseUrl !== "string") {
    throw new Error(`Manifest entry "${entry.id}" must have a non-empty baseUrl`);
  }
  let parsed: URL;
  try {
    parsed = new URL(entry.baseUrl);
  } catch {
    throw new Error(`Manifest entry "${entry.id}" has invalid baseUrl "${entry.baseUrl}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Manifest entry "${entry.id}" baseUrl must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Manifest entry "${entry.id}" baseUrl must not contain credentials`);
  }
}

export function validateEndpointAllowlist(
  baseUrl: string,
  allowlist: EndpointAllowlist,
): void {
  if (allowlist.allowedOrigins.length === 0) {
    throw new Error("Endpoint allowlist is empty; no operator-hosted endpoints are permitted");
  }
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new Error(`Invalid base URL "${baseUrl}"`);
  }
  if (!allowlist.allowedOrigins.includes(origin)) {
    throw new Error(
      `Endpoint origin "${origin}" is not in the operator allowlist`,
    );
  }
}

export function resolveProviderEndpoint(
  providerId: string,
  manifest: ProviderManifest,
): string {
  const entry = manifest.providers.find((e) => e.id === providerId);
  if (entry === undefined) {
    throw new Error(`No manifest entry for provider "${providerId}"`);
  }
  return entry.baseUrl;
}

export function buildManifest(
  entries: readonly ProviderManifestEntry[],
): ProviderManifest {
  for (const entry of entries) {
    validateManifestEntry(entry);
  }
  const ids = entries.map((e) => e.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new Error("Manifest contains duplicate provider IDs");
  }
  const partial = { schemaVersion: MANIFEST_SCHEMA_VERSION, providers: entries };
  return { ...partial, digest: computeManifestDigest(partial) };
}

export function validateManifest(manifest: ProviderManifest): void {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported manifest schema version "${manifest.schemaVersion}" (expected "${MANIFEST_SCHEMA_VERSION}")`,
    );
  }
  if (!verifyManifestDigest(manifest)) {
    throw new Error("Manifest digest verification failed");
  }
  for (const entry of manifest.providers) {
    validateManifestEntry(entry);
  }
}

export function workerBindingAllowlist(
  manifest: ProviderManifest,
): readonly string[] {
  return manifest.providers.map((entry) => {
    const suffix = entry.id
      .replace(/^custom\./u, "")
      .toUpperCase()
      .replace(/-/gu, "_");
    return `GROUNDLANE_CUSTOM_PROVIDER_${suffix}_TOKEN`;
  });
}
