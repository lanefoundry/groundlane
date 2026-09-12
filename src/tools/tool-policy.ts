import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { McpModule } from "../mcp/registry.js";
import { structuredToolResult } from "../mcp/results.js";
import { resultEnvelopeSchema, toolError } from "./common.js";

type CostTier = "free" | "low" | "medium" | "high";
type LatencyTier = "fast" | "medium" | "slow";

interface ToolPolicyEntry {
  name: string;
  readOnly: boolean;
  openWorld: boolean;
  costTier: CostTier;
  latencyTier: LatencyTier;
  requiresProvider: boolean;
  description: string;
}

const COST_MAP: Readonly<Record<string, CostTier>> = {
  parse: "free",
  document_chunk: "free",
  document_toc: "free",
  document_compare: "free",
  web_extract: "free",
  corpus_retrieval_test: "free",
  corpus_source_inspect: "free",
  corpus_search: "free",
  corpus_create: "free",
  corpus_delete: "free",
  corpus_enroll: "free",
  corpus_remove: "free",
  corpus_update: "free",
  corpus_status: "free",
  audit_log: "free",
  tool_policy: "free",
  search_budget_status: "free",
  provider_capabilities: "free",
  provider_balance: "free",
  provider_quota: "free",
  document_policy: "free",
  document_archive_extract: "free",
  document_email_extract: "free",
  document_table_extract: "free",
  error_log: "free",
  web_fetch: "low",
  web_search: "low",
  web_news: "low",
  web_images: "low",
  document_parse: "low",
  document_smart_parse: "low",
  document_ocr: "low",
  document_convert: "low",
  document_transcribe: "low",
  paper_search: "low",
  paper_lookup: "low",
  web_content: "medium",
  web_answer: "medium",
  web_map: "medium",
  web_crawl: "medium",
  web_extract_schema: "medium",
  web_research: "high",
  web_research_start: "high",
  web_research_status: "high",
  web_research_result: "high",
  web_research_cancel: "high",
  document_upload_create: "medium",
  document_upload_complete: "medium",
  document_artifact_delete: "free",
  document_result_read: "free",
  document_result_delete: "free",
  document_job_create: "high",
  document_job_status: "free",
  document_job_cancel: "free",
  crawl_create: "medium",
  crawl_status: "free",
  crawl_result: "free",
  crawl_cancel: "free",
};

const LATENCY_MAP: Readonly<Record<string, LatencyTier>> = {
  parse: "fast",
  document_chunk: "fast",
  document_toc: "fast",
  document_compare: "fast",
  web_extract: "fast",
  corpus_retrieval_test: "fast",
  corpus_source_inspect: "fast",
  corpus_search: "fast",
  corpus_create: "fast",
  corpus_delete: "fast",
  corpus_enroll: "fast",
  corpus_remove: "fast",
  corpus_update: "fast",
  corpus_status: "fast",
  audit_log: "fast",
  tool_policy: "fast",
  search_budget_status: "fast",
  provider_capabilities: "fast",
  provider_balance: "medium",
  provider_quota: "medium",
  document_policy: "fast",
  document_archive_extract: "fast",
  document_email_extract: "fast",
  document_table_extract: "fast",
  error_log: "fast",
  document_result_read: "fast",
  document_result_delete: "fast",
  document_artifact_delete: "fast",
  document_job_status: "fast",
  document_job_cancel: "fast",
  web_fetch: "medium",
  web_search: "medium",
  web_news: "medium",
  web_images: "medium",
  document_parse: "medium",
  document_smart_parse: "medium",
  document_ocr: "medium",
  document_convert: "medium",
  document_transcribe: "medium",
  paper_search: "medium",
  paper_lookup: "medium",
  web_content: "medium",
  web_answer: "medium",
  web_map: "medium",
  web_crawl: "medium",
  web_extract_schema: "medium",
  document_upload_create: "medium",
  document_upload_complete: "medium",
  crawl_create: "medium",
  crawl_status: "fast",
  crawl_result: "fast",
  crawl_cancel: "fast",
  web_research: "slow",
  web_research_start: "slow",
  web_research_status: "fast",
  web_research_result: "fast",
  web_research_cancel: "fast",
  document_job_create: "slow",
};

