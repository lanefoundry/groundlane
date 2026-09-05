// Explicit opt-in controlled staging smoke; no third-party processing providers.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

export function validateSmokeEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Unsafe smoke endpoint"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const staging = /^groundlane-prd-staging\.[a-z0-9-]+\.workers\.dev$/u.test(url.hostname);
  if ((!loopback && !staging) || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/mcp" || (staging && (url.protocol !== "https:" || url.port !== "")) ||
      (loopback && !["http:", "https:"].includes(url.protocol))) throw new Error("Unsafe smoke endpoint");
  return url;
}

export function validateUploadEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Unsafe upload endpoint"); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !/^[a-z0-9]+\.r2\.cloudflarestorage\.com$/u.test(url.hostname)) throw new Error("Unsafe upload endpoint");
  return url;
}

const cacheResult = z.object({
  cached: z.boolean(),
  cache: z.object({ requestedMode: z.enum(["use", "refresh", "bypass"]), enabled: z.boolean(), stored: z.boolean(),
    degraded: z.boolean().optional(), error: z.string().optional(), createdAt: z.number().optional(), expiresAt: z.number().optional(),
    ageSeconds: z.number().nonnegative().optional(), originalEngine: z.string().optional(), originalModel: z.string().optional() }),
  envelope: z.object({ canonicalContentId: z.string(), sourceIdentity: z.object({ contentHash: z.string(), filename: z.string().optional(), artifactRef: z.string().optional() }) }),
});
type CacheResult = z.infer<typeof cacheResult>;
type Mode = "use" | "refresh" | "bypass";

export function verifyCacheResult(value: unknown, mode: Mode, cached: boolean, stored: boolean): CacheResult {
  const data = cacheResult.parse(value);
  assert.equal(data.cached, cached);
  assert.equal(data.cache.requestedMode, mode);
  assert.equal(data.cache.enabled, true);
  assert.equal(data.cache.stored, stored);
  assert.notEqual(data.cache.degraded, true);
  assert.equal(data.cache.error, undefined);
  if (cached || stored) {
    assert.equal(typeof data.cache.createdAt, "number");
    assert.ok((data.cache.expiresAt ?? 0) > (data.cache.createdAt ?? Infinity));
  }
  if (cached) {
    assert.equal(typeof data.cache.ageSeconds, "number");
    assert.equal(data.cache.originalEngine, "groundlane");
    assert.equal(data.cache.originalModel, "none");
  }
  return data;
}

const success = z.object({ ok: z.literal(true), data: z.unknown() });
const policySchema = z.object({ runtime: z.object({ cacheEnabled: z.boolean(), uploadAvailable: z.boolean(), artifactSourceAvailable: z.boolean() }) });
const intentSchema = z.object({ uploadIntentId: z.string(), upload: z.object({ method: z.literal("PUT"), url: z.string(), headers: z.record(z.string(), z.string()) }) });
const artifactSchema = z.object({ refId: z.string(), verified: z.literal(true), artifactKind: z.literal("source"), contentHash: z.string(), expiresAt: z.number() });

