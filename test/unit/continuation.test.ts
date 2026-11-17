import { ApiError, type GenerateContentResponse, type GoogleGenAI } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import type { ManifestDb } from '../../src/manifest/db.js';
import { settleFailedCall } from '../../src/tools/shared/call-ledger.js';
import {
  CompletedRequests,
  type DecodeCall,
  type OpenDecodeRequest,
  collectDecode,
  runDecode,
} from '../../src/tools/shared/continuation.js';
import { DispatchThrottle } from '../../src/tools/shared/dispatch-throttle.js';
import { createTpmThrottle } from '../../src/tools/shared/throttle.js';
import { chunkedStream } from '../helpers/stream-mock.js';

/** One request's stream: a thought, the request's text (if any), and its end with the given finish reason. */
function request(opts: {
  thought: string;
  text?: string;
  finishReason: 'CONTINUATION' | 'STOP' | 'MAX_TOKENS';
  token?: string;
  /** A checkpoint token on a chunk before the end, with no finish reason (the SDK emits them partway through). */
  checkpoint?: string;
  thoughts: number;
  output: number;
  prompt: number;
}): Array<Partial<GenerateContentResponse>> {
  const chunks: Array<Partial<GenerateContentResponse>> = [
    {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: opts.thought, thought: true }] },
          ...(opts.checkpoint !== undefined ? { continuationToken: opts.checkpoint } : {}),
        },
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
        content: { role: 'model', parts: [] },
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

describe('collectDecode — progress and checkpoints', () => {
  /** A stop with CONTINUATION that decoded `decoded` tokens and returned `token`. */
  const stopWith = (token: string, decoded: number) =>
    request({
      thought: 't',
      finishReason: 'CONTINUATION',
      token,
      thoughts: decoded,
      output: 0,
      prompt: 500_000,
    });

  it('stops when a request returns the token it was opened with: two requests, not the request limit', async () => {
    const { open, tokens } = opener(...Array.from({ length: 16 }, () => stopWith('same', 65_536)));
    const decoded = await collectDecode(open, { maxRequests: 16, cap: 1_048_576 }, {});
    expect(tokens).toEqual([undefined, 'same']);
    expect(decoded.continuationHops).toBe(1);
    expect(decoded.candidates?.[0]?.finishReason).toBe('CONTINUATION');
  });

  it('stops when a request decoded no token, whatever token it returned', async () => {
    const { open, tokens } = opener(stopWith('a', 65_536), stopWith('b', 0), stopWith('c', 65_536));
    const decoded = await collectDecode(open, { maxRequests: 16, cap: 1_048_576 }, {});
    expect(tokens).toEqual([undefined, 'a']);
    expect(decoded.continuationHops).toBe(1);
  });

  it('continues with the final token of a request that also passed a checkpoint', async () => {
    const { open, tokens } = opener(
      request({
        thought: 'plan',
        finishReason: 'CONTINUATION',
        checkpoint: 'ck-1',
        token: 'tok-1',
        thoughts: 65_536,
        output: 0,
        prompt: 1_000,
      }),
      request({
        thought: 'more',
        text: 'answer',
        finishReason: 'STOP',
        checkpoint: 'ck-2',
        thoughts: 10,
        output: 1,
        prompt: 66_661,
      }),
    );
    const decoded = await collectDecode(open, LIMITS, {});
    expect(tokens).toEqual([undefined, 'tok-1']);
    expect(decoded.text).toBe('answer');
    expect(decoded.candidates?.[0]?.finishReason).toBe('STOP');
  });

  it('continues with the checkpoint token when the CONTINUATION stop itself carries none', async () => {
    const { open, tokens } = opener(
      request({
        thought: 'plan',
        finishReason: 'CONTINUATION',
        checkpoint: 'ck-1',
        thoughts: 65_536,
        output: 0,
        prompt: 1_000,
      }),
      request({
        thought: 'more',
        text: 'done',
        finishReason: 'STOP',
        thoughts: 1,
        output: 1,
        prompt: 2,
      }),
    );
    await collectDecode(open, LIMITS, {});
    expect(tokens).toEqual([undefined, 'ck-1']);
  });

  it('calls the hooks between the requests with the usage and the next input', async () => {
    const after: Array<number | undefined> = [];
    const before: number[] = [];
    const { open } = opener(stop('a'), stop('b'), stop('c'));
    await collectDecode(
      open,
      { maxRequests: 3, cap: 1_048_576 },
      {},
      {
        afterRequest: (usage) => after.push(usage?.promptTokenCount),
        beforeContinuation: async (inputTokens) => {
          before.push(inputTokens);
        },
      },
    );
    expect(after).toEqual([1_000, 1_000, 1_000]);
    // the first request's prompt plus every token decoded so far
    expect(before).toEqual([1_000 + 65_536, 1_000 + 2 * 65_536]);
  });
});

