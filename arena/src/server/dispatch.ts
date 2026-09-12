import type { NormalizedSearchResult } from '#/lib/types'
import { normalizeSearchResults } from './normalize'

interface DispatchResult {
  results: NormalizedSearchResult[]
  latencyMs: number
}

interface DispatchError {
  errorCode: string
  errorMessage: string
}

export type DispatchOutcome =
  | { ok: true; data: DispatchResult }
  | { ok: false; error: DispatchError }

interface ProviderEnv {
  TAVILY_API_KEY?: string
  EXA_API_KEY?: string
  BRAVE_API_KEY?: string
  SERPER_API_KEY?: string
  SERPAPI_API_KEY?: string
  LINKUP_API_KEY?: string
  YOU_API_KEY?: string
  FIRECRAWL_API_KEY?: string
  TINYFISH_API_KEY?: string
  PARALLEL_API_KEY?: string
  SEARCHAPI_API_KEY?: string
  BROWSERBASE_API_KEY?: string
  KEENABLE_API_KEY?: string
}

const DISPATCH_TIMEOUT_MS = 5_000

const KEY_MAP: Record<string, keyof ProviderEnv> = {
  tavily: 'TAVILY_API_KEY',
  exa: 'EXA_API_KEY',
  brave: 'BRAVE_API_KEY',
  serper: 'SERPER_API_KEY',
  serpapi: 'SERPAPI_API_KEY',
  linkup: 'LINKUP_API_KEY',
  you: 'YOU_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  tinyfish: 'TINYFISH_API_KEY',
  parallel: 'PARALLEL_API_KEY',
  searchapi: 'SEARCHAPI_API_KEY',
  browserbase: 'BROWSERBASE_API_KEY',
  keenable: 'KEENABLE_API_KEY',
}

export async function dispatchSearch(
  providerId: string,
  query: string,
  env: ProviderEnv,
): Promise<DispatchOutcome> {
  const keyName = KEY_MAP[providerId]
  const apiKey = keyName ? env[keyName] : undefined

  const needsKey = !['you', 'keenable'].includes(providerId)
  if (needsKey && !apiKey) {
    return { ok: false, error: { errorCode: 'NO_KEY', errorMessage: `No API key configured for ${providerId}` } }
  }

  const started = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS)

  try {
    const raw = await callProvider(providerId, query, apiKey ?? '', controller.signal)
    const latencyMs = Math.round(performance.now() - started)
    const results = normalizeSearchResults(raw)
    return { ok: true, data: { results, latencyMs } }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const code = controller.signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR'
    return { ok: false, error: { errorCode: code, errorMessage: message } }
  } finally {
    clearTimeout(timeout)
  }
}

async function callProvider(
  providerId: string,
  query: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown[]> {
  switch (providerId) {
    case 'tavily':
      return fetchTavily(query, apiKey, signal)
    case 'exa':
      return fetchExa(query, apiKey, signal)
    case 'brave':
      return fetchBrave(query, apiKey, signal)
    case 'serper':
      return fetchSerper(query, apiKey, signal)
    case 'serpapi':
      return fetchSerpApi(query, apiKey, signal)
    case 'linkup':
      return fetchLinkup(query, apiKey, signal)
    case 'you':
      return fetchYou(query, apiKey, signal)
    case 'firecrawl':
      return fetchFirecrawl(query, apiKey, signal)
    case 'tinyfish':
      return fetchTinyFish(query, apiKey, signal)
    case 'searchapi':
      return fetchSearchApi(query, apiKey, signal)
    case 'parallel':
      return fetchParallel(query, apiKey, signal)
    case 'browserbase':
      return fetchBrowserbase(query, apiKey, signal)
    case 'keenable':
      return fetchKeenable(query, apiKey, signal)
    default:
      throw new Error(`Unknown provider: ${providerId}`)
  }
}

function extractArray(json: unknown, key: string): unknown[] {
  if (!json || typeof json !== 'object') throw new Error('Invalid response')
  const obj = json as Record<string, unknown>
  const arr = obj[key]
  if (!Array.isArray(arr)) throw new Error(`Missing ${key} array in response`)
  return arr
}

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { ...init, signal })
  if (response.status === 429) throw new Error('Rate limited')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<unknown>
}

