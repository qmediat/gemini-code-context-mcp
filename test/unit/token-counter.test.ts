/**
 * Two-tier preflight token counter (v1.10.0, T17 closure).
 *
 * Verifies the contract documented in `src/gemini/token-counter.ts`:
 *
 *   - `'heuristic'` mode: never calls `client.models.countTokens`; returns
 *     bytes/4 estimate; `method: 'heuristic'`.
 *   - `'auto'` mode below cutoff (50% of inputTokenLimit): same as heuristic
 *     — fast path, no API call.
 *   - `'auto'` mode at/above cutoff: calls countTokens; adds
 *     `SYSTEM_INSTRUCTION_RESERVE`; populates cache.
 *   - `'exact'` mode: always calls countTokens regardless of size.
 *   - Cache hit: skip API call, return cached count + reserve.
 *   - Cache key: invalidates on `filesHash` / `prompt` / `model` / `globsHash`
 *     change.
 *   - 429 / network failure: log warn, return `bytes/3` fallback,
 *     `method: 'fallback'`. Never throws.
 *   - Malformed `totalTokens` from API: same fallback path.
 *   - File-content payload: tier-2 path reads each `file.absolutePath` and
 *     embeds it as a `// {relpath}\n{content}` part in the countTokens call;
 *     unreadable files substitute `'a'.repeat(file.size)`.
 *
 * Realistic-fidelity tests: we mock `client.models.countTokens` directly
 * (not the SDK transport), so the test exercises the production code path
 * end-to-end including SHA256 cache-key derivation, payload assembly, and
 * graceful-degradation branching.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PreflightInput,
  SYSTEM_INSTRUCTION_RESERVE,
  clearTokenCounterCache,
  countForPreflight,
} from '../../src/gemini/token-counter.js';
import type { ScannedFile } from '../../src/indexer/workspace-scanner.js';

interface MockedClient {
  client: GoogleGenAI;
  countTokens: ReturnType<typeof vi.fn>;
}

function buildClient(impl?: (params: unknown) => Promise<unknown>): MockedClient {
  const countTokens = vi.fn(impl ?? (async () => ({ totalTokens: 100 })));
  const client = {
    models: { countTokens },
  } as unknown as GoogleGenAI;
  return { client, countTokens };
}

/** A scanned file pinned to a real on-disk path with the given content.
 * The token-counter reads `file.absolutePath`, so tier-2 paths need real
 * files. The temp dir is cleaned after the suite. */
async function realFile(dir: string, relpath: string, content: string): Promise<ScannedFile> {
  const absolutePath = path.join(dir, relpath);
  await writeFile(absolutePath, content, 'utf8');
  return {
    relpath,
    size: Buffer.byteLength(content, 'utf8'),
    contentHash: `h-${relpath}`,
    absolutePath,
  };
}

/** A scanned file with a fake `absolutePath` — readFile fails, the counter
 * substitutes `'a'.repeat(file.size)`. Mirrors the production fallback for
 * deleted/permission-error files. */
function fakeFile(relpath: string, size: number): ScannedFile {
  return {
    relpath,
    size,
    contentHash: `h-${relpath}`,
    absolutePath: `/no/such/path/${relpath}`,
  };
}

const baseInput = (
  files: ScannedFile[],
  overrides: Partial<PreflightInput> = {},
): PreflightInput => ({
  files,
  prompt: 'analyse this code',
  model: 'gemini-3-pro-preview',
  filesHash: 'workspace-hash-1',
  globsHash: '',
  inputTokenLimit: 1_048_576,
  ...overrides,
});

let tmpDir: string;

