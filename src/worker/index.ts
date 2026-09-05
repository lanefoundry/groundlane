import { Container } from "@cloudflare/containers";
export { ContainerProxy } from "@cloudflare/containers";

import {
  DEFAULT_SEARCH_PROVIDER_BUDGETS_VALUE,
  DEFAULT_SEARCH_PROVIDER_ORDER_VALUE,
} from "../core/search-provider-catalog.js";
import { handleWorkerRequest } from "./handler.js";
import { runArtifactCleanup } from "./artifact-cleanup.js";
import { runDocumentCacheCleanup } from "./document-cache-cleanup.js";
import {
  DOCUMENT_CACHE_BRIDGE_HOST,
} from "../mcp/document-cache-bridge.js";
import { handleDocumentCacheOutbound } from "./document-cache-runtime.js";
import { DOCUMENT_OUTPUT_HOST } from "../mcp/document-output-bridge.js";
import { handleDocumentOutputOutbound } from "./document-output-outbound.js";
import { createEdgeDocumentOutputRuntime } from "./document-output-runtime.js";
import { runDocumentJobTick, configuredDocumentJobRuntime } from "./document-job-runtime.js";
import { scheduledDocumentWork } from "./document-schedule.js";

export class GroundlaneContainer extends Container<Cloudflare.Env> {
  static {
    // Assignment invokes the SDK registry setter; an ES2022 static field would
    // shadow it and leave ContainerProxy without either private host handler.
    this.outboundByHost = {
      [DOCUMENT_CACHE_BRIDGE_HOST]: handleDocumentCacheOutbound,
      [DOCUMENT_OUTPUT_HOST]: handleDocumentOutputOutbound,
    };
  }

  override defaultPort = 8080;
  override sleepAfter = "10m";
  override pingEndpoint = "/healthz";
  override envVars = {
    GROUNDLANE_AUTH_TOKEN: this.env.GROUNDLANE_AUTH_TOKEN,
    GROUNDLANE_AUTH_MODE:
      (this.env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "").length > 0
        ? "worker_internal_context"
        : "local_static",
    GROUNDLANE_INTERNAL_SIGNING_SECRET:
      this.env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "",
    GROUNDLANE_MCP_PROTOCOL_MODE:
      this.env.GROUNDLANE_MCP_PROTOCOL_MODE ?? "legacy-only",
    GROUNDLANE_MCP_REQUEST_STATE_SECRET:
      this.env.GROUNDLANE_MCP_REQUEST_STATE_SECRET ?? "",
    GROUNDLANE_INTERNAL_AUDIENCE: "groundlane-mcp-v2",
    PORT: String(this.defaultPort),
    READER_BACKEND: this.env.READER_BACKEND ?? "disabled",
    BROWSER_BACKEND: this.env.BROWSER_BACKEND ?? "local",
    BROWSERLESS_TOKEN: this.env.BROWSERLESS_TOKEN ?? "",
    BROWSERLESS_REGION: this.env.BROWSERLESS_REGION ?? "sfo",
    SEARCH_PROVIDER_ORDER:
      this.env.SEARCH_PROVIDER_ORDER ?? DEFAULT_SEARCH_PROVIDER_ORDER_VALUE,
    SEARCH_MONTHLY_REQUEST_BUDGETS:
      this.env.SEARCH_MONTHLY_REQUEST_BUDGETS ??
      DEFAULT_SEARCH_PROVIDER_BUDGETS_VALUE,
    TAVILY_API_KEY: this.env.TAVILY_API_KEY ?? "",
    EXA_API_KEY: this.env.EXA_API_KEY ?? "",
    BRAVE_API_KEY: this.env.BRAVE_API_KEY ?? "",
    FIRECRAWL_API_KEY: this.env.FIRECRAWL_API_KEY ?? "",
    SERPAPI_API_KEY: this.env.SERPAPI_API_KEY ?? "",
    SEARCHAPI_API_KEY: this.env.SEARCHAPI_API_KEY ?? "",
    BROWSERBASE_API_KEY: this.env.BROWSERBASE_API_KEY ?? "",
    PARALLEL_API_KEY: this.env.PARALLEL_API_KEY ?? "",
    LINKUP_API_KEY: this.env.LINKUP_API_KEY ?? "",
    KEENABLE_API_KEY: this.env.KEENABLE_API_KEY ?? "",
    TINYFISH_API_KEY: this.env.TINYFISH_API_KEY ?? "",
    SERPER_API_KEY: this.env.SERPER_API_KEY ?? "",
    YOU_API_KEY: this.env.YOU_API_KEY ?? "",
    REQUEST_TIMEOUT_MS: this.env.REQUEST_TIMEOUT_MS ?? "30000",
    MAX_RESPONSE_BYTES: this.env.MAX_RESPONSE_BYTES ?? "2000000",
    MAX_OUTPUT_CHARS: this.env.MAX_OUTPUT_CHARS ?? "100000",
    MAX_CONCURRENCY: this.env.MAX_CONCURRENCY ?? "4",
    MAX_QUEUE: this.env.MAX_QUEUE ?? "16",
    DOCUMENT_UPLOAD_MAX_TTL_SECONDS:
      this.env.DOCUMENT_UPLOAD_MAX_TTL_SECONDS ?? "3600",
    DOCUMENT_ARTIFACT_MAX_TTL_SECONDS:
      this.env.DOCUMENT_ARTIFACT_MAX_TTL_SECONDS ?? "2592000",
    DOCUMENT_CACHE_DEFAULT_TTL_SECONDS:
      this.env.DOCUMENT_CACHE_DEFAULT_TTL_SECONDS ?? "86400",
    DOCUMENT_CACHE_MAX_TTL_SECONDS:
      this.env.DOCUMENT_CACHE_MAX_TTL_SECONDS ?? "2592000",
    DOCUMENT_CACHE_EDGE_ENABLED:
      this.env.DOCUMENT_CACHE_EDGE_ENABLED === "true" &&
      this.env.MANAGED_TOKEN_D1 !== undefined &&
      this.env.GROUNDLANE_ARTIFACTS !== undefined &&
      (this.env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "").trim().length > 0
        ? "true"
        : "false",
    DOCUMENT_OUTPUT_EDGE_ENABLED:
      this.env.DOCUMENT_OUTPUT_EDGE_ENABLED === "true" &&
      this.env.MANAGED_TOKEN_D1 !== undefined &&
      this.env.GROUNDLANE_ARTIFACTS !== undefined &&
      (this.env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "").trim().length > 0
        ? "true" : "false",
    ASYNC_TASK_EDGE_ENABLED:
      this.env.MANAGED_TOKEN_D1 !== undefined &&
      (this.env.LINKUP_API_KEY ?? "").trim().length > 0
        ? "true"
        : "false",
    ARTIFACT_EDGE_ENABLED:
      this.env.MANAGED_TOKEN_D1 !== undefined &&
      this.env.GROUNDLANE_ARTIFACTS !== undefined &&
      (this.env.R2_ACCOUNT_ID ?? "").trim().length > 0 &&
      (this.env.R2_BUCKET_NAME ?? "").trim().length > 0 &&
      (this.env.R2_ACCESS_KEY_ID ?? "").trim().length > 0 &&
      (this.env.R2_SECRET_ACCESS_KEY ?? "").trim().length > 0 &&
      (this.env.GROUNDLANE_INTERNAL_SIGNING_SECRET ?? "").trim().length > 0
        ? "true"
        : "false",
  };
}

