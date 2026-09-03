import assert from "node:assert/strict";
import test from "node:test";

import { LinkupResearchProvider } from "../../src/adapters/research/linkup.js";
import { ParallelResearchProvider } from "../../src/adapters/research/parallel.js";
import { YouResearchProvider } from "../../src/adapters/research/you.js";
import { GroundlaneError } from "../../src/core/errors.js";

void test("Linkup research submits an async task and polls for sourced output", async () => {
  const requestedUrls: string[] = [];
  const methods: string[] = [];
  const authorizations: string[] = [];
  let body: unknown;
  const provider = new LinkupResearchProvider({
    apiKey: "linkup-secret",
    pollIntervalMs: 1,
    sleep: () => Promise.resolve(),
    fetch: (url, init) => {
      requestedUrls.push(url);
      methods.push(init.method ?? "GET");
      authorizations.push(new Headers(init.headers).get("authorization") ?? "");
      if (init.method === "POST") {
        if (typeof init.body !== "string") throw new Error("expected JSON body");
        body = JSON.parse(init.body) as unknown;
        return Promise.resolve(Response.json({ id: "task_123", status: "pending" }));
      }
      return Promise.resolve(
        Response.json({
          id: "task_123",
          status: "completed",
          output: {
            answer: "Groundlane wraps async research into a bounded sync MCP call.",
            sources: [
              {
                name: "Groundlane",
                url: "https://example.com/groundlane",
                snippet: "bounded sync MCP call",
              },
              {
                name: "Unsafe",
                url: "http://127.0.0.1/private",
                snippet: "secret",
              },
            ],
          },
        }),
      );
    },
    validateUrl: (url) =>
      url.includes("127.0.0.1") ? Promise.reject(new Error("blocked")) : Promise.resolve(),
  });

  const result = await provider.research(
    {
      query: "what is Groundlane?",
      effort: "deep",
      domains: ["Example.COM"],
      timeRange: "month",
      country: "us",
    },
    new AbortController().signal,
  );

  assert.deepEqual(requestedUrls, [
    "https://api.linkup.so/v1/research",
    "https://api.linkup.so/v1/research/task_123",
  ]);
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.deepEqual(authorizations, ["Bearer linkup-secret", "Bearer linkup-secret"]);
  assert.deepEqual(body, {
    q: "what is Groundlane?",
    outputType: "sourcedAnswer",
    mode: "research",
    reasoningDepth: "L",
    includeDomains: ["example.com"],
    freshness: "month",
    country: "US",
  });
  assert.equal(result.provider, "linkup");
  assert.equal(result.report, "Groundlane wraps async research into a bounded sync MCP call.");
  assert.deepEqual(result.citations.map((citation) => citation.url), ["https://example.com/groundlane"]);
  assert.equal(result.citations[0]?.title, "Groundlane");
  assert.deepEqual(result.citations[0]?.excerpts, ["bounded sync MCP call"]);
  assert.match(result.warnings[0] ?? "", /asynchronous upstream/u);
  assert.doesNotMatch(JSON.stringify(result), /linkup-secret/u);
});

void test("You research maps the official research endpoint and source controls", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let body: unknown;
  const provider = new YouResearchProvider({
    apiKey: "you-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        Response.json({
          output: {
            content: "Groundlane exposes bounded web tools [[1]].",
            content_type: "text",
            sources: [
              {
                title: "Groundlane",
                url: "https://example.com/groundlane",
                snippets: ["bounded web tools"],
              },
              {
                title: "Unsafe",
                url: "http://127.0.0.1/private",
                snippets: ["secret"],
              },
            ],
          },
        }),
      );
    },
    validateUrl: (url) =>
      url.includes("127.0.0.1") ? Promise.reject(new Error("blocked")) : Promise.resolve(),
  });

  const result = await provider.research(
    {
      query: "what is Groundlane?",
      effort: "deep",
      domains: ["Example.COM"],
      timeRange: "week",
      country: "us",
    },
    new AbortController().signal,
  );

  assert.equal(requestedUrl, "https://api.you.com/v1/research");
  assert.equal(apiKey, "you-secret");
  assert.deepEqual(body, {
    input: "what is Groundlane?",
    research_effort: "deep",
    source_control: {
      include_domains: ["example.com"],
      freshness: "week",
      country: "US",
    },
  });
  assert.equal(result.provider, "you");
  assert.equal(result.report, "Groundlane exposes bounded web tools [[1]].");
  assert.deepEqual(result.citations.map((citation) => citation.url), ["https://example.com/groundlane"]);
  assert.equal(result.citations[0]?.title, "Groundlane");
  assert.deepEqual(result.citations[0]?.excerpts, ["bounded web tools"]);
  assert.doesNotMatch(JSON.stringify(result), /you-secret/u);
});

