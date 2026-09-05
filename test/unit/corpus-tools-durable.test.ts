import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteCorpusDerivedIndex } from "../../src/adapters/state/sqlite-corpus-index.js";
import { SqliteDurableRecordStore } from "../../src/adapters/state/sqlite-durable-store.js";
import { SqliteImmutableBlobStore } from "../../src/adapters/state/sqlite-immutable-blob.js";
import { DurableCorpusRuntime, ImmutableBlobCorpusSourceArtifacts } from "../../src/core/durable-corpus-runtime.js";
import { DurableCorpusRepository } from "../../src/core/durable-corpora.js";
import { ConcurrencyLimiter } from "../../src/core/limits.js";
import { createMcpRegistry } from "../../src/mcp/registry.js";
import { createCorpusToolsModule } from "../../src/tools/corpus-tools.js";

type RegisteredHandler = (input: Record<string, unknown>, extra: { signal?: AbortSignal }) => unknown;
type SdkRegisteredHandler = (
  input: Record<string, unknown>,
  ctx: { mcpReq: { signal?: AbortSignal } },
) => unknown;

void test("corpus tools use the authenticated durable caller and require actual enrollment content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "groundlane-corpus-tools-"));
  const path = join(directory, "state.sqlite");
  const records = new SqliteDurableRecordStore(path, "corpora-v1");
  const blobs = new SqliteImmutableBlobStore(path, "corpus-source-blobs-v1");
  const index = new SqliteCorpusDerivedIndex(path, "corpus-index-v1");
  const runtime = new DurableCorpusRuntime({
    repository: new DurableCorpusRepository(records),
    artifacts: new ImmutableBlobCorpusSourceArtifacts(blobs),
    index,
    idFactory: () => "12345678-1234-4234-8234-123456789abc",
  });
  const handlers = new Map<string, RegisteredHandler>();
  const server = {
    registerTool(name: string, _definition: unknown, handler: SdkRegisteredHandler): void {
      handlers.set(name, (input, extra) => handler(input, { mcpReq: extra }));
    },
  };
  await createMcpRegistry([createCorpusToolsModule({
    runtime,
    caller: {
      tenantId: "deployment-a",
      ownerId: "owner",
      credentialBinding: "managed:credential-a",
      roles: ["role:reader", "role:writer"],
    },
    limiter: new ConcurrencyLimiter(1, 1),
    requestTimeoutMs: 5_000,
    maxOutputChars: 10_000,
  })]).registerAll(server as never);
  const create = handlers.get("corpus_create");
  const enroll = handlers.get("corpus_enroll");
  assert.ok(create);
  assert.ok(enroll);
  const createResult = await create({ displayName: "Durable tool path" }, { signal: new AbortController().signal });
  const createEnvelope = (createResult as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: { corpus?: { corpusId?: string } };
  };
  assert.equal(createEnvelope.ok, true);
  const corpusId = createEnvelope.data?.corpus?.corpusId;
  assert.ok(corpusId);

  const missingContent = await enroll({
    corpusId,
    sourceId: "caller-claim",
    contentHash: "caller-only-hash",
    acl: ["role:reader"],
    retentionPolicy: "operator-default",
    deletionPolicy: "operator-default",
    lifecycleProvenance: "operator-asserted",
    citationProvenance: "operator-asserted",
    backendProvenance: "operator-asserted",
  }, { signal: new AbortController().signal });
  assert.equal(((missingContent as { structuredContent?: { ok?: boolean } }).structuredContent?.ok), false);

  const enrolled = await enroll({
    corpusId,
    content: "verified normalized bytes",
    acl: ["role:reader"],
    retentionPolicy: "operator-default",
    deletionPolicy: "operator-default",
    lifecycleProvenance: "operator-asserted",
    citationProvenance: "normalized-text-v1",
    backendProvenance: "operator-asserted",
  }, { signal: new AbortController().signal });
  const enrollment = (enrolled as { structuredContent?: unknown }).structuredContent as {
    ok?: boolean;
    data?: { enrollment?: { contentHash?: string } };
  };
  assert.equal(enrollment.ok, true);
  assert.match(enrollment.data?.enrollment?.contentHash ?? "", /^sha256-[a-f0-9]{64}$/u);
  records.close();
  blobs.close();
  index.close();
});
