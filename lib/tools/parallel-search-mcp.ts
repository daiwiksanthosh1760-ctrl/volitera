import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const SEARCH_TIMEOUT_MS = 30_000;
const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      url: z.url().refine((url) => /^https?:\/\//i.test(url), 'Expected an HTTP(S) URL'),
      title: z.string().nullable().optional(),
      excerpts: z.array(z.string()),
      publish_date: z.string().nullable().optional(),
    }),
  ),
});

export async function parallelMcpSearch(
  queries: string[],
  { abortSignal, sessionId }: { abortSignal?: AbortSignal; sessionId?: string } = {},
) {
  const signal = AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), ...(abortSignal ? [abortSignal] : [])]);
  signal.throwIfAborted();
  const client = new Client({ name: 'volitera', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://search.parallel.ai/mcp'), {
    requestInit: {
      headers: { 'User-Agent': 'Volitera/0.1.0 (https://github.com/daiwiksanthosh1760-ctrl/volitera)' },
      redirect: 'error',
    },
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      }),
  });
  // Bound initialization, discovery, execution and cleanup by one deadline.
  const abort = () => void transport.close().catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(transport);
    signal.throwIfAborted();
    const { tools } = await client.listTools({}, { signal });
    if (!tools.some((tool) => tool.name === 'web_search')) throw new Error('Parallel MCP did not expose web_search');
    const response = await client.callTool(
      {
        name: 'web_search',
        arguments: {
          objective: queries.join('; '),
          search_queries: queries,
          ...(sessionId ? { session_id: sessionId } : {}),
        },
      },
      undefined,
      { signal },
    );
    signal.throwIfAborted();
    // MCP structuredContent is preferred; older servers encode the same object
    // in a text block. Never treat tool errors or malformed output as no results.
    const envelope = response as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };
    if (envelope.isError) {
      throw new Error(envelope.content?.find((part) => part.type === 'text')?.text || 'Parallel MCP search failed');
    }
    const payload =
      envelope.structuredContent ?? JSON.parse(envelope.content?.find((part) => part.type === 'text')?.text || 'null');
    return searchResponseSchema.parse(payload).results.map((result) => ({
      url: result.url,
      title: result.title || new URL(result.url).hostname,
      content: result.excerpts.join('\n\n'),
      published_date: result.publish_date || undefined,
      author: undefined,
    }));
  } finally {
    signal.removeEventListener('abort', abort);
    await client.close().catch(() => {});
  }
}