describe('runDecode — the openings of a long decode', () => {
  /** A decode call over a client whose `generateContentStream` is the given mock. */
  const decodeCall = (
    generateContentStream: ReturnType<typeof vi.fn>,
    overrides: Partial<DecodeCall> = {},
  ): DecodeCall => ({
    client: { models: { generateContentStream } } as unknown as GoogleGenAI,
    model: 'gemini-4-hydrogen',
    contents: 'review',
    config: { maxOutputTokens: 262_144 },
    openAttempts: 3,
    label: 'test',
    limits: { maxRequests: 4, cap: 262_144 },
    collector: { signal: new AbortController().signal },
    onRequestOpened: () => {},
    completed: new CompletedRequests(),
    ...overrides,
  });
  const tokensSent = (mock: ReturnType<typeof vi.fn>): unknown[] =>
    mock.mock.calls.map(
      (call) => (call[0] as { config: { continuationToken?: string } }).config.continuationToken,
    );
  const answer = request({
    thought: 'more',
    text: 'done',
    finishReason: 'STOP',
    thoughts: 10,
    output: 2,
    prompt: 66_661,
  });
  const quota = () =>
    new ApiError({
      message: '{"error":{"code":429,"details":[{"retryDelay":"1s"}]}}',
      status: 429,
    });

  it('reopens a continuation request refused with 429 after the hint, with the same token', async () => {
    const stream = vi
      .fn()
      .mockImplementationOnce(chunkedStream(stop('tok-1')))
      .mockRejectedValueOnce(quota())
      .mockImplementationOnce(chunkedStream(answer));
    const call = decodeCall(stream);
    const started = Date.now();
    const decoded = await runDecode(call);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(tokensSent(stream)).toEqual([undefined, 'tok-1', 'tok-1']);
    expect(decoded.text).toBe('done');
    expect(call.completed.count).toBe(2);
    expect(call.completed.continuationHops()).toBe(1);
  });

  it('reopens a continuation request refused with 503 after the base wait', async () => {
    const overloaded = Object.assign(new Error('The model is overloaded'), { status: 503 });
    const stream = vi
      .fn()
      .mockImplementationOnce(chunkedStream(stop('tok-1')))
      .mockRejectedValueOnce(overloaded)
      .mockImplementationOnce(chunkedStream(answer));
    const decoded = await runDecode(decodeCall(stream));
    expect(tokensSent(stream)).toEqual([undefined, 'tok-1', 'tok-1']);
    expect(decoded.text).toBe('done');
  });

  it('retries a continuation opening that failed in transit with the same token', async () => {
    const stream = vi
      .fn()
      .mockImplementationOnce(chunkedStream(stop('tok-1')))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(chunkedStream(answer));
    const call = decodeCall(stream);
    const decoded = await runDecode(call);
    expect(tokensSent(stream)).toEqual([undefined, 'tok-1', 'tok-1']);
    expect(decoded.continuationHops).toBe(1);
    expect(call.completed.continuationHops()).toBe(1);
  });

  it('never reopens a refused first request, nor a continuation on a one-attempt (flex) call', async () => {
    const first = vi.fn().mockRejectedValueOnce(quota());
    await expect(runDecode(decodeCall(first))).rejects.toBeInstanceOf(ApiError);
    expect(first).toHaveBeenCalledTimes(1);

    const flex = vi
      .fn()
      .mockImplementationOnce(chunkedStream(stop('tok-1')))
      .mockRejectedValueOnce(quota());
    await expect(runDecode(decodeCall(flex, { openAttempts: 1 }))).rejects.toBeInstanceOf(ApiError);
    expect(flex).toHaveBeenCalledTimes(2);
  });

  it('network failures and refusals share one opening budget: at most openAttempts SDK calls per request', async () => {
    vi.useFakeTimers();
    try {
      const overloaded = () => Object.assign(new Error('The model is overloaded'), { status: 503 });
      const stream = vi.fn().mockImplementationOnce(chunkedStream(stop('tok-1')));
      for (let i = 0; i < 4; i += 1) {
        stream.mockRejectedValueOnce(new TypeError('fetch failed'));
        stream.mockRejectedValueOnce(overloaded());
      }
      stream.mockImplementation(chunkedStream(answer));

      const decoded = runDecode(decodeCall(stream, { openAttempts: 3 })).catch(
        (err: unknown) => err,
      );
      await vi.runAllTimersAsync();

      expect(await decoded).toBeInstanceOf(TypeError);
      // the first request, then the continuation's three openings: fetch failed, 503, fetch failed
      expect(stream).toHaveBeenCalledTimes(1 + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reopening after a wait longer than the TPM window reserves again: a concurrent request waits', async () => {
    vi.useFakeTimers();
    try {
      const limit = 100_000;
      const input = 60_000;
      const throttle = createTpmThrottle(limit);
      const signal = new AbortController().signal;
      const dispatch = new DispatchThrottle({ throttle, enabled: true, signal, emit: () => {} });
      const longQuota = new ApiError({
        message: '{"error":{"code":429,"details":[{"retryDelay":"61s"}]}}',
        status: 429,
      });
      let concurrentDelayMs: number | undefined;
      const stream = vi
        .fn()
        .mockImplementationOnce(chunkedStream(stop('tok-1')))
        .mockRejectedValueOnce(longQuota)
        .mockImplementationOnce(() => {
          // the reopened continuation goes out now: a request of another call reserves beside it
          concurrentDelayMs = throttle.reserve('gemini-4-hydrogen', input).delayMs;
          return chunkedStream(answer)();
        });
      const call = decodeCall(stream, {
        collector: { signal },
        beforeReopen: () => dispatch.renew(),
        hooks: { beforeContinuation: () => dispatch.reserve('gemini-4-hydrogen', input) },
      });

      const decoded = runDecode(call);
      await vi.runAllTimersAsync();
      await decoded;

      // two 60 000-token inputs within one minute would pass the 100 000 limit: the second one waits
      expect(stream).toHaveBeenCalledTimes(3);
      expect(concurrentDelayMs).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an abort between two requests sends no further request and counts none on the failed call', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Timed out after 1000 ms (total wall-clock)', 'TimeoutError');
    async function* firstThenAbort(): AsyncGenerator<GenerateContentResponse> {
      for (const chunk of stop('tok-1')) yield chunk as GenerateContentResponse;
      controller.abort(reason);
    }
    const stream = vi.fn().mockImplementationOnce(async () => firstThenAbort());
    const call = decodeCall(stream, { collector: { signal: controller.signal } });
    await expect(runDecode(call)).rejects.toBe(reason);
    expect(stream).toHaveBeenCalledTimes(1);

    const manifest = { insertUsageMetric: vi.fn() } as unknown as ManifestDb;
    const failed = settleFailedCall(manifest, {
      toolName: 'ask',
      reservationId: null,
      entry: {
        workspaceRoot: '/w',
        toolName: 'ask',
        model: 'gemini-4-hydrogen',
        serviceTier: undefined,
        cachingMode: 'implicit',
      },
      completed: call.completed,
      durationMs: 1,
    });
    expect(failed?.continuationHops).toBe(0);
    expect(failed?.thinkingTokens).toBe(65_533);
  });
});
