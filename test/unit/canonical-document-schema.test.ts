import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalEnvelopeFromAdapter, projectCanonicalDocument } from "../../src/core/canonical-document.js";
import { canonicalEnvelopeSchema, parseCanonicalDocumentEnvelope } from "../../src/core/canonical-document-schema.js";

function fixture() {
  return buildCanonicalEnvelopeFromAdapter({ documentId: "document", sourceIdentity: { contentHash: "digest" },
    blocks: [{ type: "text", blockId: "body", content: "hello", spans: [{ kind: "char-offset", start: 0, end: 5, contentHash: "digest" }] }],
    readingOrder: ["body"], status: "success", capabilityStates: { text: "available" },
    provenance: { engine: "test", model: "none", version: "1", cost: null, confidence: null },
  });
}

void test("shared canonical wire decoder preserves envelope and deterministic default projection", () => {
  const original = fixture();
  const parsed = parseCanonicalDocumentEnvelope(JSON.parse(JSON.stringify(original)) as unknown);
  assert.deepEqual(parsed, original);
  assert.deepEqual(projectCanonicalDocument(parsed, "markdown"), projectCanonicalDocument(original, "markdown"));
  assert.equal(parsed.provenance.cost, null);
});

void test("shared canonical decoder rejects malformed wire values and extra provider raw fields", () => {
  for (const value of [null, [], {}, { ...fixture(), rawProviderBody: "private" },
    { ...fixture(), blocks: [{ type: "invented", blockId: "body" }] },
    { ...fixture(), provenance: { ...fixture().provenance, cost: Infinity } }]) {
    assert.throws(() => parseCanonicalDocumentEnvelope(value));
  }
});

void test("shared canonical decoder checks invariants beyond its wire schema", () => {
  const wrongOrder = { ...fixture(), readingOrder: ["missing"] };
  assert.equal(canonicalEnvelopeSchema.safeParse(wrongOrder).success, true);
  assert.throws(() => parseCanonicalDocumentEnvelope(wrongOrder));
  assert.throws(() => parseCanonicalDocumentEnvelope({ ...fixture(), blocks: [
    { type: "text", blockId: "body", content: "hello", spans: [{ kind: "char-offset", start: 5, end: 1, contentHash: "digest" }] },
  ] }));
});

void test("shared canonical decoder removes explicit undefined optional fields without unsafe persisted shape", () => {
  const parsed = parseCanonicalDocumentEnvelope({ ...fixture(), metadata: undefined,
    sourceIdentity: { contentHash: "digest", url: undefined } });
  assert.equal(Object.hasOwn(parsed, "metadata"), false);
  assert.equal(Object.hasOwn(parsed.sourceIdentity, "url"), false);
});
