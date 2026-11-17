import type { GoogleGenAI } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GEMINI_API_VERSION, createGeminiClient } from '../../src/gemini/client.js';

/** One SDK surface the server calls, the request it makes, and a body the SDK accepts as its answer. */
interface Surface {
  readonly name: string;
  readonly call: (client: GoogleGenAI) => Promise<unknown>;
  readonly path: string;
  readonly answer: unknown;
}

const MODEL = 'gemini-test-model';
const CACHE = 'cachedContents/abc123';
const CONTENTS = [{ role: 'user', parts: [{ text: 'hello' }] }];

const SURFACES: readonly Surface[] = [
  {
    name: 'caches.create',
    call: (c) => c.caches.create({ model: MODEL, config: { contents: CONTENTS, ttl: '300s' } }),
    path: 'cachedContents',
    answer: { name: CACHE },
  },
  {
    name: 'caches.update',
    call: (c) => c.caches.update({ name: CACHE, config: { ttl: '300s' } }),
    path: CACHE,
    answer: { name: CACHE },
  },
  {
    name: 'caches.delete',
    call: (c) => c.caches.delete({ name: CACHE }),
    path: CACHE,
    answer: {},
  },
  {
    name: 'files.delete',
    call: (c) => c.files.delete({ name: 'files/abc123' }),
    path: 'files/abc123',
    answer: {},
  },
  {
    name: 'models.list',
    call: (c) => c.models.list(),
    path: 'models',
    answer: { models: [] },
  },
  {
    name: 'models.countTokens',
    call: (c) => c.models.countTokens({ model: MODEL, contents: CONTENTS }),
    path: `models/${MODEL}:countTokens`,
    answer: { totalTokens: 1 },
  },
  {
    name: 'models.generateContent',
    call: (c) => c.models.generateContent({ model: MODEL, contents: CONTENTS }),
    path: `models/${MODEL}:generateContent`,
    answer: { candidates: [] },
  },
];

/** Replaces `fetch` with a stub that answers `body` (and `headers`) and records every URL the SDK requests. */
function captureRequests(body: unknown, headers: Record<string, string> = {}): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', ...headers },
      });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createGeminiClient (API key) — the API version on the wire', () => {
  it.each(SURFACES)('$name goes to the v1beta resource', async (surface) => {
    const urls = captureRequests(surface.answer);
    const client = createGeminiClient({ kind: 'api-key', apiKey: 'test-key' });

    await surface.call(client);

    expect(urls).toHaveLength(1);
    const { pathname } = new URL(urls[0] ?? '');
    expect(pathname).toBe(`/${GEMINI_API_VERSION}/${surface.path}`);
  });

  it('files.upload starts its resumable upload at the v1beta upload resource', async () => {
    const urls = captureRequests(
      { file: { name: 'files/abc123' } },
      {
        'x-goog-upload-url': 'https://upload.invalid/session',
        'x-goog-upload-status': 'final',
      },
    );
    const client = createGeminiClient({ kind: 'api-key', apiKey: 'test-key' });

    await client.files.upload({ file: new Blob(['hello']), config: { mimeType: 'text/plain' } });

    expect(new URL(urls[0] ?? '').pathname).toBe(`/upload/${GEMINI_API_VERSION}/files`);
  });

  it('keeps v1beta when GOOGLE_GENAI_API_VERSION names another version', async () => {
    vi.stubEnv('GOOGLE_GENAI_API_VERSION', 'v1');
    const urls = captureRequests({ name: CACHE });
    const client = createGeminiClient({ kind: 'api-key', apiKey: 'test-key' });

    await client.caches.create({ model: MODEL, config: { contents: CONTENTS, ttl: '300s' } });

    expect(new URL(urls[0] ?? '').pathname).toBe('/v1beta/cachedContents');
  });
});
