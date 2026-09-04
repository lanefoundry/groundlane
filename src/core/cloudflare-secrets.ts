export type CloudflareSecretGroup = "authentication" | "search" | "browser";

export interface CloudflareSecretDefinition {
  name: string;
  label: string;
  group: CloudflareSecretGroup;
  required: boolean;
  minimumLength?: number;
}

export const CLOUDFLARE_SECRET_DEFINITIONS = [
  {
    name: "GROUNDLANE_AUTH_TOKEN",
    label: "Groundlane MCP bearer token",
    group: "authentication",
    required: true,
    minimumLength: 32,
  },
  {
    name: "OAUTH_OWNER_PASSPHRASE",
    label: "OAuth /authorize owner passphrase",
    group: "authentication",
    required: true,
    minimumLength: 32,
  },
  {
    name: "GROUNDLANE_ADMIN_TOKEN",
    label: "Managed-credential admin token (never a data-plane credential)",
    group: "authentication",
    required: false,
    minimumLength: 32,
  },
  {
    name: "GROUNDLANE_INTERNAL_SIGNING_SECRET",
    label: "Worker-to-Container internal context signing secret",
    group: "authentication",
    required: false,
    minimumLength: 32,
  },
  { name: "TAVILY_API_KEY", label: "Tavily", group: "search", required: false },
  { name: "EXA_API_KEY", label: "Exa", group: "search", required: false },
  { name: "BRAVE_API_KEY", label: "Brave Search", group: "search", required: false },
  { name: "FIRECRAWL_API_KEY", label: "Firecrawl", group: "search", required: false },
  { name: "SERPAPI_API_KEY", label: "SerpApi", group: "search", required: false },
  { name: "SEARCHAPI_API_KEY", label: "SearchAPI.io", group: "search", required: false },
  {
    name: "BROWSERBASE_API_KEY",
    label: "Browserbase Search",
    group: "search",
    required: false,
  },
  { name: "PARALLEL_API_KEY", label: "Parallel", group: "search", required: false },
  { name: "LINKUP_API_KEY", label: "Linkup", group: "search", required: false },
  { name: "KEENABLE_API_KEY", label: "Keenable", group: "search", required: false },
  { name: "TINYFISH_API_KEY", label: "TinyFish", group: "search", required: false },
  { name: "SERPER_API_KEY", label: "Serper", group: "search", required: false },
  { name: "YOU_API_KEY", label: "You.com REST", group: "search", required: false },
  {
    name: "BROWSERLESS_TOKEN",
    label: "Browserless",
    group: "browser",
    required: false,
  },
] as const satisfies readonly CloudflareSecretDefinition[];

export type CloudflareSecretName =
  (typeof CLOUDFLARE_SECRET_DEFINITIONS)[number]["name"];

export interface SecretStatusRow {
  name: CloudflareSecretName;
  label: string;
  group: CloudflareSecretGroup;
  configured: boolean;
  state: "configured" | "required" | "optional";
}

export interface SecretStatus {
  rows: SecretStatusRow[];
  unknownNames: string[];
}

export interface SecretCommandArguments {
  environment?: string;
  dryRun: boolean;
  fromFile?: string;
  help: boolean;
  yes: boolean;
}

export type SecretCommand = "setup" | "status";

const knownNames = new Set<string>(
  CLOUDFLARE_SECRET_DEFINITIONS.map((definition) => definition.name),
);

export function validateSecretValue(
  definition: CloudflareSecretDefinition,
  value: string,
): string | undefined {
  if (value.trim().length === 0) return "must not be blank";
  if (
    definition.minimumLength !== undefined &&
    value.length < definition.minimumLength
  ) {
    return `must contain at least ${definition.minimumLength} characters`;
  }
  return undefined;
}

export function buildSecretBulkPayload(
  updates: Readonly<Record<string, string | undefined>>,
): Partial<Record<CloudflareSecretName, string>> {
  const unknownNames = Object.keys(updates).filter((name) => !knownNames.has(name));
  if (unknownNames.length > 0) {
    throw new Error(`Unknown Cloudflare secret: ${unknownNames.sort().join(", ")}`);
  }
  const payload: Partial<Record<CloudflareSecretName, string>> = {};
  for (const definition of CLOUDFLARE_SECRET_DEFINITIONS) {
    const value = updates[definition.name];
    if (value === undefined || value.trim().length === 0) continue;
    const issue = validateSecretValue(definition, value);
    if (issue !== undefined) {
      throw new Error(`${definition.name} ${issue}`);
    }
    payload[definition.name] = value;
  }
  return payload;
}

