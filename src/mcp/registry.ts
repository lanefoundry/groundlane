import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
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
        return Reflect.apply(originalRegisterTool, server, [name, config, callback]);
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
): McpRegistry {
  const registry = new McpRegistry();
  for (const module of modules) {
    registry.add(module);
  }
  return registry;
}