void test("Parallel research maps Responses API and OpenAI-style citation annotations", async () => {
  let requestedUrl = "";
  let authorization = "";
  let body: unknown;
  const provider = new ParallelResearchProvider({
    apiKey: "parallel-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      authorization = new Headers(init.headers).get("authorization") ?? "";
      if (typeof init.body !== "string") throw new Error("expected JSON body");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        Response.json({
          output_text: "Groundlane is a web research layer.",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Groundlane is a web research layer.",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://example.com/groundlane",
                      title: "Groundlane",
                      start_index: 0,
                      end_index: 10,
                    },
                    {
                      type: "url_citation",
                      url: "http://127.0.0.1/private",
                      title: "Unsafe",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
    },
    validateUrl: (url) =>
      url.includes("127.0.0.1") ? Promise.reject(new Error("blocked")) : Promise.resolve(),
  });

  const result = await provider.research(
    { query: "what is Groundlane?", effort: "lite" },
    new AbortController().signal,
  );

  assert.equal(requestedUrl, "https://api.parallel.ai/v1/responses");
  assert.equal(authorization, "Bearer parallel-secret");
  assert.deepEqual(body, {
    model: "parallel",
    input: "what is Groundlane?",
    reasoning: { effort: "low" },
  });
  assert.equal(result.provider, "parallel");
  assert.equal(result.report, "Groundlane is a web research layer.");
  assert.deepEqual(result.citations.map((citation) => citation.url), ["https://example.com/groundlane"]);
  assert.equal(result.citations[0]?.title, "Groundlane");
  assert.deepEqual(result.citations[0]?.excerpts, ["Groundlane"]);
  assert.doesNotMatch(JSON.stringify(result), /parallel-secret/u);
});

void test("Parallel research does not claim unsupported source filters", () => {
  const provider = new ParallelResearchProvider({
    apiKey: "parallel-secret",
    fetch: () => Promise.resolve(Response.json({ output_text: "unused" })),
  });

  assert.equal(provider.supports({ query: "q", effort: "standard" }), true);
  assert.equal(provider.supports({ query: "q", effort: "standard", domains: ["example.com"] }), false);
  assert.equal(provider.supports({ query: "q", effort: "standard", timeRange: "day" }), false);
});

void test("Linkup research supports one source filter family at a time", () => {
  const provider = new LinkupResearchProvider({
    apiKey: "linkup-secret",
    fetch: () => Promise.resolve(Response.json({ id: "unused" })),
  });

  assert.equal(provider.supports({ query: "q", effort: "standard" }), true);
  assert.equal(provider.supports({ query: "q", effort: "standard", domains: ["example.com"] }), true);
  assert.equal(provider.supports({ query: "q", effort: "standard", excludeDomains: ["example.com"] }), true);
  assert.equal(
    provider.supports({
      query: "q",
      effort: "standard",
      domains: ["example.com"],
      excludeDomains: ["example.org"],
    }),
    false,
  );
});

void test("Linkup research maps failed async tasks to retryable upstream errors", async () => {
  const provider = new LinkupResearchProvider({
    apiKey: "linkup-secret",
    pollIntervalMs: 1,
    sleep: () => Promise.resolve(),
    fetch: (url, init) => {
      if (init.method === "POST") return Promise.resolve(Response.json({ id: "task_failed" }));
      return Promise.resolve(Response.json({ id: "task_failed", status: "failed", error: "secret details" }));
    },
  });

  await assert.rejects(
    provider.research({ query: "q", effort: "standard" }, new AbortController().signal),
    /Linkup research task failed/u,
  );
});

void test("Linkup research cancellation during polling loop", async () => {
  const controller = new AbortController();
  let pollCount = 0;
  const provider = new LinkupResearchProvider({
    apiKey: "linkup-secret",
    pollIntervalMs: 1,
    sleep: (_ms, signal) => {
      if (signal.aborted) {
        return Promise.reject(
          new GroundlaneError("CANCELLED", "web_research", "Research request was cancelled"),
        );
      }
      return Promise.resolve();
    },
    fetch: (_url, init) => {
      if (init.method === "POST") {
        return Promise.resolve(Response.json({ id: "task_poll" }));
      }
      pollCount++;
      if (pollCount >= 2) controller.abort();
      return Promise.resolve(Response.json({ id: "task_poll", status: "pending" }));
    },
  });

  await assert.rejects(
    provider.research({ query: "q", effort: "standard" }, controller.signal),
    { code: "CANCELLED" },
  );
});

void test("Research providers reject malformed reports", async () => {
  await assert.rejects(
    new LinkupResearchProvider({
      apiKey: "linkup-secret",
      fetch: (url, init) =>
        Promise.resolve(init.method === "POST"
          ? Response.json({ id: "task_bad" })
          : Response.json({ id: "task_bad", status: "completed", output: { sources: [] } })),
      sleep: () => Promise.resolve(),
    }).research({ query: "q", effort: "standard" }, new AbortController().signal),
    /malformed research report/u,
  );
  await assert.rejects(
    new YouResearchProvider({
      apiKey: "you-secret",
      fetch: () => Promise.resolve(Response.json({ output: { sources: [] } })),
    }).research({ query: "q", effort: "standard" }, new AbortController().signal),
    /malformed research report/u,
  );
  await assert.rejects(
    new ParallelResearchProvider({
      apiKey: "parallel-secret",
      fetch: () => Promise.resolve(Response.json({ output: [] })),
    }).research({ query: "q", effort: "standard" }, new AbortController().signal),
    /malformed research report/u,
  );
});
