import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { AuditLogSink } from "../core/audit-log.js";
import { hashInput } from "../core/audit-log.js";
import type { AuthenticatedPrincipal } from "../worker/auth.js";
import { enforceStandardSchemaPolicy } from "./schema-policy.js";

export interface McpRequestStateIssuer {
  mint<T extends Record<string, unknown>>(state: T, context: ServerContext): Promise<string>;
}

export interface McpRequestContext {
  readonly principal: AuthenticatedPrincipal;
  readonly credentialBinding: string;
  readonly requestState?: McpRequestStateIssuer | undefined;
}

export interface McpModule {
  readonly name: string;
  register(server: McpServer): void | Promise<void>;
  readonly modernRequestHandlers?: Readonly<Record<
    string,
    (params: unknown, body: unknown, signal: AbortSignal) => Promise<Record<string, unknown> | undefined>
  >>;
}

export class McpRegistry {
  readonly #modules = new Map<string, McpModule>();
  readonly #auditLog: AuditLogSink | undefined;

  constructor(auditLog?: AuditLogSink) {
    this.#auditLog = auditLog;
  }

  add(module: McpModule): this {
    if (this.#modules.has(module.name)) {
      throw new Error(`MCP module already registered: ${module.name}`);
    }
    this.#modules.set(module.name, module);
    return this;
  }

  names(): readonly string[] {
    return [...this.#modules.keys()];
  }

  async handleModernRequest(
    method: string,
    params: unknown,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    let selected: ((params: unknown, body: unknown, signal: AbortSignal) => Promise<Record<string, unknown> | undefined>) | undefined;
    for (const module of this.#modules.values()) {
      const handler = module.modernRequestHandlers?.[method];
      if (handler === undefined) continue;
      if (selected !== undefined) {
        throw new Error(`Modern MCP extension handler already registered: ${method}`);
      }
      selected = handler;
    }
    return selected?.(params, body, signal);
  }

  async registerAll(server: McpServer): Promise<void> {
    const modules = [...this.#modules.values()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const module of modules) {
      if (typeof server.registerTool !== "function") {
        await module.register(server);
        continue;
      }
      const originalRegisterTool = server.registerTool.bind(server);
      // The SDK accepts Standard Schema implementations; intercept the one
      // public registration seam so every module is admitted before the SDK
      // compiles or serves its JSON Schema. The original overload set is
      // restored after each module to keep registration ownership explicit.
      server.registerTool = (
        name: string,
        config: Parameters<McpServer["registerTool"]>[1],
        callback: Parameters<McpServer["registerTool"]>[2],
      ) => {
        if (config.inputSchema !== undefined) {
          enforceStandardSchemaPolicy(config.inputSchema, "input");
        }
        if (config.outputSchema !== undefined) {
          enforceStandardSchemaPolicy(config.outputSchema, "output");
        }
        const auditSink = this.#auditLog;
        const wrappedCallback = auditSink !== undefined && name !== "audit_log"
          ? (async (...args: Parameters<typeof callback>) => {
              const start = Date.now();
              try {
                const result = await (callback as Function).apply(undefined, args);
                const sc = result as { structuredContent?: { ok?: boolean } } | undefined;
                const status: "ok" | "error" = sc?.structuredContent?.ok === false ? "error" : "ok";
                auditSink.append({
                  timestamp: new Date(start).toISOString(),
                  tool: name,
                  inputHash: hashInput(args[0]),
                  durationMs: Date.now() - start,
                  status,
                });
                return result;
              } catch (error) {
                auditSink.append({
                  timestamp: new Date(start).toISOString(),
                  tool: name,
                  inputHash: hashInput(args[0]),
                  durationMs: Date.now() - start,
                  status: "error",
                  errorCode: error instanceof Error ? error.constructor.name : "unknown",
                });
                throw error;
              }
            }) as typeof callback
          : callback;
        return Reflect.apply(originalRegisterTool, server, [name, config, wrappedCallback]);
      };
      try {
        await module.register(server);
      } finally {
        server.registerTool = originalRegisterTool;
      }
    }
  }
}

export type McpRegistryFactory = (
  context?: McpRequestContext,
) => McpRegistry | Promise<McpRegistry>;

export function createMcpRegistry(
  modules: readonly McpModule[] = [],
  auditLog?: AuditLogSink,
): McpRegistry {
  const registry = new McpRegistry(auditLog);
  for (const module of modules) {
    registry.add(module);
  }
  return registry;
}
