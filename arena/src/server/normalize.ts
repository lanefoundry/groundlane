import type { NormalizedSearchResult } from '#/lib/types'

interface RawSearchItem {
  title?: string
  snippet?: string
  description?: string
  url?: string
}

function isRawSearchItem(value: unknown): value is RawSearchItem {
  return typeof value === 'object' && value !== null
}

export function normalizeSearchResults(raw: unknown[]): NormalizedSearchResult[] {
  return raw
    .filter(isRawSearchItem)
    .slice(0, 5)
    .map((item) => ({
      title: truncate(String(item.title ?? ''), 80),
      snippet: truncate(stripFormatting(String(item.snippet ?? item.description ?? '')), 200),
      domain: extractDomain(String(item.url ?? '')),
    }))
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

function stripFormatting(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
