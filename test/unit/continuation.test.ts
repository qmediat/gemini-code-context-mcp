import type { GenerateContentResponse } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { type OpenDecodeRequest, collectDecode } from '../../src/tools/shared/continuation.js';
import { chunkedStream } from '../helpers/stream-mock.js';

/** One request's stream: a thought, the request's text (if any), and its end with the given finish reason. */
function request(opts: {
  thought: string;
  text?: string;
  finishReason: 'CONTINUATION' | 'STOP' | 'MAX_TOKENS';
  token?: string;
  thoughts: number;
  output: number;
  prompt: number;
}): Array<Partial<GenerateContentResponse>> {
  const chunks: Array<Partial<GenerateContentResponse>> = [
    {
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ text: opts.thought, thought: true }] } },
      ],
    },
  ];
  if (opts.text !== undefined) {
    chunks.push({
      text: opts.text,
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: opts.text }] } }],
    });
  }
  chunks.push({
    candidates: [
      {
        index: 0,
        finishReason: opts.finishReason as never,
        ...(opts.token !== undefined ? { continuationToken: opts.token } : {}),
      },
    ],
    usageMetadata: {
      promptTokenCount: opts.prompt,
      cachedContentTokenCount: 0,
      candidatesTokenCount: opts.output,
      thoughtsTokenCount: opts.thoughts,
      totalTokenCount: opts.prompt + opts.output + opts.thoughts,
    },
  });
  return chunks;
}

function opener(...requests: Array<Array<Partial<GenerateContentResponse>>>): {
  open: OpenDecodeRequest;
  tokens: Array<string | undefined>;
} {
  const tokens: Array<string | undefined> = [];
  const open = vi.fn(async (token: string | undefined) => {
    tokens.push(token);
    const next = requests[tokens.length - 1];
    if (next === undefined) throw new Error('unexpected extra request');
    return chunkedStream(next)();
  });
  return { open, tokens };
}

const LIMITS = { maxRequests: 4, cap: 262_144 };

/** A request that thinks through the per-request limit and stops with CONTINUATION and `token`. */
const stop = (token: string) =>
  request({
    thought: 't',
    finishReason: 'CONTINUATION',
    token,
    thoughts: 65_533,
    output: 3,
    prompt: 1_000,
  });

describe('collectDecode', () => {
  it('continues a CONTINUATION stop with its token and merges the requests into one answer', async () => {
    const { open, tokens } = opener(
      request({
        thought: 'plan A',
        finishReason: 'CONTINUATION',
        token: 'tok-1',
        thoughts: 65_533,
        output: 3,
        prompt: 99_712,
      }),
      request({
        thought: 'plan B',
        text: 'the answer',
        finishReason: 'STOP',
        thoughts: 20_197,
        output: 1_045,
        prompt: 165_373,
      }),
    );
    const decoded = await collectDecode(open, LIMITS, {});
    expect(tokens).toEqual([undefined, 'tok-1']);
    expect(decoded.continuationHops).toBe(1);
    expect(decoded.text).toBe('the answer');
    expect(decoded.thoughtsSummary).toBe('plan A\nplan B');
    expect(decoded.usageMetadata).toEqual({
      promptTokenCount: 265_085,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 1_048,
      thoughtsTokenCount: 85_730,
      totalTokenCount: 265_085 + 1_048 + 85_730,
    });
    expect(decoded.candidates?.[0]?.finishReason).toBe('STOP');
    expect(decoded.candidates?.[0]?.content?.parts?.map((p) => p.text)).toEqual([
      'plan A',
      'plan B',
      'the answer',
    ]);
  });

  it('stops at the request limit with the last stop CONTINUATION', async () => {
    const { open, tokens } = opener(stop('a'), stop('b'), stop('c'));
    const decoded = await collectDecode(open, { maxRequests: 2, cap: 1_048_576 }, {});
    expect(tokens).toEqual([undefined, 'a']);
    expect(decoded.continuationHops).toBe(1);
    expect(decoded.candidates?.[0]?.finishReason).toBe('CONTINUATION');
    expect(decoded.usageMetadata?.thoughtsTokenCount).toBe(131_066);
  });

  it('stops once the decoded tokens reach the cap', async () => {
    const { open, tokens } = opener(stop('a'), stop('b'));
    const decoded = await collectDecode(open, { maxRequests: 16, cap: 65_536 }, {});
    expect(tokens).toEqual([undefined]);
    expect(decoded.continuationHops).toBe(0);
  });

  it('never continues a request that stopped for another reason, a token on it or not', async () => {
    const { open, tokens } = opener(
      request({
        thought: 't',
        finishReason: 'MAX_TOKENS',
        token: 'x',
        thoughts: 65_536,
        output: 0,
        prompt: 1_000,
      }),
    );
    const decoded = await collectDecode(open, LIMITS, {});
    expect(tokens).toEqual([undefined]);
    expect(decoded.continuationHops).toBe(0);
    expect(decoded.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');
  });

  it('returns a one-request decode as the collector made it, with no hops', async () => {
    const { open } = opener(
      request({
        thought: 'only',
        text: 'done',
        finishReason: 'STOP',
        thoughts: 10,
        output: 2,
        prompt: 50,
      }),
    );
    const decoded = await collectDecode(open, LIMITS, {});
    expect(decoded.continuationHops).toBe(0);
    expect(decoded.text).toBe('done');
    expect(decoded.usageMetadata?.promptTokenCount).toBe(50);
  });
});