async function main(): Promise<void> {
  if (!process.argv.includes("--run")) {
    console.log("No network or file I/O. Set staging GROUNDLANE_MCP_URL and GROUNDLANE_AUTH_TOKEN; pass --run for controlled cache smoke. JSON evidence goes to stdout; physical cleanup remains pending.");
    return;
  }
  const fixture = `cache-smoke-${randomUUID()}`;
  const evidence: {
    checkedAt: string; fixture: string; endpoint?: string; stage: string; ok: boolean;
    cacheCalls: Array<{ label: string; cached: boolean; cache: CacheResult["cache"]; contentHash: string; canonicalContentId: string }>;
    uploadIntents: string[]; artifacts: Array<z.infer<typeof artifactSchema>>; deletedRefs: string[];
    artifactAcceptance: string; physicalCleanup: string; fullAcceptance: boolean; failure?: string;
  } = { checkedAt: new Date().toISOString(), fixture, stage: "configuration", ok: false, cacheCalls: [], uploadIntents: [], artifacts: [], deletedRefs: [],
    artifactAcceptance: "not_run", physicalCleanup: "pending_external_scheduled_D1_R2_evidence", fullAcceptance: false };
  let client: Client | undefined;
  let connected = false;
  let call: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
  try {
    const endpoint = validateSmokeEndpoint(process.env.GROUNDLANE_MCP_URL ?? "");
    evidence.endpoint = endpoint.toString();
    const token = process.env.GROUNDLANE_AUTH_TOKEN;
    if (!token) throw new Error("Missing credential");
    const sessionSignal = AbortSignal.timeout(300_000);
    const boundedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([
        sessionSignal, AbortSignal.timeout(40_000), ...(init?.signal ? [init.signal] : []),
      ]) });
      if (!response.body) return response;
      let bytes = 0;
      return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 524_288) { controller.error(new Error("MCP response bound exceeded")); return; }
          controller.enqueue(chunk);
        },
      })), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    client = new Client({ name: "groundlane-controlled-cache-smoke", version: "1" });
    const liveClient = client;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: boundedFetch,
    });
    evidence.stage = "initialize";
    await liveClient.connect(transport, { timeout: 40_000, signal: sessionSignal });
    connected = true;
    call = async (name, args) => {
      const result = await liveClient.callTool({ name, arguments: args }, { timeout: 35_000, signal: sessionSignal });
      return success.parse(result.structuredContent).data;
    };
    const tool = call;
    evidence.stage = "document_policy";
    const policy = policySchema.parse(await tool("document_policy", {}));
    assert.equal(policy.runtime.cacheEnabled, true);
    const source = (suffix: string, filename = "fixture.json") => ({ kind: "inline", dataBase64: Buffer.from(JSON.stringify({ fixture, suffix })).toString("base64"), mimeType: "application/json", filename });
    const parse = async (label: string, input: Record<string, unknown>, mode: Mode, cached: boolean, stored: boolean, maxPages = 100) => {
      evidence.stage = label;
      const data = verifyCacheResult(await tool("document_parse", { source: input, output: "text", maxPages, cacheMode: mode, cacheTtlSeconds: 60 }), mode, cached, stored);
      if (cached || stored) assert.ok((data.cache.expiresAt ?? Infinity) - (data.cache.createdAt ?? 0) <= 60_000);
      evidence.cacheCalls.push({ label, cached: data.cached, cache: data.cache, contentHash: data.envelope.sourceIdentity.contentHash, canonicalContentId: data.envelope.canonicalContentId });
      return data;
    };
    const first = await parse("inline_miss", source("primary"), "use", false, true);
    const hit = await parse("inline_hit", source("primary"), "use", true, false);
    assert.equal(hit.cache.createdAt, first.cache.createdAt);
    assert.equal(hit.envelope.canonicalContentId, first.envelope.canonicalContentId);
    const rebound = await parse("inline_rebind", source("primary", "rebound.json"), "use", true, false);
    assert.equal(rebound.envelope.sourceIdentity.filename, "rebound.json");
    assert.equal(rebound.envelope.canonicalContentId, first.envelope.canonicalContentId);
    const refresh = await parse("inline_refresh", source("primary"), "refresh", false, true);
    assert.ok((refresh.cache.createdAt ?? 0) > (first.cache.createdAt ?? Infinity));
    await parse("inline_existing_bypass", source("primary"), "bypass", false, false);
    const retained = await parse("inline_after_bypass", source("primary"), "use", true, false);
    assert.equal(retained.cache.createdAt, refresh.cache.createdAt);
    await parse("inline_fresh_bypass", source("fresh"), "bypass", false, false);
    await parse("inline_after_fresh_bypass_miss", source("fresh"), "use", false, true);
    await parse("inline_after_fresh_bypass_hit", source("fresh"), "use", true, false);

    if (policy.runtime.uploadAvailable && policy.runtime.artifactSourceAvailable) {
      const bytes = Buffer.from(JSON.stringify({ fixture, suffix: "artifacts" }));
      const upload = async (label: string) => {
        evidence.stage = `upload_${label}`;
        const intent = intentSchema.parse(await tool("document_upload_create", { declaredMime: "application/json", declaredSize: bytes.length,
          filename: `${label}.json`, idempotencyKey: `${fixture}-${label}`, artifactTtlSeconds: 600, uploadTtlSeconds: 60 }));
        evidence.uploadIntents.push(intent.uploadIntentId);
        validateUploadEndpoint(intent.upload.url);
        const put = await fetch(intent.upload.url, { method: intent.upload.method, headers: intent.upload.headers, body: bytes,
          redirect: "error", signal: AbortSignal.any([sessionSignal, AbortSignal.timeout(30_000)]) });
        await put.body?.cancel();
        assert.ok(put.ok);
        const artifact = artifactSchema.parse(await tool("document_upload_complete", { uploadIntentId: intent.uploadIntentId }));
        evidence.artifacts.push(artifact);
        return artifact;
      };
      const a = await upload("A");
      const b = await upload("B");
      assert.notEqual(a.refId, b.refId);
      assert.equal(a.contentHash, b.contentHash);
      const artifactSource = (refId: string) => ({ kind: "artifact", refId, artifactKind: "source" });
      const parsedA = await parse("artifact_A_miss", artifactSource(a.refId), "use", false, true);
      const parsedB = await parse("artifact_B_shared_hit", artifactSource(b.refId), "use", true, false);
      assert.equal(parsedA.envelope.sourceIdentity.artifactRef, a.refId);
      assert.equal(parsedB.envelope.sourceIdentity.artifactRef, b.refId);
      assert.ok((parsedA.cache.expiresAt ?? Infinity) <= a.expiresAt);
      assert.ok((parsedB.cache.expiresAt ?? Infinity) <= b.expiresAt);
      await parse("artifact_A_second_option", artifactSource(a.refId), "use", false, true, 99);
      evidence.stage = "artifact_delete_A";
      const deleted = z.object({ refId: z.literal(a.refId), deleted: z.literal(true) }).parse(await tool("document_artifact_delete", { refId: a.refId }));
      evidence.deletedRefs.push(deleted.refId);
      for (const maxPages of [100, 99]) {
        evidence.stage = `artifact_A_revoked_${String(maxPages)}`;
        const result = await liveClient.callTool({ name: "document_parse", arguments: { source: artifactSource(a.refId), output: "text", maxPages, cacheMode: "use" } }, { timeout: 35_000, signal: sessionSignal });
        const rejected = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }).parse(result.structuredContent);
        assert.equal(rejected.error.code, "INVALID_INPUT");
      }
      const survivor = await parse("artifact_B_survives_A_delete", artifactSource(b.refId), "use", true, false);
      assert.equal(survivor.envelope.sourceIdentity.artifactRef, b.refId);
      evidence.artifactAcceptance = "passed_public_delete_and_shared_binding_isolation";
    } else {
      evidence.artifactAcceptance = "skipped_upload_or_artifact_runtime_unavailable";
    }
    evidence.ok = true;
    evidence.stage = "complete";
  } catch {
    // Never serialize SDK/HTTP/schema errors: they can contain auth or handoff data.
    evidence.failure = `Controlled smoke failed at ${evidence.stage}`;
  } finally {
    if (connected && call) {
      for (const artifact of evidence.artifacts) {
        if (evidence.deletedRefs.includes(artifact.refId)) continue;
        try {
          z.object({ refId: z.literal(artifact.refId), deleted: z.literal(true) }).parse(await call("document_artifact_delete", { refId: artifact.refId }));
          evidence.deletedRefs.push(artifact.refId);
        } catch { evidence.ok = false; evidence.failure = "Fixture artifact deletion pending"; }
      }
    }
    await client?.close().catch(() => undefined);
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
