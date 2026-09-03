import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManifest,
  computeManifestDigest,
  MANIFEST_SCHEMA_VERSION,
  resolveProviderEndpoint,
  validateEndpointAllowlist,
  validateManifest,
  validateManifestEntry,
  verifyManifestConsistency,
  verifyManifestDigest,
  workerBindingAllowlist,
  type EndpointAllowlist,
  type ProviderManifest,
  type ProviderManifestEntry,
} from "../../src/core/provider-manifest.js";

function makeEntry(id: string, baseUrl = "https://provider.example.com/v1"): ProviderManifestEntry {
  return { id, baseUrl, protocol: "groundlane-provider-v1" };
}

// ---------------------------------------------------------------------------
// PRD 618: Operator-hosted base URL from manifest only, endpoint allowlist
// ---------------------------------------------------------------------------

void test("PRD 618: base URL is resolved exclusively from manifest", () => {
  const manifest = buildManifest([makeEntry("custom.acme", "https://acme.example.com/api")]);
  const url = resolveProviderEndpoint("custom.acme", manifest);
  assert.equal(url, "https://acme.example.com/api");
});

void test("PRD 618: resolveProviderEndpoint throws for missing provider", () => {
  const manifest = buildManifest([makeEntry("custom.acme")]);
  assert.throws(
    () => resolveProviderEndpoint("custom.other", manifest),
    { message: /No manifest entry for provider "custom\.other"/ },
  );
});

void test("PRD 618: endpoint passes allowlist validation", () => {
  const allowlist: EndpointAllowlist = {
    allowedOrigins: ["https://acme.example.com"],
  };
  assert.doesNotThrow(() => {
    validateEndpointAllowlist("https://acme.example.com/v1/search", allowlist);
  });
});

void test("PRD 618: endpoint rejected when not in allowlist", () => {
  const allowlist: EndpointAllowlist = {
    allowedOrigins: ["https://allowed.example.com"],
  };
  assert.throws(
    () => validateEndpointAllowlist("https://evil.example.com/v1/search", allowlist),
    { message: /not in the operator allowlist/ },
  );
});

void test("PRD 618: empty allowlist rejects all endpoints", () => {
  const allowlist: EndpointAllowlist = { allowedOrigins: [] };
  assert.throws(
    () => validateEndpointAllowlist("https://any.example.com", allowlist),
    { message: /Endpoint allowlist is empty/ },
  );
});

void test("PRD 618: baseUrl must use HTTPS", () => {
  assert.throws(
    () => validateManifestEntry(makeEntry("custom.insecure", "http://plain.example.com")),
    { message: /must use HTTPS/ },
  );
});

void test("PRD 618: baseUrl must not contain credentials", () => {
  assert.throws(
    () => validateManifestEntry(makeEntry("custom.creds", "https://user:pass@host.example.com")),
    { message: /must not contain credentials/ },
  );
});

void test("PRD 618: baseUrl must be a valid URL", () => {
  assert.throws(
    () => validateManifestEntry(makeEntry("custom.bad-url", "not-a-url")),
    { message: /invalid baseUrl/ },
  );
});

void test("PRD 618: baseUrl must not be empty", () => {
  assert.throws(
    () => validateManifestEntry({ id: "custom.empty", baseUrl: "", protocol: "groundlane-provider-v1" }),
    { message: /non-empty baseUrl/ },
  );
});

void test("PRD 618: manifest entry protocol must be groundlane-provider-v1", () => {
  assert.throws(
    () => validateManifestEntry({
      id: "custom.wrong-proto",
      baseUrl: "https://ok.example.com",
      protocol: "unknown" as "groundlane-provider-v1",
    }),
    { message: /unsupported protocol/ },
  );
});

void test("PRD 618: manifest entry ID must be custom.*", () => {
  assert.throws(
    () => validateManifestEntry({
      id: "tavily",
      baseUrl: "https://override.example.com",
      protocol: "groundlane-provider-v1",
    }),
    { message: /must match custom\./ },
  );
});

void test("PRD 618: caller cannot override endpoint via manifest entry for built-in provider", () => {
  assert.throws(
    () => buildManifest([{
      id: "brave",
      baseUrl: "https://evil.example.com",
      protocol: "groundlane-provider-v1",
    }]),
    { message: /must match custom\./ },
  );
});

void test("PRD 618: allowlist validates origin not full path", () => {
  const allowlist: EndpointAllowlist = {
    allowedOrigins: ["https://api.provider.com"],
  };
  assert.doesNotThrow(() => {
    validateEndpointAllowlist("https://api.provider.com/v1/search?q=test", allowlist);
  });
  assert.throws(
    () => validateEndpointAllowlist("https://api.provider.com:8443/v1", allowlist),
    { message: /not in the operator allowlist/ },
  );
});

void test("PRD 618: multiple providers each validated against allowlist", () => {
  const allowlist: EndpointAllowlist = {
    allowedOrigins: [
      "https://provider-a.example.com",
      "https://provider-b.example.com",
    ],
  };
  const manifest = buildManifest([
    makeEntry("custom.alpha", "https://provider-a.example.com/api"),
    makeEntry("custom.beta", "https://provider-b.example.com/api"),
  ]);
  for (const entry of manifest.providers) {
    assert.doesNotThrow(() => validateEndpointAllowlist(entry.baseUrl, allowlist));
  }
});