export default {
  fetch(request, env, ctx) {
    return handleWorkerRequest(request, env, crypto.subtle, ctx);
  },
  async scheduled(controller, env) {
    const work = scheduledDocumentWork(controller.cron);
    if (work.asyncTick) {
      try { await runDocumentJobTick(env); }
      catch { console.error(JSON.stringify({ level: "error", event: "document_dispatch_failed" })); }
    }
    if (!work.hourlyCleanup) return;
    const [artifact, cache] = await Promise.allSettled([
      runArtifactCleanup(env),
      runDocumentCacheCleanup(env),
    ]);
    if (artifact.status === "rejected") {
      console.error(JSON.stringify({ level: "error", event: "artifact_cleanup_failed" }));
    }
    if (cache.status === "rejected") {
      console.error(JSON.stringify({ level: "error", event: "document_cache_cleanup_failed" }));
    }
    if (env.DOCUMENT_OUTPUT_EDGE_ENABLED === "true") {
      try {
        const { repository, runtime } = createEdgeDocumentOutputRuntime(env);
        const nowMs = Date.now();
        let cursor: string | null = null;
        for (let page = 0; page < 4; page++) {
          const result = await repository.sweepExpired(nowMs, cursor, 100);
          cursor = result.nextCursor;
          if (cursor === null) break;
        }
        cursor = null;
        for (let page = 0; page < 4; page++) {
          const result = await runtime.sweepExpiredIntents(nowMs, cursor, 100);
          cursor = result.nextCursor;
          if (cursor === null) break;
        }
      } catch { console.error(JSON.stringify({ level: "error", event: "document_output_cleanup_failed" })); }
    }
    try { await configuredDocumentJobRuntime(env)?.snapshots.cleanup(Date.now(), null, 100); }
    catch { console.error(JSON.stringify({ level: "error", event: "document_snapshot_cleanup_failed" })); }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
