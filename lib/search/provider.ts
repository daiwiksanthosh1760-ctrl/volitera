export type SearchProvider = 'auto' | 'exa' | 'parallel' | 'firecrawl' | 'parallel-mcp';
export type ResolvedSearchProvider = Exclude<SearchProvider, 'auto'>;

export function resolveSearchProvider(
  provider: SearchProvider = 'auto',
  credentials: { FIRECRAWL_API_KEY?: string; EXA_API_KEY?: string; PARALLEL_API_KEY?: string },
): ResolvedSearchProvider {
  if (provider !== 'auto') {
    if (['exa', 'parallel', 'firecrawl', 'parallel-mcp'].includes(provider)) return provider;
    throw new Error('Unknown web search provider');
  }
  // Keep configured deployments on a credentialed provider. A saved selection
  // always takes precedence over this fresh-installation choice.
  if (credentials.FIRECRAWL_API_KEY?.trim()) return 'firecrawl';
  if (credentials.EXA_API_KEY?.trim()) return 'exa';
  if (credentials.PARALLEL_API_KEY?.trim()) return 'parallel';
  return 'parallel-mcp';
}
