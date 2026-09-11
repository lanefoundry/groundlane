import type { Track } from './types'

export interface ProviderDefinition {
  id: string
  displayName: string
  tracks: Track[]
  estimatedCostPerCall_usd: number | null
  pricingModel: 'per_request' | 'per_credit' | 'subscription' | 'free'
  pricingNote: string
  mvp: boolean
}

export const PROVIDER_ROSTER: ProviderDefinition[] = [
  {
    id: 'tavily',
    displayName: 'Tavily',
    tracks: ['search'],
    estimatedCostPerCall_usd: 0.008,
    pricingModel: 'per_credit',
    pricingNote: '1 credit = $0.008, 1,000 free credits/month',
    mvp: true,
  },
  {
    id: 'exa',
    displayName: 'Exa',
    tracks: ['search'],
    estimatedCostPerCall_usd: 0.005,
    pricingModel: 'per_request',
    pricingNote: '1,000 free requests/month',
    mvp: true,
  },
  {
    id: 'brave',
    displayName: 'Brave Search',
    tracks: ['search'],
    estimatedCostPerCall_usd: 0.003,
    pricingModel: 'per_request',
    pricingNote: '2,000 free queries/month',
    mvp: true,
  },
  {
    id: 'serper',
    displayName: 'Serper',
    tracks: ['search'],
    estimatedCostPerCall_usd: 0.004,
    pricingModel: 'per_request',
    pricingNote: '2,500 free queries',
    mvp: true,
  },
  {
    id: 'serpapi',
    displayName: 'SerpApi',
    tracks: ['search'],
    estimatedCostPerCall_usd: 0.01,
    pricingModel: 'per_request',
    pricingNote: '100 free searches/month',
    mvp: true,
  },
  {
    id: 'linkup',
    displayName: 'Linkup',
    tracks: ['search'],
    estimatedCostPerCall_usd: 0.005,
    pricingModel: 'per_credit',
    pricingNote: 'Free tier available',
    mvp: true,
  },
  {
    id: 'you',
    displayName: 'You.com',
    tracks: ['search'],
    estimatedCostPerCall_usd: null,
    pricingModel: 'free',
    pricingNote: 'Keyless daily MCP profile available',
    mvp: true,
  },
  {
    id: 'firecrawl',
    displayName: 'Firecrawl',
    tracks: ['search'],
    estimatedCostPerCall_usd: 0.01,
    pricingModel: 'per_credit',
    pricingNote: '500 free credits',
    mvp: true,
  },
]

export function getMvpProviders(): ProviderDefinition[] {
  return PROVIDER_ROSTER.filter((p) => p.mvp)
}