beforeEach(async () => {
  clearTokenCounterCache();
  tmpDir = await mkdtemp(path.join(tmpdir(), 'token-counter-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("countForPreflight — 'heuristic' mode", () => {
  it('returns bytes/4 estimate without calling countTokens', async () => {
    const { client, countTokens } = buildClient();
    const files = [fakeFile('a.ts', 4_000), fakeFile('b.ts', 8_000)];
    const result = await countForPreflight(
      client,
      baseInput(files, { preflightMode: 'heuristic' }),
    );

    // 12_000 bytes / 4 + 17 chars / 4 = 3_000 + 5 = 3_005
    expect(result.method).toBe('heuristic');
    expect(result.effectiveTokens).toBe(3_005);
    expect(result.rawTokens).toBe(3_005);
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('does NOT add SYSTEM_INSTRUCTION_RESERVE to heuristic count', async () => {
    // Heuristic mode is opt-in — users prioritize predictability over
    // accuracy. Adding a hidden reserve would be surprising.
    const { client } = buildClient();
    const result = await countForPreflight(
      client,
      baseInput([fakeFile('a.ts', 1_000)], { preflightMode: 'heuristic' }),
    );
    expect(result.effectiveTokens).toBe(result.rawTokens);
  });
});

describe("countForPreflight — 'auto' mode", () => {
  it('skips API when heuristic count is well below 50% of inputTokenLimit', async () => {
    const { client, countTokens } = buildClient();
    // 100_000 bytes / 4 = 25_000 tokens. inputTokenLimit = 1_048_576.
    // 25_000 < 524_288 (50%) → fast path.
    const result = await countForPreflight(
      client,
      baseInput([fakeFile('a.ts', 100_000)], { preflightMode: 'auto' }),
    );
    expect(result.method).toBe('heuristic');
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('omitting preflightMode is equivalent to "auto"', async () => {
    const { client, countTokens } = buildClient();
    const result = await countForPreflight(client, baseInput([fakeFile('a.ts', 100_000)]));
    expect(result.method).toBe('heuristic');
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('calls countTokens when heuristic is at/above 50% cutoff', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 600_000 }));
    // 2_400_000 bytes / 4 = 600_000 tokens. inputTokenLimit = 1_048_576.
    // 600_000 > 524_288 (50%) → tier-2 path.
    const file = await realFile(tmpDir, 'big.ts', 'x'.repeat(2_400_000));
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'auto' }));

    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(result.method).toBe('exact');
    expect(result.rawTokens).toBe(600_000);
    expect(result.effectiveTokens).toBe(600_000 + SYSTEM_INSTRUCTION_RESERVE);
  });
});

describe("countForPreflight — 'exact' mode", () => {
  it('always calls countTokens regardless of size', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 42 }));
    // Tiny workspace — heuristic-auto would skip API, but exact forces it.
    const file = await realFile(tmpDir, 'small.ts', 'hello');
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));

    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(result.method).toBe('exact');
    expect(result.rawTokens).toBe(42);
    expect(result.effectiveTokens).toBe(42 + SYSTEM_INSTRUCTION_RESERVE);
  });

  it('passes file content (not just filename) in the countTokens payload', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 7 }));
    const file = await realFile(tmpDir, 'feature.ts', 'export const PI = 3.14;');
    await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));

    expect(countTokens).toHaveBeenCalledTimes(1);
    const call = countTokens.mock.calls[0]?.[0] as {
      model: string;
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(call.model).toBe('gemini-3-pro-preview');
    const parts = call.contents[0]?.parts ?? [];
    // First part: file content with `// {relpath}\n` annotation.
    expect(parts[0]?.text).toContain('// feature.ts');
    expect(parts[0]?.text).toContain('export const PI = 3.14;');
    // Last part: prompt itself.
    expect(parts[parts.length - 1]?.text).toBe('analyse this code');
  });

  it('substitutes "a"-repetition placeholder for unreadable files', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 1 }));
    const file = fakeFile('missing.ts', 50);
    await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));

    const call = countTokens.mock.calls[0]?.[0] as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const firstPart = call.contents[0]?.parts[0]?.text ?? '';
    expect(firstPart).toContain('// missing.ts');
    expect(firstPart).toContain('a'.repeat(50));
  });
});

