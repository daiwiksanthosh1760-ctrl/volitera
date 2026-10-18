import { afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { resolveSearchProvider } from '../lib/search/provider';
// Isolate search credentials; unrelated application services are not contacted.
for (const key of `XAI_API_KEY OPENAI_API_KEY GROQ_API_KEY GOOGLE_GENERATIVE_AI_API_KEY DAYTONA_API_KEY
DATABASE_URL BETTER_AUTH_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
TWITTER_CLIENT_ID TWITTER_CLIENT_SECRET REDIS_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
ELEVENLABS_API_KEY TAVILY_API_KEY VALYU_API_KEY TMDB_API_KEY YT_ENDPOINT OPENWEATHER_API_KEY
GOOGLE_MAPS_API_KEY AMADEUS_API_KEY AMADEUS_API_SECRET CRON_SECRET BLOB_READ_WRITE_TOKEN SMITHERY_API_KEY
COINGECKO_API_KEY SUPADATA_API_KEY QSTASH_TOKEN RESEND_API_KEY SUPERMEMORY_API_KEY SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET MCP_CREDENTIALS_ENCRYPTION_KEY`.split(/\s+/))
  process.env[key] = 'unused-test-key';
for (const key of ['EXA_API_KEY', 'PARALLEL_API_KEY', 'FIRECRAWL_API_KEY']) delete process.env[key];
mock.module('server-only', () => ({}));
let loadConfiguredTools;
beforeAll(async () => {
  ({ loadConfiguredTools } = await import('../lib/search/tool-loader'));
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});
const queries = ['TypeScript release notes', 'TypeScript latest release', 'TypeScript official documentation'],
  source = {
    url: 'https://www.typescriptlang.org/docs/',
    title: 'TypeScript docs',
    excerpts: ['Typed JavaScript documentation.'],
  },
  requests = [];
function serveMcp(result = { results: [source] }, { textOnly = false, isError = false } = {}) {
  requests.length = 0;
  globalThis.fetch = mock(async (input, init) => {
    const url = input.toString(),
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, headers: new Headers(init?.headers), body, signal: init?.signal });
    if (body?.id === undefined) return new Response(null, { status: 202 });
    let payload;
    switch (body.method) {
      case 'initialize':
        payload = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        };
        break;
      case 'tools/list':
        payload = {
          tools: [
            {
              name: 'web_search',
              inputSchema: {
                type: 'object',
                properties: {
                  objective: { type: 'string' },
                  search_queries: { type: 'array', items: { type: 'string' } },
                },
                required: ['objective', 'search_queries'],
              },
            },
          ],
        };
        break;
      case 'tools/call':
        payload = {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          ...(!textOnly && !isError ? { structuredContent: result } : {}),
          ...(isError ? { isError: true } : {}),
        };
        break;
      default:
        throw new Error(`Unexpected MCP method: ${body.method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result: payload });
  });
}
async function configured(provider, names = ['web_search'], events = []) {
  return loadConfiguredTools({
    activeToolNames: names,
    dataStream: { write: (event) => events.push(event) },
    searchProvider: provider,
    searchSessionId: '52cc92bd-2294-4ef9-b99a-63439d17fb87',
    timezone: undefined,
    contextFiles: [],
    extremeSearchModel: undefined,
    includeMcpTools: false,
    mcpDynamicTools: {},
    lightweightUser: null,
    selectedConnectors: [],
  });
}
async function execute(provider, abortSignal) {
  return (await configured(provider)).web_search.execute(
    { queries },
    { toolCallId: 'test-search', messages: [], abortSignal },
  );
}
test('automatic selection respects configured credentials and explicit saved choices', () => {
  expect(resolveSearchProvider(undefined, {})).toBe('parallel-mcp');
  expect(resolveSearchProvider('auto', { FIRECRAWL_API_KEY: 'configured', EXA_API_KEY: 'configured' })).toBe(
    'firecrawl',
  );
  expect(resolveSearchProvider('auto', { EXA_API_KEY: 'configured' })).toBe('exa');
  expect(resolveSearchProvider('auto', { PARALLEL_API_KEY: 'configured' })).toBe('parallel');
  for (const provider of ['exa', 'parallel', 'firecrawl', 'parallel-mcp'])
    expect(resolveSearchProvider(provider, { FIRECRAWL_API_KEY: 'configured' })).toBe(provider);
  expect(() => resolveSearchProvider('unknown', {})).toThrow('Unknown');
});
test('disabled search and tool permissions prevent discovery and calls', async () => {
  serveMcp();
  expect(await configured('parallel-mcp', [])).toEqual({});
  expect(requests).toHaveLength(0);
});
test('keyless loader supports neighboring URL tool and citation-compatible results', async () => {
  serveMcp();
  const events = [],
    tools = await configured(undefined, ['web_search', 'retrieve'], events),
    result = await tools.web_search.execute({ queries }, { toolCallId: 'test', messages: [] });
  expect(tools.retrieve).toBeDefined();
  expect(result.searches[0].results[0]).toMatchObject({
    url: source.url,
    title: source.title,
    content: source.excerpts[0],
  });
  expect(result.searches[0].images).toEqual([]);
  expect(events.map((event) => event.data.status)).toEqual(['started', 'completed']);
  const call = requests.find((request) => request.body?.method === 'tools/call');
  expect(call.body.params.arguments.search_queries).toEqual(queries);
  expect(call.body.params.arguments.session_id).toBe('52cc92bd-2294-4ef9-b99a-63439d17fb87');
  expect(requests.map((request) => request.body?.method)).toContain('tools/list');
  for (const request of requests) {
    expect(request.url).toBe('https://search.parallel.ai/mcp');
    expect(request.headers.get('user-agent')).toBe(
      'Volitera/0.1.0 (https://github.com/daiwiksanthosh1760-ctrl/volitera)',
    );
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('x-api-key')).toBe(false);
  }
});
test('scripted AI SDK loop consumes MCP output and cites the returned URL', async () => {
  serveMcp();
  let steps = 0;
  const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        steps++;
        if (steps === 1)
          return {
            content: [
              { type: 'tool-call', toolCallId: 'search', toolName: 'web_search', input: JSON.stringify({ queries }) },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            warnings: [],
          };
        const toolMessage = options.prompt.find((message) => message.role === 'tool');
        expect(JSON.stringify(toolMessage)).toContain(source.url);
        expect(JSON.stringify(toolMessage)).toContain(source.excerpts[0]);
        return {
          content: [{ type: 'text', text: `See [TypeScript documentation](${source.url}).` }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        };
      },
    }),
    result = await generateText({
      model,
      tools: await configured(),
      prompt: 'Find the TypeScript docs.',
      stopWhen: stepCountIs(2),
    });
  expect(steps).toBe(2);
  expect(result.text).toContain(source.url);
});
test('text-encoded MCP output and empty results preserve the response contract', async () => {
  serveMcp({ results: [source] }, { textOnly: true });
  expect((await execute('parallel-mcp')).searches[0].results[0].url).toBe(source.url);
  serveMcp({ results: [] });
  expect((await execute()).searches[0].results).toEqual([]);
  expect(requests.filter((request) => request.body?.method === 'tools/call')).toHaveLength(1);
});
test('explicit keyed providers with missing credentials fail without fallback', async () => {
  serveMcp();
  for (const provider of ['exa', 'parallel', 'firecrawl'])
    await expect(execute(provider)).rejects.toThrow('requires its API key');
  expect(requests).toHaveLength(0);
});
test('tool errors and malformed/unsafe source URLs are surfaced', async () => {
  serveMcp({ error: 'quota exhausted' }, { isError: true });
  await expect(execute()).rejects.toThrow();
  serveMcp({ results: [{ ...source, url: 'javascript:alert(1)' }] });
  await expect(execute()).rejects.toThrow();
  serveMcp({ unexpected: true });
  await expect(execute()).rejects.toThrow();
});
test('HTTP errors do not silently use another provider', async () => {
  const calls = [];
  globalThis.fetch = mock(async (url) => {
    calls.push(String(url));
    return new Response('Unavailable', { status: 503 });
  });
  await expect(execute()).rejects.toThrow();
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((url) => url === 'https://search.parallel.ai/mcp')).toBe(true);
});
test('already canceled requests make no network calls', async () => {
  serveMcp();
  await expect(execute(undefined, AbortSignal.abort())).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
for (const phase of ['initialize', 'tools/list', 'tools/call'])
  test(`cancellation interrupts ${phase}`, async () => {
    serveMcp();
    const fixtureFetch = globalThis.fetch,
      controller = new AbortController();
    let observedSignal;
    globalThis.fetch = mock(async (url, init) => {
      if ((typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)?.method !== phase)
        return fixtureFetch(url, init);
      observedSignal = init?.signal;
      queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
      );
    });
    await expect(execute(undefined, controller.signal)).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });
test('deadline aborts a stalled initialization request', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    expect(milliseconds).toBe(30000);
    return timeout(10);
  });
  let observedSignal;
  globalThis.fetch = mock(async (_url, init) => {
    observedSignal = init?.signal;
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
    );
  });
  await expect(execute()).rejects.toThrow();
  expect(observedSignal?.aborted).toBe(true);
});