async function fetchTavily(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const json = await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 5 }),
  }, signal)
  return extractArray(json, 'results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.content, url: item.url }
  })
}

async function fetchExa(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const json = await fetchJson('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query, numResults: 5, contents: { text: { maxCharacters: 1000 } } }),
  }, signal)
  return extractArray(json, 'results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.text ?? '', url: item.url }
  })
}

async function fetchBrave(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const params = new URLSearchParams({ q: query, count: '5' })
  const json = await fetchJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
  }, signal)
  const obj = json as Record<string, unknown>
  const web = obj.web as Record<string, unknown> | undefined
  return extractArray(web ?? {}, 'results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.description, url: item.url }
  })
}

async function fetchSerper(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const json = await fetchJson('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ q: query, num: 5 }),
  }, signal)
  return extractArray(json, 'organic').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.snippet, url: item.link }
  })
}

async function fetchSerpApi(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const params = new URLSearchParams({ q: query, num: '5', api_key: apiKey, engine: 'google' })
  const json = await fetchJson(`https://serpapi.com/search.json?${params}`, {}, signal)
  return extractArray(json, 'organic_results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.snippet, url: item.link }
  })
}

async function fetchLinkup(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const json = await fetchJson('https://api.linkup.so/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ q: query, depth: 'standard', outputType: 'searchResults' }),
  }, signal)
  return extractArray(json, 'results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.name, snippet: item.content, url: item.url }
  })
}

async function fetchYou(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const params = new URLSearchParams({ query, count: '5' })
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey) headers['x-api-key'] = apiKey
  const json = await fetchJson(`https://api.ydc-index.io/search?${params}`, { headers }, signal)
  return extractArray(json, 'hits').map((r) => {
    const item = r as Record<string, unknown>
    const snippets = item.snippets as string[] | undefined
    return { title: item.title, snippet: snippets?.[0] ?? item.description ?? '', url: item.url }
  })
}

async function fetchFirecrawl(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const json = await fetchJson('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, limit: 5 }),
  }, signal)
  return extractArray(json, 'data').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title ?? item.metadata, snippet: item.description ?? item.markdown ?? '', url: item.url }
  })
}

async function fetchTinyFish(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const json = await fetchJson('https://api.tinyfish.io/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 5 }),
  }, signal)
  return extractArray(json, 'results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.snippet ?? item.content ?? '', url: item.url }
  })
}

async function fetchSearchApi(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const params = new URLSearchParams({ q: query, num: '5', api_key: apiKey, engine: 'google' })
  const json = await fetchJson(`https://www.searchapi.io/api/v1/search?${params}`, {}, signal)
  return extractArray(json, 'organic_results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.snippet, url: item.link }
  })
}

async function fetchParallel(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const json = await fetchJson('https://api.parallel.ai/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 5 }),
  }, signal)
  return extractArray(json, 'results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.snippet ?? item.content ?? '', url: item.url }
  })
}

async function fetchBrowserbase(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const json = await fetchJson('https://api.browserbase.com/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query, max_results: 5 }),
  }, signal)
  return extractArray(json, 'results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.snippet ?? item.content ?? '', url: item.url }
  })
}

async function fetchKeenable(query: string, apiKey: string, signal: AbortSignal): Promise<unknown[]> {
  const params = new URLSearchParams({ q: query, limit: '5' })
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const json = await fetchJson(`https://api.keenable.com/v1/search?${params}`, { headers }, signal)
  return extractArray(json, 'results').map((r) => {
    const item = r as Record<string, unknown>
    return { title: item.title, snippet: item.snippet ?? item.description ?? '', url: item.url }
  })
}
