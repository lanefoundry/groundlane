import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { SemanticScholarProvider } from "../adapters/research/semantic-scholar.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

const paperSearchInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Search query for academic papers."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Maximum papers to return. Default: 10."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(9900)
    .default(0)
    .describe("Pagination offset. Default: 0."),
});

const paperLookupInputSchema = z.object({
  paperId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .describe("Semantic Scholar paper ID, DOI, ArXiv ID (e.g. 'ArXiv:2301.00001'), or corpus ID."),
});

const authorSchema = z.object({
  name: z.string(),
  authorId: z.string().nullable(),
});

const refSchema = z.object({
  paperId: z.string(),
  title: z.string(),
});

const paperSchema = z.object({
  paperId: z.string(),
  title: z.string(),
  abstract: z.string().nullable(),
  year: z.number().nullable(),
  venue: z.string().nullable(),
  citationCount: z.number().nullable(),
  authors: z.array(authorSchema),
  tldr: z.string().nullable(),
  externalIds: z.record(z.string(), z.string()).nullable(),
  url: z.string(),
  openAccessPdf: z.string().nullable(),
  fieldsOfStudy: z.array(z.string()).nullable(),
  references: z.array(refSchema).nullable(),
  citations: z.array(refSchema).nullable(),
});

const searchDataSchema = z.object({
  papers: z.array(paperSchema),
  total: z.number().int().nonnegative(),
  engine: z.string(),
});

const lookupDataSchema = paperSchema;

export interface PaperSearchModuleOptions {
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

export function createPaperSearchModule(
  options: PaperSearchModuleOptions,
): McpModule {
  const provider = new SemanticScholarProvider({ timeoutMs: options.requestTimeoutMs });

  return {
    name: "paper_search",
    register(server: McpServer) {
      server.registerTool(
        "paper_search",
        {
          description:
            "Search academic papers on Semantic Scholar. Returns structured metadata including title, abstract, authors, year, venue, citation count, TL;DR summary, external IDs (DOI, ArXiv), open access PDF link, and fields of study. Free, no API key required (1,000 requests/second unauthenticated). Does not provide full-text content.",
          inputSchema: paperSearchInputSchema,
          outputSchema: resultEnvelopeSchema(searchDataSchema),
        },
        async (input, context) => {
          const deadline = new Deadline(options.requestTimeoutMs);
          try {
            const result = await withConcurrency(
              options.limiter,
              deadline,
              context.mcpReq.signal,
              () =>
                withinDeadline(
                  (signal) => provider.search(input.query, signal, input.limit, input.offset),
                  deadline,
                  context.mcpReq.signal,
                  "paper-search",
                ),
            );

            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error, { tool: "paper_search" });
          }
        },
      );

      server.registerTool(
        "paper_lookup",
        {
          description:
            "Look up a specific academic paper by Semantic Scholar ID, DOI, or ArXiv ID. Returns full metadata including references and citations. Free, no API key required. Use paper_search to discover papers first, then paper_lookup for detailed metadata on a specific paper.",
          inputSchema: paperLookupInputSchema,
          outputSchema: resultEnvelopeSchema(lookupDataSchema),
        },
        async (input, context) => {
          const deadline = new Deadline(options.requestTimeoutMs);
          try {
            const result = await withConcurrency(
              options.limiter,
              deadline,
              context.mcpReq.signal,
              () =>
                withinDeadline(
                  (signal) => provider.getPaper(input.paperId, signal),
                  deadline,
                  context.mcpReq.signal,
                  "paper-lookup",
                ),
            );

            return structuredToolResult({ ok: true, data: result });
          } catch (error) {
            return toolError(error, { tool: "paper_lookup" });
          }
        },
      );
    },
  };
}
