import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedPrincipal } from "../worker/auth.js";

export interface McpRequestContext {
  readonly principal: AuthenticatedPrincipal;
  readonly credentialBinding: string;
}

export interface McpModule {
  readonly name: string;
  register(server: McpServer): void | Promise<void>;
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

  async registerAll(server: McpServer): Promise<void> {
    for (const module of this.#modules.values()) {
      await module.register(server);
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