export function buildSecretStatus(existingNames: readonly string[]): SecretStatus {
  const existing = new Set(existingNames);
  return {
    rows: CLOUDFLARE_SECRET_DEFINITIONS.map((definition) => {
      const configured = existing.has(definition.name);
      return {
        name: definition.name,
        label: definition.label,
        group: definition.group,
        configured,
        state: configured ? "configured" : definition.required ? "required" : "optional",
      };
    }),
    unknownNames: [...existing].filter((name) => !knownNames.has(name)).sort(),
  };
}

export function parseSecretSelection(
  input: string,
  options: readonly CloudflareSecretDefinition[],
): CloudflareSecretDefinition[] {
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) return [];
  if (normalized === "all") return [...options];
  const selectedIndexes = new Set<number>();
  for (const rawPart of normalized.split(",")) {
    const part = rawPart.trim();
    const single = /^(\d+)$/u.exec(part);
    if (single !== null) {
      const index = Number(single[1]);
      if (index < 1 || index > options.length) {
        throw new Error(`Selection must be between 1 and ${options.length}`);
      }
      selectedIndexes.add(index - 1);
      continue;
    }
    const range = /^(\d+)\s*-\s*(\d+)$/u.exec(part);
    if (range !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new Error(`Invalid range: ${part}`);
      if (start < 1 || end > options.length) {
        throw new Error(`Selection must be between 1 and ${options.length}`);
      }
      for (let index = start; index <= end; index += 1) {
        selectedIndexes.add(index - 1);
      }
      continue;
    }
    throw new Error(`Invalid selection: ${part}`);
  }
  return options.filter((_, index) => selectedIndexes.has(index));
}

export function parseSecretCommandArguments(
  arguments_: readonly string[],
): SecretCommandArguments {
  let environment: string | undefined;
  let dryRun = false;
  let fromFile: string | undefined;
  let help = false;
  let yes = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--env") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--env requires a value");
      }
      environment = value;
      index += 1;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--from-file") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--from-file requires a value");
      }
      fromFile = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--yes") {
      yes = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ""}`);
  }
  return {
    ...(environment === undefined ? {} : { environment }),
    dryRun,
    ...(fromFile === undefined ? {} : { fromFile }),
    help,
    yes,
  };
}

export function buildSecretCommandHelp(command: SecretCommand): string {
  const common = [
    "Cloudflare only: this command does not read or update your local .env.",
    "Without --env, Wrangler uses the default Wrangler target from wrangler.jsonc.",
    "All operations other than help require Wrangler authentication.",
  ];
  if (command === "setup") {
    return [
      "Usage: pnpm secrets:setup -- [--env <name>] [--from-file <path>] [--dry-run] [--yes]",
      "",
      "Interactively create or replace Groundlane Cloudflare secrets.",
      ...common,
      "The numbered setup menu requires an interactive TTY, including for --dry-run.",
      "Choose secrets from one numbered list; only selected values are prompted.",
      "At a value prompt, blank input keeps an existing secret.",
      "With --from-file, import a .env or JSON object in one bounded bulk operation.",
      "File dry-runs need no TTY or Cloudflare connection; use --yes for non-interactive writes.",
      "",
      "Options:",
      "  --env <name>  Target a named Wrangler environment.",
      "  --from-file   Read known secret names and values from a .env or JSON file.",
      "  --dry-run     Preview selected secret names without sending values.",
      "  --yes         Skip the final confirmation.",
      "  -h, --help    Show this help.",
    ].join("\n");
  }
  return [
    "Usage: pnpm secrets:status -- [--env <name>]",
    "",
    "Compare the checked-in manifest with configured Cloudflare secret names only.",
    "Secret values cannot be retrieved or validated.",
    ...common,
    "",
    "Options:",
    "  --env <name>  Target a named Wrangler environment.",
    "  -h, --help    Show this help.",
  ].join("\n");
}

export function parseWranglerSecretNames(output: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error("Wrangler secret list returned malformed JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler secret list must return an array");
  }
  const names: string[] = [];
  for (const rawItem of parsed) {
    const item: unknown = rawItem;
    if (typeof item !== "object" || item === null || !("name" in item)) {
      throw new Error("Wrangler secret list entry is missing a name");
    }
    const name = item.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Wrangler secret list entry has an invalid name");
    }
    names.push(name);
  }
  return [...new Set(names)].sort();
}