// ---------------------------------------------------------------------------
// PRD 621: Canonical manifest with schema version and digest verification
// ---------------------------------------------------------------------------

void test("PRD 621: buildManifest produces valid digest", () => {
  const manifest = buildManifest([makeEntry("custom.test")]);
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.ok(manifest.digest.length === 64);
  assert.ok(verifyManifestDigest(manifest));
});

void test("PRD 621: tampered manifest fails digest verification", () => {
  const manifest = buildManifest([makeEntry("custom.test")]);
  const tampered: ProviderManifest = {
    ...manifest,
    providers: [makeEntry("custom.test", "https://evil.example.com")],
  };
  assert.equal(verifyManifestDigest(tampered), false);
});

void test("PRD 621: tampered digest fails verification", () => {
  const manifest = buildManifest([makeEntry("custom.test")]);
  const tampered: ProviderManifest = {
    ...manifest,
    digest: "0".repeat(64),
  };
  assert.equal(verifyManifestDigest(tampered), false);
});

void test("PRD 621: matching Worker and Container manifests pass consistency check", () => {
  const entries = [makeEntry("custom.alpha"), makeEntry("custom.beta")];
  const worker = buildManifest(entries);
  const container = buildManifest(entries);
  assert.doesNotThrow(() => verifyManifestConsistency(worker, container));
});

void test("PRD 621: mismatched schema version fails consistency check", () => {
  const manifest = buildManifest([makeEntry("custom.test")]);
  const stale: ProviderManifest = { ...manifest, schemaVersion: "0.9.0" };
  assert.throws(
    () => verifyManifestConsistency(manifest, stale),
    { message: /schema version mismatch/ },
  );
});

void test("PRD 621: mismatched digest fails consistency check", () => {
  const worker = buildManifest([makeEntry("custom.alpha")]);
  const container = buildManifest([makeEntry("custom.beta")]);
  assert.throws(
    () => verifyManifestConsistency(worker, container),
    { message: /digest mismatch/ },
  );
});

void test("PRD 621: stale artifact with wrong digest fails validateManifest", () => {
  const manifest = buildManifest([makeEntry("custom.test")]);
  const stale: ProviderManifest = {
    ...manifest,
    digest: "a".repeat(64),
  };
  assert.throws(
    () => validateManifest(stale),
    { message: /digest verification failed/ },
  );
});

void test("PRD 621: unsupported schema version fails validateManifest", () => {
  const manifest = buildManifest([makeEntry("custom.test")]);
  const future: ProviderManifest = {
    ...manifest,
    schemaVersion: "99.0.0",
    digest: computeManifestDigest({ schemaVersion: "99.0.0", providers: manifest.providers }),
  };
  assert.throws(
    () => validateManifest(future),
    { message: /Unsupported manifest schema version/ },
  );
});

void test("PRD 621: duplicate provider IDs in manifest are rejected", () => {
  assert.throws(
    () => buildManifest([
      makeEntry("custom.dup"),
      makeEntry("custom.dup", "https://other.example.com"),
    ]),
    { message: /duplicate provider IDs/ },
  );
});

void test("PRD 621: workerBindingAllowlist derives binding names from manifest", () => {
  const manifest = buildManifest([
    makeEntry("custom.acme"),
    makeEntry("custom.my-search"),
  ]);
  const bindings = workerBindingAllowlist(manifest);
  assert.deepEqual([...bindings].sort(), [
    "GROUNDLANE_CUSTOM_PROVIDER_ACME_TOKEN",
    "GROUNDLANE_CUSTOM_PROVIDER_MY_SEARCH_TOKEN",
  ]);
});

void test("PRD 621: digest is order-independent (canonical sort)", () => {
  const a = makeEntry("custom.alpha", "https://a.example.com");
  const b = makeEntry("custom.beta", "https://b.example.com");
  const m1 = buildManifest([a, b]);
  const m2 = buildManifest([b, a]);
  assert.equal(m1.digest, m2.digest);
});

void test("PRD 621: empty manifest is valid", () => {
  const manifest = buildManifest([]);
  assert.ok(verifyManifestDigest(manifest));
  assert.equal(manifest.providers.length, 0);
});

void test("PRD 621: hand-written mapping with wrong digest rejected by validateManifest", () => {
  const realManifest = buildManifest([makeEntry("custom.real")]);
  const handWritten: ProviderManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    digest: realManifest.digest,
    providers: [makeEntry("custom.other")],
  };
  assert.throws(
    () => validateManifest(handWritten),
    { message: /digest verification failed/ },
  );
});

void test("PRD 621: consistency check catches content-tampered manifest with original digest", () => {
  const worker = buildManifest([makeEntry("custom.test")]);
  const tampered: ProviderManifest = {
    schemaVersion: worker.schemaVersion,
    digest: worker.digest,
    providers: [makeEntry("custom.test", "https://different.example.com")],
  };
  assert.throws(
    () => verifyManifestConsistency(worker, tampered),
    { message: /digest/ },
  );
});
