import assert from "node:assert/strict";
import test from "node:test";

import { SemanticScholarProvider } from "../../src/adapters/research/semantic-scholar.js";
import { GroundlaneError } from "../../src/core/errors.js";

void test("paper search: rejects empty query", async () => {
  const provider = new SemanticScholarProvider({ timeoutMs: 5_000 });
  await assert.rejects(
    () => provider.search("", AbortSignal.timeout(5_000)),
    (error: unknown) => {
      assert.ok(error instanceof GroundlaneError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );
});

void test("paper search: rejects whitespace-only query", async () => {
  const provider = new SemanticScholarProvider({ timeoutMs: 5_000 });
  await assert.rejects(
    () => provider.search("   ", AbortSignal.timeout(5_000)),
    (error: unknown) => {
      assert.ok(error instanceof GroundlaneError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );
});

void test("paper lookup: rejects empty paperId", async () => {
  const provider = new SemanticScholarProvider({ timeoutMs: 5_000 });
  await assert.rejects(
    () => provider.getPaper("", AbortSignal.timeout(5_000)),
    (error: unknown) => {
      assert.ok(error instanceof GroundlaneError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    },
  );
});

void test("paper search: handles mock search response", async () => {
  const mockResponse = {
    total: 1,
    data: [
      {
        paperId: "abc123",
        title: "Attention Is All You Need",
        abstract: "The dominant sequence transduction models...",
        year: 2017,
        venue: "NeurIPS",
        citationCount: 100000,
        authors: [{ name: "Ashish Vaswani", authorId: "a1" }],
        tldr: { text: "Introduces the Transformer architecture." },
        externalIds: { DOI: "10.5555/3295222.3295349", ArXiv: "1706.03762" },
        url: "https://www.semanticscholar.org/paper/abc123",
        openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762" },
        fieldsOfStudy: ["Computer Science"],
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const provider = new SemanticScholarProvider({ timeoutMs: 5_000 });
    const result = await provider.search("attention transformer", AbortSignal.timeout(5_000));
    assert.equal(result.total, 1);
    assert.equal(result.papers.length, 1);
    assert.equal(result.papers[0]?.paperId, "abc123");
    assert.equal(result.papers[0]?.title, "Attention Is All You Need");
    assert.equal(result.papers[0]?.year, 2017);
    assert.equal(result.papers[0]?.citationCount, 100000);
    assert.equal(result.papers[0]?.authors[0]?.name, "Ashish Vaswani");
    assert.equal(result.papers[0]?.tldr, "Introduces the Transformer architecture.");
    assert.equal(result.papers[0]?.openAccessPdf, "https://arxiv.org/pdf/1706.03762");
    assert.deepEqual(result.papers[0]?.fieldsOfStudy, ["Computer Science"]);
    assert.equal(result.engine, "semantic-scholar-api");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("paper search: handles 429 rate limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("rate limited", { status: 429 });

  try {
    const provider = new SemanticScholarProvider({ timeoutMs: 5_000 });
    await assert.rejects(
      () => provider.search("test", AbortSignal.timeout(5_000)),
      (error: unknown) => {
        assert.ok(error instanceof GroundlaneError);
        assert.equal(error.code, "RATE_LIMITED");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("paper lookup: handles mock paper response with references and citations", async () => {
  const mockPaper = {
    paperId: "def456",
    title: "BERT",
    abstract: "Language model pretraining...",
    year: 2019,
    venue: "NAACL",
    citationCount: 80000,
    authors: [{ name: "Jacob Devlin", authorId: "a2" }],
    tldr: null,
    externalIds: null,
    url: "https://www.semanticscholar.org/paper/def456",
    openAccessPdf: null,
    fieldsOfStudy: null,
    references: [
      { paperId: "abc123", title: "Attention Is All You Need" },
    ],
    citations: [
      { paperId: "ghi789", title: "RoBERTa" },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(mockPaper), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const provider = new SemanticScholarProvider({ timeoutMs: 5_000 });
    const result = await provider.getPaper("def456", AbortSignal.timeout(5_000));
    assert.equal(result.paperId, "def456");
    assert.equal(result.title, "BERT");
    assert.equal(result.tldr, null);
    assert.ok(result.references !== null);
    assert.equal(result.references!.length, 1);
    assert.equal(result.references![0]?.title, "Attention Is All You Need");
    assert.ok(result.citations !== null);
    assert.equal(result.citations!.length, 1);
    assert.equal(result.citations![0]?.title, "RoBERTa");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("paper lookup: handles 404 as INVALID_INPUT", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("not found", { status: 404 });

  try {
    const provider = new SemanticScholarProvider({ timeoutMs: 5_000 });
    await assert.rejects(
      () => provider.getPaper("nonexistent", AbortSignal.timeout(5_000)),
      (error: unknown) => {
        assert.ok(error instanceof GroundlaneError);
        assert.equal(error.code, "INVALID_INPUT");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
