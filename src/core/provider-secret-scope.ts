const BUILT_IN_SECRET_PATTERNS = [
  /^GROUNDLANE_AUTH_TOKEN$/u,
  /^(TAVILY|EXA|BRAVE|FIRECRAWL|SERPAPI|SEARCHAPI|BROWSERBASE|PARALLEL|LINKUP|KEENABLE|TINYFISH|SERPER|YOU)_API_KEY$/u,
  /^BROWSERLESS_TOKEN$/u,
] as const;

const CUSTOM_TOKEN_RE = /^GROUNDLANE_CUSTOM_PROVIDER_[A-Z0-9_]+_TOKEN$/u;

export function providerSecretBindingName(customId: string): string {
  if (!customId.startsWith("custom.")) {
    throw new Error(`Provider ID "${customId}" is not a custom provider`);
  }
  const suffix = customId
    .replace(/^custom\./u, "")
    .toUpperCase()
    .replace(/-/gu, "_");
  return `GROUNDLANE_CUSTOM_PROVIDER_${suffix}_TOKEN`;
}

export function isCustomProviderBinding(name: string): boolean {
  return CUSTOM_TOKEN_RE.test(name);
}

export function filterCustomProviderBindings(
  bindings: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (isCustomProviderBinding(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function isProtectedBinding(name: string): boolean {
  return BUILT_IN_SECRET_PATTERNS.some((pattern) => pattern.test(name));
}

export class ScopedSecretAccessor {
  private readonly bindingName: string;

  constructor(
    private readonly providerId: string,
    private readonly bindings: Readonly<Record<string, string | undefined>>,
  ) {
    this.bindingName = providerSecretBindingName(providerId);
  }

  getSecret(): string | undefined {
    return this.bindings[this.bindingName];
  }

  getBindingName(): string {
    return this.bindingName;
  }

  static validateBindings(
    bindings: Readonly<Record<string, string | undefined>>,
  ): void {
    for (const key of Object.keys(bindings)) {
      if (isProtectedBinding(key)) {
        throw new Error(
          `Binding "${key}" is a protected secret and must not be forwarded to custom providers`,
        );
      }
      if (!isCustomProviderBinding(key)) {
        throw new Error(
          `Binding "${key}" is not a recognized custom provider token binding`,
        );
      }
    }
  }
}