describe('countForPreflight — cache', () => {
  it('caches the exact count and skips API on second call with same key', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 700_000 }));
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_500_000));
    const input = baseInput([file], { preflightMode: 'auto' });

    const first = await countForPreflight(client, input);
    const second = await countForPreflight(client, input);

    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(first.method).toBe('exact');
    expect(second.method).toBe('exact');
    expect(second.effectiveTokens).toBe(first.effectiveTokens);
  });

  it('cache key invalidates when filesHash changes', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 500 }));
    const file = await realFile(tmpDir, 'a.ts', 'z'.repeat(10));
    await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', filesHash: 'workspace-hash-2' }),
    );
    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it('cache key invalidates when prompt changes', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 500 }));
    const file = await realFile(tmpDir, 'a.ts', 'z'.repeat(10));
    await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', prompt: 'different prompt' }),
    );
    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it('cache key invalidates when model changes', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 500 }));
    const file = await realFile(tmpDir, 'a.ts', 'z'.repeat(10));
    await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', model: 'gemini-2.5-pro' }),
    );
    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it('cache key invalidates when globsHash changes', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 500 }));
    const file = await realFile(tmpDir, 'a.ts', 'z'.repeat(10));
    await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', globsHash: 'glob-1' }),
    );
    await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', globsHash: 'glob-2' }),
    );
    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it('clearTokenCounterCache evicts everything', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 500 }));
    const file = await realFile(tmpDir, 'a.ts', 'z'.repeat(10));
    const input = baseInput([file], { preflightMode: 'exact' });

    await countForPreflight(client, input);
    expect(countTokens).toHaveBeenCalledTimes(1);

    clearTokenCounterCache();

    await countForPreflight(client, input);
    expect(countTokens).toHaveBeenCalledTimes(2);
  });
});

describe('countForPreflight — graceful degradation', () => {
  it('falls back to bytes/3 on countTokens 429', async () => {
    const { client, countTokens } = buildClient(async () => {
      throw new Error('429 RESOURCE_EXHAUSTED');
    });
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));

    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(result.method).toBe('fallback');
    // 2_400_000 / 3 + 'analyse this code'.length / 3 = 800_000 + ceil(17/3) = 800_006
    expect(result.effectiveTokens).toBe(800_006);
    expect(result.rawTokens).toBe(800_006);
  });

  it('falls back to bytes/3 on network error', async () => {
    const { client } = buildClient(async () => {
      throw new Error('fetch failed');
    });
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    expect(result.method).toBe('fallback');
  });

  it('falls back when totalTokens is missing from response', async () => {
    const { client } = buildClient(async () => ({}) as unknown);
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    expect(result.method).toBe('fallback');
  });

  it('falls back when totalTokens is non-numeric', async () => {
    const { client } = buildClient(async () => ({ totalTokens: 'not-a-number' }) as unknown);
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    expect(result.method).toBe('fallback');
  });

  it('falls back when totalTokens is negative', async () => {
    const { client } = buildClient(async () => ({ totalTokens: -5 }));
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    expect(result.method).toBe('fallback');
  });

  it('falls back when totalTokens is NaN/Infinity', async () => {
    const { client } = buildClient(async () => ({ totalTokens: Number.NaN }));
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    expect(result.method).toBe('fallback');
  });

  it('does NOT cache fallback results (so a transient 429 retries cleanly)', async () => {
    let callCount = 0;
    const { client, countTokens } = buildClient(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('429');
      return { totalTokens: 700_000 };
    });
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const input = baseInput([file], { preflightMode: 'exact' });

    const first = await countForPreflight(client, input);
    expect(first.method).toBe('fallback');

    const second = await countForPreflight(client, input);
    expect(second.method).toBe('exact');
    expect(countTokens).toHaveBeenCalledTimes(2);
  });
});

describe('countForPreflight — payload shape', () => {
  it('builds a single user-role content with one part per file plus a prompt part', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 99 }));
    const a = await realFile(tmpDir, 'a.ts', 'AAA');
    const b = await realFile(tmpDir, 'b.ts', 'BBB');
    await countForPreflight(client, baseInput([a, b], { preflightMode: 'exact' }));

    const call = countTokens.mock.calls[0]?.[0] as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(call.contents).toHaveLength(1);
    expect(call.contents[0]?.role).toBe('user');
    // 2 file parts + 1 prompt part
    expect(call.contents[0]?.parts).toHaveLength(3);
    expect(call.contents[0]?.parts[0]?.text).toContain('AAA');
    expect(call.contents[0]?.parts[1]?.text).toContain('BBB');
    expect(call.contents[0]?.parts[2]?.text).toBe('analyse this code');
  });

  it('does NOT pass systemInstruction (Q3 mitigation — Developer API rejects it)', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 99 }));
    const file = await realFile(tmpDir, 'a.ts', 'x');
    await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));

    const call = countTokens.mock.calls[0]?.[0] as Record<string, unknown>;
    // The reserve is added to the threshold at the call site, not via SDK config.
    expect(call.config).toBeUndefined();
  });
});
