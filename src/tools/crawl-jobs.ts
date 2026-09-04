import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CrawlJobManager } from "../core/crawl-jobs.js";
import { Deadline, type ConcurrencyLimiter, withinDeadline } from "../core/limits.js";
import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError, withConcurrency } from "./common.js";

// V1 single-tenant mapping (PRD 5.1.1): every MCP caller acts as the same
// operator `owner`. Callers never supply principal/tenant identifiers.
const MCP_OWNER_ID = "owner";
const MCP_CREDENTIAL_BINDING = "container:mcp";

const budgetsSchema = z.object({
  maxPages: z.number().int().min(1).max(1_000).default(100),
  maxBytes: z.number().int().min(1).max(50_000_000).default(5_000_000),
  maxOutputChars: z.number().int().min(1).max(500_000).default(100_000),
});

const crawlCreateInputSchema = z.object({
  seedUrl: z.string().trim().url().max(2_048),
  budgets: budgetsSchema.optional(),
  ttlSeconds: z.number().int().min(60).max(86_400).default(3_600),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

const crawlJobRefSchema = z.object({
  groundlaneJobId: z.string().trim().min(1).max(128),
  timeoutMs: z.number().int().min(1_000).max(150_000).optional(),
});

const crawlResultInputSchema = crawlJobRefSchema.extend({
  cursor: z.string().trim().min(1).max(64).optional(),
  pageSize: z.number().int().min(1).max(100).default(20),
});

const crawlCancelInputSchema = crawlJobRefSchema.extend({
  kind: z.enum(["caller", "groundlane", "upstream"]).default("caller"),
});

const crawlJobDataSchema = z.object({
  groundlaneJobId: z.string(),
  ownerId: z.string(),
  status: z.string(),
  expiresAt: z.string(),
  budgets: z.object({
    maxPages: z.number().int(),
    maxBytes: z.number().int(),
    maxOutputChars: z.number().int(),
  }),
  createdAt: z.string(),
  paginationCursor: z.string().nullable(),
  partialResults: z.array(z.object({
    url: z.string(),
    contentChars: z.number().int(),
    fetchedAt: z.string(),
  })),
  totalPages: z.number().int(),
  totalBytes: z.number().int(),
  totalOutputChars: z.number().int(),
  droppedUpstreamUrls: z.number().int(),
  callerCancelled: z.boolean(),
  groundlanePollingCancelled: z.boolean(),
  upstreamCancelRequested: z.boolean(),
  upstreamCancelled: z.boolean(),
  billingProvenance: z.object({
    providerId: z.string(),
    inputUnits: z.number(),
    outputUnits: z.number(),
    billedAt: z.string().nullable(),
  }),
  sanitizedError: z.string().nullable(),
});

export interface CrawlJobsModuleOptions {
  manager: CrawlJobManager;
  limiter: ConcurrencyLimiter;
  requestTimeoutMs: number;
  maxOutputChars: number;
}

function assertWithinOutputLimit(value: unknown, maxOutputChars: number, tool: string): void {
  if (Array.from(JSON.stringify(value)).length > maxOutputChars) {
    throw new Error(
      `${tool} output exceeds the configured limit; narrow budgets or page size`,
    );
  }
}

/**
 * Provider-neutral durable crawl job surface (PRD 644). Groundlane-issued
 * job IDs only; the provider job ID never crosses this boundary. Without a
 * configured provider adapter, jobs track lifecycle against an empty
 * upstream (ingest drains immediately); upstream cancel without provider
 * acknowledgment is recorded but never reported as upstream-cancelled.
 */
export function createCrawlJobsModule(options: CrawlJobsModuleOptions): McpModule {
  const caller = { ownerId: MCP_OWNER_ID, credentialBinding: MCP_CREDENTIAL_BINDING };
  return {
    name: "crawl_jobs",
    register(server: McpServer): void {
      server.registerTool(
        "crawl_create",
        {
          description:
            "Create a provider-neutral durable crawl job with page/byte/output budgets and expiry. Returns a Groundlane-issued job ID; provider job IDs are never exposed.",
          inputSchema: crawlCreateInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            job: crawlJobDataSchema,
            reused: z.boolean(),
          })),
          annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const data = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  () =>
                    Promise.resolve(options.manager.create({
                      ownerId: caller.ownerId,
                      credentialBinding: caller.credentialBinding,
                      seedUrl: input.seedUrl,
                      budgets: {
                        maxPages: input.budgets?.maxPages ?? 100,
                        maxBytes: input.budgets?.maxBytes ?? 5_000_000,
                        maxOutputChars: input.budgets?.maxOutputChars ?? 100_000,
                      },
                      ttlSeconds: input.ttlSeconds,
                      ...(input.idempotencyKey === undefined
                        ? {}
                        : { idempotencyKey: input.idempotencyKey }),
                    })),
                  deadline,
                  extra.signal,
                  "crawl_create",
                ),
            );
            assertWithinOutputLimit(data, options.maxOutputChars, "crawl_create");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "crawl_create" });
          }
        },
      );

      server.registerTool(
        "crawl_status",
        {
          description:
            "Read the status of a durable crawl job owned by this operator. Unknown, expired, or foreign jobs are rejected.",
          inputSchema: crawlJobRefSchema,
          outputSchema: resultEnvelopeSchema(z.object({ job: crawlJobDataSchema })),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const job = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  () => Promise.resolve(options.manager.status(input.groundlaneJobId, caller)),
                  deadline,
                  extra.signal,
                  "crawl_status",
                ),
            );
            assertWithinOutputLimit({ job }, options.maxOutputChars, "crawl_status");
            return structuredToolResult({ ok: true, data: { job } });
          } catch (error) {
            return toolError(error, { tool: "crawl_status" });
          }
        },
      );

      server.registerTool(
        "crawl_result",
        {
          description:
            "Read one paginated page of a crawl job's partial results. Read-only: paging never mutates budgets, totals, or lifecycle.",
          inputSchema: crawlResultInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            job: crawlJobDataSchema,
            items: z.array(z.object({
              url: z.string(),
              contentChars: z.number().int(),
              fetchedAt: z.string(),
            })),
            nextCursor: z.string().nullable(),
          })),
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const data = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  () =>
                    Promise.resolve(options.manager.result(input.groundlaneJobId, caller, {
                      pageSize: input.pageSize,
                      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                    })),
                  deadline,
                  extra.signal,
                  "crawl_result",
                ),
            );
            assertWithinOutputLimit(data, options.maxOutputChars, "crawl_result");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "crawl_result" });
          }
        },
      );

      server.registerTool(
        "crawl_cancel",
        {
          description:
            "Cancel a durable crawl job. Caller-stop-wait and Groundlane-polling-stop apply immediately; upstream cancel without provider acknowledgment is recorded but never reported as upstream-cancelled.",
          inputSchema: crawlCancelInputSchema,
          outputSchema: resultEnvelopeSchema(z.object({
            job: crawlJobDataSchema,
            cancelResult: z.object({
              callerCancelled: z.boolean(),
              groundlanePollingCancelled: z.boolean(),
              upstreamCancelled: z.boolean(),
            }).passthrough(),
          })),
          annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async (input, extra) => {
          const deadline = new Deadline(input.timeoutMs ?? options.requestTimeoutMs);
          try {
            const data = await withConcurrency(
              options.limiter,
              deadline,
              extra.signal,
              () =>
                withinDeadline(
                  () => {
                    if (input.kind === "caller") {
                      const job = options.manager.cancelCallerWait(input.groundlaneJobId, caller);
                      return Promise.resolve({
                        job,
                        cancelResult: {
                          callerCancelled: true,
                          groundlanePollingCancelled: job.groundlanePollingCancelled,
                          upstreamCancelled: false,
                        },
                      });
                    }
                    if (input.kind === "groundlane") {
                      const job = options.manager.cancelGroundlanePolling(
                        input.groundlaneJobId,
                        caller,
                      );
                      return Promise.resolve({
                        job,
                        cancelResult: {
                          callerCancelled: job.callerCancelled,
                          groundlanePollingCancelled: true,
                          upstreamCancelled: false,
                        },
                      });
                    }
                    const outcome = options.manager.requestUpstreamCancel(
                      input.groundlaneJobId,
                      caller,
                    );
                    return Promise.resolve({
                      job: outcome.job,
                      cancelResult: {
                        callerCancelled: outcome.cancelResult.callerCancelled,
                        groundlanePollingCancelled:
                          outcome.cancelResult.groundlanePollingCancelled,
                        upstreamCancelled: outcome.cancelResult.upstreamCancelled,
                      },
                    });
                  },
                  deadline,
                  extra.signal,
                  "crawl_cancel",
                ),
            );
            assertWithinOutputLimit(data, options.maxOutputChars, "crawl_cancel");
            return structuredToolResult({ ok: true, data });
          } catch (error) {
            return toolError(error, { tool: "crawl_cancel" });
          }
        },
      );
    },
  };
}
