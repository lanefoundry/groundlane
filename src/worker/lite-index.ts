import { handleWorkerRequest } from "./handler.js";
import { runArtifactCleanup } from "./artifact-cleanup.js";
import { runDocumentCacheCleanup } from "./document-cache-cleanup.js";
import { createEdgeDocumentOutputRuntime } from "./document-output-runtime.js";
import { configuredDocumentJobRuntime } from "./document-job-runtime.js";

export default {
  fetch(request, env, ctx) {
    return handleWorkerRequest(request, env, crypto.subtle, ctx);
  },
  async scheduled(controller, env) {
    if (controller.cron !== "0 * * * *") return;
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