const REQUIRES_PROVIDER = new Set([
  "web_search",
  "web_content",
  "web_answer",
  "web_research",
  "web_research_start",
  "web_news",
  "web_images",
  "web_map",
  "web_crawl",
  "web_extract_schema",
  "paper_search",
  "paper_lookup",
]);

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  audit_log: "Read instance-local tool-call audit log",
  corpus_create: "Create an operator-owned corpus",
  corpus_delete: "Delete a corpus and revoke access",
  corpus_enroll: "Enroll a source into a corpus",
  corpus_remove: "Remove a source from a corpus",
  corpus_retrieval_test: "Test retrieval quality against expected sources",
  corpus_search: "Search an operator-owned corpus",
  corpus_source_inspect: "Inspect a corpus source as parsed document blocks",
  corpus_status: "Read corpus manifest and health",
  corpus_update: "Update a corpus source",
  crawl_cancel: "Cancel a durable crawl job",
  crawl_create: "Create a durable provider-neutral crawl job",
  crawl_result: "Read crawl job results",
  crawl_status: "Check crawl job status",
  document_archive_extract: "Extract and parse files from a ZIP archive",
  document_artifact_delete: "Revoke a source artifact",
  document_chunk: "Split a document into hierarchical chunks for RAG",
  document_compare: "Compare two documents with structured diff",
  document_convert: "Convert legacy Office formats to Markdown",
  document_email_extract: "Parse EML with recursive attachments",
  document_job_cancel: "Cancel an async document job",
  document_job_create: "Create an async document processing job",
  document_job_status: "Check async document job status",
  document_ocr: "Extract text from scanned PDFs and images via OCR",
  document_parse: "Parse a document into canonical envelope and projection",
  document_policy: "Read document/artifact/cache policy and bounds",
  document_result_delete: "Revoke a durable document result",
  document_result_read: "Read a durable document result by refId",
  document_smart_parse: "Auto-detect file type and route to correct parser",
  document_table_extract: "Extract tables from PDFs using spatial heuristics",
  document_toc: "Extract structured table-of-contents from a document",
  document_transcribe: "Transcribe audio to text with timestamps",
  document_upload_complete: "Finalize a verified source artifact upload",
  document_upload_create: "Create a credential-bound upload handoff",
  error_log: "Read error log entries",
  paper_lookup: "Look up a scholarly paper by DOI or ID",
  paper_search: "Search scholarly papers",
  parse: "Parse a URL or raw HTML into reusable structures",
  provider_balance: "Check provider account-balance APIs",
  provider_capabilities: "List provider features and exposed surfaces",
  provider_quota: "Combined balance, budgets, capabilities, and routing",
  search_budget_status: "Inspect local provider attempt guardrails",
  tool_policy: "Query tool cost, latency, and provider requirements",
  web_answer: "Retrieve grounded answers from answer-capable providers",
  web_content: "Fetch URL content through provider content APIs",
  web_crawl: "Crawl bounded pages from a public site",
  web_extract: "Extract deterministic structured fields from a page",
  web_extract_schema: "Extract structured fields using a provider model",
  web_fetch: "Read a public URL as Markdown, text, or HTML",
  web_images: "Search image-specific provider indexes",
  web_map: "Discover URLs from a public site",
  web_news: "Search news-specific provider indexes",
  web_research: "Retrieve provider-attributed research reports",
  web_research_cancel: "Cancel a durable research job",
  web_research_result: "Read durable research job result",
  web_research_start: "Start a durable research job",
  web_research_status: "Check durable research job status",
  web_search: "Search the public web with normalized results",
};

function buildEntry(name: string): ToolPolicyEntry {
  return {
    name,
    readOnly: !name.startsWith("corpus_enroll") && !name.startsWith("corpus_create") && !name.startsWith("corpus_delete") && !name.startsWith("corpus_remove") && !name.startsWith("corpus_update") && !name.includes("upload") && !name.includes("_delete") && !name.includes("_cancel") && !name.includes("job_create") && !name.includes("crawl_create"),
    openWorld: name.startsWith("web_") || name === "parse" || name === "document_parse" || name === "document_ocr" || name === "document_transcribe" || name === "paper_search" || name === "paper_lookup",
    costTier: COST_MAP[name] ?? "low",
    latencyTier: LATENCY_MAP[name] ?? "medium",
    requiresProvider: REQUIRES_PROVIDER.has(name),
    description: DESCRIPTIONS[name] ?? name,
  };
}

const toolPolicyInputSchema = z.object({
  tool: z.string().trim().min(1).max(100).optional()
    .describe("Tool name to query. Omit to return policies for all registered tools."),
});

const toolPolicyEntrySchema = z.object({
  name: z.string(),
  readOnly: z.boolean(),
  openWorld: z.boolean(),
  costTier: z.enum(["free", "low", "medium", "high"]),
  latencyTier: z.enum(["fast", "medium", "slow"]),
  requiresProvider: z.boolean(),
  description: z.string(),
});

const toolPolicyDataSchema = z.object({
  tools: z.array(toolPolicyEntrySchema),
  totalTools: z.number().int(),
});

export function createToolPolicyModule(): McpModule {
  return {
    name: "tool_policy",
    register(server: McpServer): void {
      server.registerTool(
        "tool_policy",
        {
          description:
            "Query tool cost tier, latency tier, provider requirements, and read-only status. Use before calling a tool to understand its cost and latency characteristics. Returns static policy metadata, not live measurements.",
          inputSchema: toolPolicyInputSchema,
          outputSchema: resultEnvelopeSchema(toolPolicyDataSchema),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        (input) => {
          try {
            const allNames = Object.keys(DESCRIPTIONS).sort();
            if (input.tool !== undefined) {
              if (!(input.tool in DESCRIPTIONS)) {
                return structuredToolResult({
                  ok: true,
                  data: { tools: [], totalTools: allNames.length },
                });
              }
              return structuredToolResult({
                ok: true,
                data: {
                  tools: [buildEntry(input.tool)],
                  totalTools: allNames.length,
                },
              });
            }
            return structuredToolResult({
              ok: true,
              data: {
                tools: allNames.map(buildEntry),
                totalTools: allNames.length,
              },
            });
          } catch (error) {
            return toolError(error, { tool: "tool_policy" });
          }
        },
      );
    },
  };
}
