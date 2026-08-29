import assert from "node:assert/strict";
import test from "node:test";

import { BraveImagesProvider } from "../../src/adapters/images/brave.js";
import { SerperImagesProvider } from "../../src/adapters/images/serper.js";
import { SerpApiImagesProvider } from "../../src/adapters/images/serpapi.js";

const signal = new AbortController().signal;

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error("expected string body");
  return JSON.parse(body) as unknown;
}

void test("Brave images maps the Image Search endpoint", async () => {
  let requestedUrl = "";
  let token = "";
  const provider = new BraveImagesProvider({
    apiKey: "brave-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      token = new Headers(init.headers).get("x-subscription-token") ?? "";
      return Promise.resolve(
        Response.json({
          results: [
            {
              title: "Brave image",
              url: "https://example.com/page",
              source: "Example",
              properties: {
                url: "https://images.example.com/a.jpg",
                width: 640,
                height: 480,
              },
              thumbnail: { src: "https://images.example.com/a-thumb.jpg" },
            },
          ],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.images(
    { query: "ai", maxResults: 3, safeSearch: "strict", country: "tw", language: "en" },
    signal,
  );

  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/images/search");
  assert.equal(url.searchParams.get("q"), "ai");
  assert.equal(url.searchParams.get("count"), "3");
  assert.equal(url.searchParams.get("country"), "TW");
  assert.equal(url.searchParams.get("safesearch"), "strict");
  assert.equal(token, "brave-secret");
  assert.equal(result.results[0]?.imageUrl, "https://images.example.com/a.jpg");
  assert.equal(result.results[0]?.sourceUrl, "https://example.com/page");
  assert.equal(result.results[0]?.thumbnailUrl, "https://images.example.com/a-thumb.jpg");
  assert.equal(result.results[0]?.width, 640);
  assert.doesNotMatch(JSON.stringify(result), /brave-secret/u);
});

void test("Serper images maps google.serper.dev/images", async () => {
  let requestedUrl = "";
  let apiKey = "";
  let body: unknown;
  const provider = new SerperImagesProvider({
    apiKey: "serper-secret",
    fetch: (url, init) => {
      requestedUrl = url;
      apiKey = new Headers(init.headers).get("x-api-key") ?? "";
      body = parseBody(init.body);
      return Promise.resolve(
        Response.json({
          images: [
            {
              title: "Serper image",
              imageUrl: "https://images.example.com/b.jpg",
              link: "https://example.com/b",
              thumbnailUrl: "https://images.example.com/b-thumb.jpg",
              source: "Example",
              imageWidth: 800,
              imageHeight: 600,
              thumbnailWidth: 120,
              thumbnailHeight: 90,
            },
          ],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.images(
    { query: "ai", maxResults: 5, country: "us", language: "en" },
    signal,
  );

  assert.equal(requestedUrl, "https://google.serper.dev/images");
  assert.equal(apiKey, "serper-secret");
  assert.deepEqual(body, { q: "ai", num: 5, gl: "us", hl: "en", autocorrect: true });
  assert.equal(result.results[0]?.source, "Example");
  assert.equal(result.results[0]?.thumbnailHeight, 90);
  assert.doesNotMatch(JSON.stringify(result), /serper-secret/u);
});

void test("SerpApi images maps google_images", async () => {
  let requestedUrl = "";
  const provider = new SerpApiImagesProvider({
    apiKey: "serpapi-secret",
    fetch: (url) => {
      requestedUrl = url;
      return Promise.resolve(
        Response.json({
          images_results: [
            {
              title: "SerpApi image",
              original: "https://images.example.com/c.jpg",
              link: "https://example.com/c",
              thumbnail: "https://images.example.com/c-thumb.jpg",
              source: "Example",
              original_width: 1024,
              original_height: 768,
            },
          ],
        }),
      );
    },
    validateUrl: () => Promise.resolve(),
  });
  const result = await provider.images(
    { query: "ai", maxResults: 5, safeSearch: "off", country: "us", language: "en" },
    signal,
  );

  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "https://serpapi.com/search.json");
  assert.equal(url.searchParams.get("engine"), "google_images");
  assert.equal(url.searchParams.get("q"), "ai");
  assert.equal(url.searchParams.get("api_key"), "serpapi-secret");
  assert.equal(url.searchParams.get("safe"), "off");
  assert.equal(result.results[0]?.title, "SerpApi image");
  assert.equal(result.results[0]?.height, 768);
  assert.doesNotMatch(JSON.stringify(result), /serpapi-secret/u);
});

void test("image adapters validate provider-returned image, thumbnail, and source URLs", async () => {
  const validated: string[] = [];
  const provider = new SerperImagesProvider({
    apiKey: "serper-secret",
    fetch: () =>
      Promise.resolve(
        Response.json({
          images: [
            {
              title: "Valid image",
              imageUrl: "https://images.example.com/valid.jpg",
              link: "https://example.com/valid",
              thumbnailUrl: "https://images.example.com/valid-thumb.jpg",
            },
            {
              title: "Unsafe source",
              imageUrl: "https://images.example.com/unsafe.jpg",
              link: "http://127.0.0.1/private",
            },
          ],
        }),
      ),
    validateUrl: (url) => {
      validated.push(url);
      if (url.includes("127.0.0.1")) return Promise.reject(new Error("unsafe"));
      return Promise.resolve();
    },
  });

  const result = await provider.images({ query: "ai", maxResults: 10 }, signal);

  assert.deepEqual(
    result.results.map((item) => item.title),
    ["Valid image"],
  );
  assert.deepEqual(validated, [
    "https://images.example.com/valid.jpg",
    "https://example.com/valid",
    "https://images.example.com/valid-thumb.jpg",
    "https://images.example.com/unsafe.jpg",
    "http://127.0.0.1/private",
  ]);
});
