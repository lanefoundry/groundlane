import type {
  SearchProviderId,
  SearchResult,
  SearchResultItem,
  SearchResultSource,
} from "./contracts.js";

const RRF_K = 60;
const MAX_CANDIDATES_PER_PROVIDER = 50;
const MAX_RESULTS_PER_HOSTNAME = 2;
const TRACKING_PARAMETERS = new Set([
  "dclid",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "msclkid",
]);

interface FusedCandidate {
  item: SearchResultItem;
  canonicalUrl: string;
  hostname: string;
  fusionScore: number;
  sources: SearchResultSource[];
  firstProviderIndex: number;
}

function isTrackingParameter(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized);
}

export function canonicalSearchResultUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return undefined;
  }

  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParameter(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  return url.toString();
}

function source(
  provider: SearchProviderId,
  rank: number,
  rawScore: number | undefined,
): SearchResultSource {
  return {
    provider,
    rank,
    ...(rawScore === undefined ? {} : { rawScore }),
  };
}

export function fuseSearchResults(
  providerResults: readonly SearchResult[],
  maxResults: number,
): SearchResultItem[] {
  const candidates = new Map<string, FusedCandidate>();

  providerResults.forEach((result, providerIndex) => {
    result.results.slice(0, MAX_CANDIDATES_PER_PROVIDER).forEach((item, itemIndex) => {
      const canonicalUrl = canonicalSearchResultUrl(item.url);
      if (canonicalUrl === undefined) return;
      const rank = itemIndex + 1;
      const existing = candidates.get(canonicalUrl);
      if (existing !== undefined) {
        existing.fusionScore += 1 / (RRF_K + rank);
        existing.sources.push(source(result.provider, rank, item.score));
        return;
      }

      candidates.set(canonicalUrl, {
        item: {
          ...item,
          url: canonicalUrl,
          provider: result.provider,
        },
        canonicalUrl,
        hostname: new URL(canonicalUrl).hostname,
        fusionScore: 1 / (RRF_K + rank),
        sources: [source(result.provider, rank, item.score)],
        firstProviderIndex: providerIndex,
      });
    });
  });

  const sorted = [...candidates.values()].sort((left, right) => {
    if (left.fusionScore !== right.fusionScore) return right.fusionScore - left.fusionScore;
    if (left.sources.length !== right.sources.length) return right.sources.length - left.sources.length;
    const leftBestRank = Math.min(...left.sources.map((item) => item.rank));
    const rightBestRank = Math.min(...right.sources.map((item) => item.rank));
    if (leftBestRank !== rightBestRank) return leftBestRank - rightBestRank;
    if (left.firstProviderIndex !== right.firstProviderIndex) {
      return left.firstProviderIndex - right.firstProviderIndex;
    }
    return left.canonicalUrl.localeCompare(right.canonicalUrl);
  });

  const hostnameCounts = new Map<string, number>();
  const output: SearchResultItem[] = [];
  for (const candidate of sorted) {
    const count = hostnameCounts.get(candidate.hostname) ?? 0;
    if (count >= MAX_RESULTS_PER_HOSTNAME) continue;
    hostnameCounts.set(candidate.hostname, count + 1);
    output.push({
      ...candidate.item,
      fusionScore: candidate.fusionScore,
      sources: candidate.sources,
    });
    if (output.length === maxResults) break;
  }
  return output;
}
