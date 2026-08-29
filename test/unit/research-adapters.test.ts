import assert from "node:assert/strict";
import test from "node:test";

import { ParallelResearchProvider } from "../../src/adapters/research/parallel.js";
import { YouResearchProvider } from "../../src/adapters/research/you.js";

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

void test("Research providers reject malformed reports", async () => {
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
