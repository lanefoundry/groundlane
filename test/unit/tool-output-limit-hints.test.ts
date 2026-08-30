import assert from "node:assert/strict";
import test from "node:test";

import type {
  SearchResult,
  CrawlResult,
  NewsResult,
  ImagesResult,
  ResearchResult,
  MapResult,
  AnswerResult,
} from "../../src/core/contracts.js";
import { assertSearchOutputWithinLimit } from "../../src/tools/web-search.js";
import { assertCrawlOutputWithinLimit } from "../../src/tools/web-crawl.js";
import { assertImagesOutputWithinLimit } from "../../src/tools/web-images.js";
import { assertNewsOutputWithinLimit } from "../../src/tools/web-news.js";
import { assertResearchOutputWithinLimit } from "../../src/tools/web-research.js";
import { assertMapOutputWithinLimit } from "../../src/tools/web-map.js";
import { assertAnswerOutputWithinLimit } from "../../src/tools/web-answer.js";

function readHint(error: unknown): { code: string; text: string } | undefined {
  if (!(error instanceof Error) || !("hint" in error)) return undefined;
  const hint = (error as { hint?: unknown }).hint;
  if (!hint || typeof hint !== "object") return undefined;
  const obj = hint as { code?: unknown; text?: unknown };
  if (typeof obj.code !== "string" || typeof obj.text !== "string") return undefined;
  return { code: obj.code, text: obj.text };
}

const BIG = "x".repeat(50_000);

void test("web_search OUTPUT_LIMIT carries hint with code + text", () => {
  const result: SearchResult = {
    query: "groundlane",
    provider: "stub",
    results: [{ title: "t", url: "https://example.com", snippet: BIG, provider: "stub" }],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertSearchOutputWithinLimit(result, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) {
      assert.fail("expected GroundlaneError-shaped throw");
    }
    assert.equal((error as { code: string }).code, "OUTPUT_LIMIT");
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "search.output_too_large");
    assert.match(hint.text, /Lower maxOutputChars/);
  }
});

void test("web_crawl OUTPUT_LIMIT carries hint with code + text", () => {
  const huge: CrawlResult = {
    url: "https://example.com",
    strategy: "parallel",
    providersSelected: ["firecrawl"],
    providersAttempted: ["firecrawl"],
    providersSucceeded: ["firecrawl"],
    pages: [{
      url: "https://example.com",
      title: "t",
      content: BIG,
      contentChars: BIG.length,
      truncated: false,
      provider: "firecrawl",
    }],
    providerResults: [],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertCrawlOutputWithinLimit(huge, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) {
      assert.fail("expected GroundlaneError-shaped throw");
    }
    assert.equal((error as { code: string }).code, "OUTPUT_LIMIT");
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "web_crawl.output_too_large");
    assert.match(hint.text, /maxOutputChars/);
  }
});

void test("web_images OUTPUT_LIMIT carries hint with code + text", () => {
  // The assertion compares JSON.stringify length, so stuffing a giant image
  // metadata blob is more reliable than padding provider IDs.
  const huge: ImagesResult = {
    query: "g",
    strategy: "parallel",
    providersSelected: ["brave"],
    providersAttempted: ["brave"],
    providersSucceeded: ["brave"],
    results: [{
      title: "t",
      imageUrl: "https://example.com/a.png",
      sourceUrl: "https://example.com",
      source: BIG,
      provider: "brave",
    }],
    providerResults: [],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertImagesOutputWithinLimit(huge, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "web_images.output_too_large");
    assert.match(hint.text, /maxOutputChars/);
  }
});

void test("web_news OUTPUT_LIMIT carries hint with code + text", () => {
  const huge: NewsResult = {
    query: "g",
    strategy: "parallel",
    providersSelected: ["brave"],
    providersAttempted: ["brave"],
    providersSucceeded: ["brave"],
    results: [{
      title: "t",
      url: "https://example.com",
      snippet: BIG,
      provider: "brave",
    }],
    providerResults: [],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertNewsOutputWithinLimit(huge, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "web_news.output_too_large");
    assert.match(hint.text, /maxOutputChars/);
  }
});

void test("web_research OUTPUT_LIMIT carries hint with code + text", () => {
  const huge: ResearchResult = {
    query: "g",
    effort: "lite",
    strategy: "parallel",
    providersSelected: ["linkup"],
    providersAttempted: ["linkup"],
    providersSucceeded: ["linkup"],
    reports: [{
      provider: "linkup",
      report: BIG,
      citations: [],
      durationMs: 1,
      warnings: [],
    }],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertResearchOutputWithinLimit(huge, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "web_research.output_too_large");
    assert.match(hint.text, /maxOutputChars/);
  }
});

void test("web_map OUTPUT_LIMIT carries hint with code + text", () => {
  const huge: MapResult = {
    url: "https://example.com",
    strategy: "parallel",
    providersSelected: ["firecrawl"],
    providersAttempted: ["firecrawl"],
    providersSucceeded: ["firecrawl"],
    links: [{
      url: "https://example.com",
      title: BIG,
      description: "x",
      provider: "firecrawl",
    }],
    providerResults: [],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertMapOutputWithinLimit(huge, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "web_map.output_too_large");
    assert.match(hint.text, /maxOutputChars/);
  }
});

void test("web_answer OUTPUT_LIMIT carries hint with code + text", () => {
  const huge: AnswerResult = {
    query: "g",
    strategy: "parallel",
    providersSelected: ["you"],
    providersAttempted: ["you"],
    providersSucceeded: ["you"],
    answers: [{
      provider: "you",
      answer: BIG,
      citations: [],
      results: [],
      durationMs: 1,
      warnings: [],
    }],
    durationMs: 1,
    warnings: [],
  };
  try {
    assertAnswerOutputWithinLimit(huge, 1_000);
    assert.fail("expected throw");
  } catch (error) {
    const hint = readHint(error);
    if (!hint) assert.fail("expected hint");
    assert.equal(hint.code, "web_answer.output_too_large");
    assert.match(hint.text, /maxOutputChars/);
  }
});