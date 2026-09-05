import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { createContainerApp } from "../../src/container/app.js";
import {
  encodeArtifactParseBridgeMetadata,
  INTERNAL_ARTIFACT_METADATA_HEADER,
  INTERNAL_ARTIFACT_PARSE_PATH,
  INTERNAL_ARTIFACT_PURPOSE,
} from "../../src/mcp/artifact-bridge.js";
import { mintInternalContext } from "../../src/worker/internal-context.js";
import { FakeClock } from "../../src/worker/managed-tokens.js";

const signingSecret = "artifact-bridge-signing-secret-long-enough";
const subtle = {
  digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
    return crypto.subtle.digest(algorithm, data);
  },
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean {
    const a = left instanceof ArrayBuffer ? new Uint8Array(left) : new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const b = right instanceof ArrayBuffer ? new Uint8Array(right) : new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return timingSafeEqual(a, b);
  },
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return `sha256-${[...new Uint8Array(value)].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");
  return address.port;
}

void test("body-bound internal bridge preserves ArtifactRef identity without exposing storage access", async () => {
  const clock = new FakeClock(1_800_000_000_000);
  const bytes = new TextEncoder().encode("%PDF-1.7\n");
  const digest = await sha256(bytes);
  const requestId = "artifact-parse-request";
  const token = await mintInternalContext({
    signingSecret,
    audience: "groundlane-mcp-v2",
    method: "POST",
    path: INTERNAL_ARTIFACT_PARSE_PATH,
    requestId,
    principal: { principalId: "owner", authMethod: "managed_token", scopes: ["mcp"], credentialId: "credential-a" },
    credentialBinding: "managed:credential-a",
    purpose: INTERNAL_ARTIFACT_PURPOSE,
    bodySha256: digest,
  }, subtle, clock);
  const metadata = encodeArtifactParseBridgeMetadata({
    id: 7,
    deadlineAt: clock.now() + 30_000,
    input: { output: "text", maxPages: 5, cacheMode: "bypass" },
    source: {
      refId: "art_opaque",
      contentHash: digest,
      mimeType: "application/pdf",
      filename: "source.pdf",
      expiresAt: clock.now() + 60_000,
    },
  });
  let observed = "";
  const app = createContainerApp({
    authMode: "worker_internal_context",
    internalSigningSecret: signingSecret,
    expectedAudience: "groundlane-mcp-v2",
    clock,
    parseResolvedDocument(_input, resolved, context) {
      observed = JSON.stringify({
        ref: resolved.sourceIdentity.artifactRef,
        hash: resolved.sourceIdentity.contentHash,
        owner: context.principal.principalId,
        credential: context.credentialBinding,
      });
      return Promise.resolve({ parsed: true });
    },
  });
  const server = createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${INTERNAL_ARTIFACT_PARSE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-request-id": requestId,
        "x-groundlane-internal-context": token,
        [INTERNAL_ARTIFACT_METADATA_HEADER]: metadata,
      },
      body: bytes,
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"id":7/u);
    assert.match(text, /"parsed":true/u);
    assert.match(observed, /art_opaque/u);
    assert.match(observed, /managed:credential-a/u);
    assert.doesNotMatch(text, /managed:credential-a|staging\/|r2\.cloudflarestorage/u);

    const tampered = await fetch(`http://127.0.0.1:${String(port)}${INTERNAL_ARTIFACT_PARSE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-request-id": requestId,
        "x-groundlane-internal-context": token,
        [INTERNAL_ARTIFACT_METADATA_HEADER]: metadata,
      },
      body: new TextEncoder().encode("different"),
    });
    assert.equal(tampered.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});
