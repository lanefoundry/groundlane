import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { z } from "zod";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createGroundlaneServices } from "../src/composition.js";
import { parseConfig } from "../src/config.js";
import { createContainerApp } from "../src/container/app.js";

const querySchema = z.object({
  id: z.string(),
  category: z.string(),
  query: z.string(),
  expectedUrls: z.array(z.string()),
  expectedFragments: z.array(z.string()),
});

const corpusSchema = z.object({
  schemaVersion: z.number(),
  queries: z.array(querySchema),
});

const args = process.argv.slice(2).filter((a) => a !== "--");
const fixtureFile = args[0] ?? "test/fixtures/search/queries.json";
const providerArg = args[1];

const corpus = corpusSchema.parse(
  JSON.parse(await readFile(resolve(fixtureFile), "utf8")),
);

const authToken = process.env.GROUNDLANE_AUTH_TOKEN ?? "benchmark-local-token";
const config = parseConfig({
  ...process.env as Record<string, string>,
  GROUNDLANE_AUTH_TOKEN: authToken,
  BROWSER_BACKEND: "disabled",
});
const services = createGroundlaneServices(config);
const server: Server = createServer(
  createContainerApp({ authToken, registryFactory: services.registryFactory }),
);

await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("Failed to bind");
const port = address.port;

const client = new Client({ name: "benchmark-search", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${authToken}` } },
  }),
);

interface QueryResult {
  id: string;
  category: string;
  query: string;
  provider: string;
  urlRecall: number;
  fragmentRecall: number;
  resultCount: number;
  durationMs: number;
  error?: string;
}

const results: QueryResult[] = [];
const durations: number[] = [];

for (const q of corpus.queries) {
  const start = performance.now();
  try {
    const raw = await client.callTool({
      name: "web_search",
      arguments: {
        query: q.query,
        maxResults: 5,
        ...(providerArg ? { provider: providerArg } : {}),
      },
    });
    const elapsed = performance.now() - start;
    durations.push(elapsed);

    const envelope = raw.structuredContent as {
      ok?: boolean;
      data?: {
        results?: Array<{ url?: string; title?: string; snippet?: string }>;
        provider?: string;
      };
    } | undefined;

    const searchResults = envelope?.data?.results ?? [];
    const provider = envelope?.data?.provider ?? providerArg ?? "unknown";

    const resultUrls = searchResults.map((r) => r.url ?? "");
    const resultText = searchResults
      .map((r) => `${r.title ?? ""} ${r.snippet ?? ""}`)
      .join(" ")
      .toLowerCase();

    const urlHits = q.expectedUrls.filter((eu) =>
      resultUrls.some((ru) => ru.includes(eu) || eu.includes(ru)),
    );
    const fragmentHits = q.expectedFragments.filter((f) =>
      resultText.includes(f.toLowerCase()),
    );

    results.push({
      id: q.id,
      category: q.category,
      query: q.query,
      provider,
      urlRecall:
        q.expectedUrls.length === 0
          ? 1
          : urlHits.length / q.expectedUrls.length,
      fragmentRecall:
        q.expectedFragments.length === 0
          ? 1
          : fragmentHits.length / q.expectedFragments.length,
      resultCount: searchResults.length,
      durationMs: Math.round(elapsed),
    });
  } catch (err) {
    const elapsed = performance.now() - start;
    durations.push(elapsed);
    results.push({
      id: q.id,
      category: q.category,
      query: q.query,
      provider: providerArg ?? "auto",
      urlRecall: 0,
      fragmentRecall: 0,
      resultCount: 0,
      durationMs: Math.round(elapsed),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

await client.close();
server.closeAllConnections();
await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
await services.close();

const successful = results.filter((r) => r.error === undefined);
const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return Math.round(sorted[index] ?? 0);
};

const output = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  corpus: {
    fixtureFile: resolve(fixtureFile),
    queryCount: corpus.queries.length,
    provider: providerArg ?? "auto",
  },
  environment: {
    node: process.version,
    platform: `${platform()} ${release()}`,
    architecture: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
  },
  summary: {
    avgUrlRecall:
      successful.length === 0
        ? 0
        : successful.reduce((s, r) => s + r.urlRecall, 0) / successful.length,
    avgFragmentRecall:
      successful.length === 0
        ? 0
        : successful.reduce((s, r) => s + r.fragmentRecall, 0) /
          successful.length,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    errors: results.filter((r) => r.error !== undefined).length,
    successful: successful.length,
  },
  queries: results,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
