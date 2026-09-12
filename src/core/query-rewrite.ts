export interface RewriteResult {
  readonly rewritten: string;
  readonly strategies: readonly string[];
  readonly applied: boolean;
}

const FILLER_PATTERNS: readonly RegExp[] = [
  /^\s*(?:please|pls)\s+/iu,
  /^\s*(?:can you|could you|would you)\s+/iu,
  /^\s*(?:I want to|I need to|I'd like to)\s+/iu,
  /^\s*(?:find me|show me|get me|give me|tell me about)\s+/iu,
  /^\s*(?:search for|look up|look for)\s+/iu,
  /^\s*(?:help me find|help me with)\s+/iu,
];

const KNOWN_SITES: readonly [RegExp, string][] = [
  [/\bgithub\.com\b/iu, "github.com"],
  [/\bstackoverflow\.com\b/iu, "stackoverflow.com"],
  [/\bnpmjs\.com\b/iu, "npmjs.com"],
  [/\bpypi\.org\b/iu, "pypi.org"],
  [/\bmdn\b/iu, "developer.mozilla.org"],
  [/\bcrates\.io\b/iu, "crates.io"],
  [/\barxiv\.org\b/iu, "arxiv.org"],
  [/\breddit\.com\b/iu, "reddit.com"],
  [/\bwikipedia\.org\b/iu, "wikipedia.org"],
];

const PROPER_NOUN_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/gu;

function removeFiller(query: string): { cleaned: string; applied: boolean } {
  let cleaned = query;
  let applied = false;
  for (const pattern of FILLER_PATTERNS) {
    const before = cleaned;
    cleaned = cleaned.replace(pattern, "").trim();
    if (cleaned !== before) applied = true;
  }
  return { cleaned, applied };
}

function quoteProperNouns(query: string): { quoted: string; applied: boolean } {
  let applied = false;
  const quoted = query.replace(PROPER_NOUN_PATTERN, (match) => {
    if (query.includes(`"${match}"`)) return match;
    applied = true;
    return `"${match}"`;
  });
  return { quoted, applied };
}

function addSitePrefix(query: string): { rewritten: string; site: string; applied: boolean } {
  for (const [pattern, site] of KNOWN_SITES) {
    if (pattern.test(query) && !query.includes("site:")) {
      const cleaned = query.replace(pattern, "").trim();
      return { rewritten: `site:${site} ${cleaned}`, site, applied: true };
    }
  }
  return { rewritten: query, site: "", applied: false };
}

export function rewriteQuery(query: string): RewriteResult {
  if (query.trim().length === 0) {
    return { rewritten: query, strategies: [], applied: false };
  }

  let current = query;
  const strategies: string[] = [];

  const filler = removeFiller(current);
  if (filler.applied) {
    current = filler.cleaned;
    strategies.push("remove-filler");
  }

  const site = addSitePrefix(current);
  if (site.applied) {
    current = site.rewritten;
    strategies.push(`site-prefix:${site.site}`);
  }

  const proper = quoteProperNouns(current);
  if (proper.applied) {
    current = proper.quoted;
    strategies.push("quote-proper-nouns");
  }

  if (current === query || current.trim() === query.trim()) {
    return { rewritten: query, strategies: [], applied: false };
  }

  return { rewritten: current.trim(), strategies, applied: true };
}
