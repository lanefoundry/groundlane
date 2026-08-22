import type { SearchProviderId, SearchStrategy } from "./contracts.js";
import { searchProviderFamily } from "./search-provider-profile.js";

const STRATEGY_LIMITS: Readonly<Record<Exclude<SearchStrategy, "fallback">, number>> = {
  balanced: 2,
  deep: 3,
};

export function selectSearchProviders(
  candidates: readonly SearchProviderId[],
  strategy: SearchStrategy,
): SearchProviderId[] {
  const unique = [...new Set(candidates)];
  if (strategy === "fallback") return unique;

  const limit = STRATEGY_LIMITS[strategy];
  const selected: SearchProviderId[] = [];
  const selectedFamilies = new Set<string>();

  for (const provider of unique) {
    const family = searchProviderFamily(provider);
    if (selectedFamilies.has(family)) continue;
    selected.push(provider);
    selectedFamilies.add(family);
    if (selected.length === limit) return selected;
  }

  for (const provider of unique) {
    if (selected.includes(provider)) continue;
    selected.push(provider);
    if (selected.length === limit) break;
  }

  return selected;
}
