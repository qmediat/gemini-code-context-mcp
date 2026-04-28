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
 *   - Cache key: invalidates on `filesHash` / `prompt` / `model` change.
 *     `filesHash` is post-glob-filter so glob changes that resolve to a
 *     different file set invalidate automatically — no separate
 *     `globsHash` axis needed.
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

  it('passes file content with the same `--- FILE: ---` marker that cache-manager uses', async () => {
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
    // First part must use the same marker as `cache-manager.ts`'s
    // `buildContentFromUploaded` / `buildInlineContentFromDisk` so the
    // counted bytes match the bytes the real `generateContent` will see.
    expect(parts[0]?.text).toContain('--- FILE: feature.ts ---');
    expect(parts[0]?.text).toContain('export const PI = 3.14;');
    // Marker is the v1.10.0 fix for the systematic ~6-8 token/file
    // undercount caused by the original `// ${relpath}\n` shape.
    expect(parts[0]?.text).not.toContain('// feature.ts');
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
    expect(firstPart).toContain('--- FILE: missing.ts ---');
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

  // NOTE: pre-v1.10.0 (round-2) the cache key also included a `globsHash`
  // axis; that proved redundant because `filesHash` is computed
  // post-glob-filter — so two glob configs resolving to the same file set
  // share `filesHash` and any glob change that affects the file set
  // already invalidates via `filesHash`. The redundant axis was dropped
  // (no test pinning it here).

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
    // The reserve is added to the count at the call site, not via SDK config.
    // When no `signal` is passed in PreflightInput, no `config` is sent at all.
    expect(call.config).toBeUndefined();
  });
});

describe('countForPreflight — cacheHit field (F7)', () => {
  it('returns cacheHit:false on heuristic path', async () => {
    const { client } = buildClient();
    const result = await countForPreflight(
      client,
      baseInput([fakeFile('a.ts', 1_000)], { preflightMode: 'heuristic' }),
    );
    expect(result.cacheHit).toBe(false);
  });

  it('returns cacheHit:false on fresh-API exact path', async () => {
    const { client } = buildClient(async () => ({ totalTokens: 42 }));
    const file = await realFile(tmpDir, 'a.ts', 'hello');
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    expect(result.method).toBe('exact');
    expect(result.cacheHit).toBe(false);
  });

  it('returns cacheHit:true on cached exact path', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 42 }));
    const file = await realFile(tmpDir, 'a.ts', 'hello');
    const input = baseInput([file], { preflightMode: 'exact' });
    await countForPreflight(client, input);
    const second = await countForPreflight(client, input);
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(second.method).toBe('exact');
    expect(second.cacheHit).toBe(true);
    expect(second.rawTokens).toBe(42);
  });

  it('returns cacheHit:false on fallback path', async () => {
    const { client } = buildClient(async () => {
      throw new Error('429');
    });
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const result = await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));
    expect(result.method).toBe('fallback');
    expect(result.cacheHit).toBe(false);
  });
});

describe('countForPreflight — AbortSignal threading (F1)', () => {
  it('passes config.abortSignal to countTokens when signal provided', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 42 }));
    const file = await realFile(tmpDir, 'a.ts', 'hello');
    const controller = new AbortController();
    await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', signal: controller.signal }),
    );

    const call = countTokens.mock.calls[0]?.[0] as { config?: { abortSignal?: AbortSignal } };
    expect(call.config?.abortSignal).toBe(controller.signal);
  });

  it('omits config entirely when signal not provided', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 42 }));
    const file = await realFile(tmpDir, 'a.ts', 'hello');
    await countForPreflight(client, baseInput([file], { preflightMode: 'exact' }));

    const call = countTokens.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.config).toBeUndefined();
  });

  it('RE-THROWS the SDK abort when the user-provided signal is aborted', async () => {
    // Round-2 (v1.10.0) correction: pre-v1.10.0 round-2 the catch
    // unconditionally fell back even on user-initiated abort. That
    // silently extended the user's `timeoutMs` budget — `ask` would
    // proceed to eager Files API upload before the abort eventually
    // landed on `generateContent`. The fix re-throws when
    // `input.signal?.aborted`, so the outer tool catch maps it to
    // `errorCode: 'TIMEOUT'` immediately.
    const sdkErr = new Error('Request aborted');
    sdkErr.name = 'AbortError';
    const { client } = buildClient(async () => {
      throw sdkErr;
    });
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const controller = new AbortController();
    controller.abort();

    await expect(
      countForPreflight(
        client,
        baseInput([file], { preflightMode: 'exact', signal: controller.signal }),
      ),
    ).rejects.toBe(sdkErr);
  });

  it('still falls back to heuristic on non-abort errors even when a signal is provided', async () => {
    // Defends the "abort-only re-throw" rule: a non-aborted signal must
    // not cause 429s / network errors to propagate; they still fall
    // through to bytes/3 graceful degradation.
    const { client } = buildClient(async () => {
      throw new Error('429 RESOURCE_EXHAUSTED');
    });
    const file = await realFile(tmpDir, 'big.ts', 'y'.repeat(2_400_000));
    const controller = new AbortController();
    // controller NOT aborted

    const result = await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', signal: controller.signal }),
    );
    expect(result.method).toBe('fallback');
    expect(result.cacheHit).toBe(false);
  });
});

describe('countForPreflight — payload-size cap', () => {
  it('falls back to heuristic when projected payload exceeds 32 MB', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 99 }));
    // 40 files × 1 MB each = 40 MB projected — over the 32 MB cap.
    // Use fakeFile so we don't actually write 40 MB to disk; the
    // pre-allocation cap check (F3 fix) fires BEFORE any 'a'.repeat
    // placeholder is materialized, so memory peak stays bounded.
    const files = Array.from({ length: 40 }, (_, i) => fakeFile(`f${i}.ts`, 1_000_000));
    const result = await countForPreflight(
      client,
      baseInput(files, { preflightMode: 'exact', inputTokenLimit: 1_000_000_000 }),
    );

    // Cap fired before all files were assembled — countTokens NEVER called.
    expect(countTokens).not.toHaveBeenCalled();
    expect(result.method).toBe('fallback');
    expect(result.cacheHit).toBe(false);
  });

  it('cap accounting uses UTF-8 BYTES, not UTF-16 code units (F1 fix)', async () => {
    // Critical for CJK / emoji repos. Without the F1 fix, `text.length`
    // (UTF-16 code units) lets CJK content slip past the byte cap by 3×.
    // This test pins the byte-accurate behaviour by constructing a
    // workspace whose UTF-16 length stays well under the cap but whose
    // UTF-8 byte count exceeds it, then asserting the cap fires.
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 99 }));
    // CJK char '中' = 1 UTF-16 unit, 3 UTF-8 bytes. 12 MB UTF-16 = 36 MB UTF-8.
    // 12 fakeFiles × 1 MB CJK each (UTF-8 bytes), but file.size is the
    // UTF-8 byte count we'd actually send. fakeFile uses the placeholder
    // path which materializes 'a'.repeat(file.size) — ASCII at 1:1, so
    // for byte-accurate testing we need file.size in UTF-8 bytes already.
    const files = Array.from({ length: 12 }, (_, i) => fakeFile(`cjk-${i}.ts`, 3_000_000));
    const result = await countForPreflight(
      client,
      baseInput(files, { preflightMode: 'exact', inputTokenLimit: 1_000_000_000 }),
    );
    // 12 × 3 MB = 36 MB > 32 MB cap → fallback before SDK call.
    expect(countTokens).not.toHaveBeenCalled();
    expect(result.method).toBe('fallback');
  });

  it('cap accounting includes the prompt bytes (F6 fix)', async () => {
    // Pre-fix: only file parts contributed to assembledBytes; a giant
    // prompt could push the actual `contents` payload past the cap
    // unnoticed. Post-fix: the prompt's UTF-8 byte length is added to
    // the cap accounting before the final SDK call.
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 99 }));
    // One small file (well under cap on its own), but a 33 MB prompt
    // pushes the total over.
    const file = fakeFile('small.ts', 1_000);
    const giantPrompt = 'a'.repeat(33 * 1024 * 1024);
    const result = await countForPreflight(
      client,
      baseInput([file], {
        preflightMode: 'exact',
        prompt: giantPrompt,
        inputTokenLimit: 1_000_000_000,
      }),
    );
    expect(countTokens).not.toHaveBeenCalled();
    expect(result.method).toBe('fallback');
  });
});

describe("countForPreflight — boundary at 'auto' cutoff (F8)", () => {
  it("uses heuristic strictly BELOW 50% of inputTokenLimit (uses '<', not '<=')", async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 99 }));
    // inputTokenLimit = 1_000_000; HEURISTIC_CUTOFF_FRACTION = 0.5 → cutoff = 500_000.
    // heuristicCount = bytes/4 + prompt/4. With prompt 'analyse this code' (17 chars),
    // promptTokens = ceil(17/4) = 5. So we need bytes/4 = 499_994 → bytes = 1_999_976.
    // Total heuristic = 499_994 + 5 = 499_999 < 500_000 → heuristic path.
    const justBelow = fakeFile('below.ts', 1_999_976);
    const result = await countForPreflight(
      client,
      baseInput([justBelow], { preflightMode: 'auto', inputTokenLimit: 1_000_000 }),
    );
    expect(result.method).toBe('heuristic');
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('crosses to exact AT or ABOVE the 50% cutoff', async () => {
    const { client, countTokens } = buildClient(async () => ({ totalTokens: 500_000 }));
    // bytes/4 = 499_995 + 5 = 500_000 = exactly cutoff → tier-2 (`<` is strict).
    const file = await realFile(tmpDir, 'at.ts', 'a'.repeat(1_999_980));
    const result = await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'auto', inputTokenLimit: 1_000_000 }),
    );
    expect(result.method).toBe('exact');
    expect(countTokens).toHaveBeenCalledTimes(1);
  });
});

describe('countForPreflight — LRU eviction (F8)', () => {
  it('evicts the oldest entry when capacity exceeded (cache size cap = 256)', async () => {
    // The LRU is module-level so we can fill it across many calls. Use
    // distinct cache keys (different filesHash per call). After 257
    // distinct entries, the very first should evict; calling with that
    // first key again must miss → fresh API call.
    let totalTokensCounter = 1_000_000;
    const { client, countTokens } = buildClient(async () => ({
      totalTokens: totalTokensCounter++,
    }));
    const file = await realFile(tmpDir, 'a.ts', 'hello');

    // Insert 257 distinct cache entries (1 over capacity).
    for (let i = 0; i < 257; i++) {
      await countForPreflight(
        client,
        baseInput([file], { preflightMode: 'exact', filesHash: `hash-${i}` }),
      );
    }
    // 257 fresh API calls so far.
    expect(countTokens).toHaveBeenCalledTimes(257);

    // The very first key (`hash-0`) should have been evicted as oldest.
    // Calling it again must trigger a fresh API call → 258 total.
    const re0 = await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', filesHash: 'hash-0' }),
    );
    expect(countTokens).toHaveBeenCalledTimes(258);
    expect(re0.cacheHit).toBe(false);

    // The most-recently-inserted key (`hash-256`) should still be cached.
    const re256 = await countForPreflight(
      client,
      baseInput([file], { preflightMode: 'exact', filesHash: 'hash-256' }),
    );
    // No additional API call — cache hit.
    expect(countTokens).toHaveBeenCalledTimes(258);
    expect(re256.cacheHit).toBe(true);
  });
});

describe('countForPreflight — concurrent calls with same key (F8)', () => {
  it('two concurrent calls both miss the cache, both fire API (no in-flight de-dupe)', async () => {
    // Pinning current behaviour: two concurrent `await countForPreflight(...)`
    // on the same cache key both miss because neither has populated the
    // cache yet. Result: 2 API calls per concurrent burst. Not a bug
    // today (countTokens is free) but pinned so a future de-dupe layer
    // is a deliberate, observable change.
    const resolveFns: Array<() => void> = [];
    const { client, countTokens } = buildClient(
      () =>
        new Promise<{ totalTokens: number }>((resolve) => {
          resolveFns.push(() => resolve({ totalTokens: 700_000 }));
        }),
    );
    // Tiny file content — keep the file-read phase fast so we can
    // observe the API-call phase. exact mode forces tier-2 regardless.
    const file = await realFile(tmpDir, 'concurrent.ts', 'x');
    const input = baseInput([file], { preflightMode: 'exact' });

    const p1 = countForPreflight(client, input);
    const p2 = countForPreflight(client, input);

    // Wait for the file-read phase to settle on both flights, then
    // assert both have called the API. 50 ms is generous for a 1-byte
    // readFile + the few synchronous steps before the SDK call.
    await new Promise((r) => setTimeout(r, 50));
    expect(countTokens).toHaveBeenCalledTimes(2);

    // Resolve both.
    for (const fn of resolveFns) fn();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.method).toBe('exact');
    expect(r2.method).toBe('exact');
    // After both settled, the cache is populated — a third call hits it.
    const r3 = await countForPreflight(client, input);
    expect(countTokens).toHaveBeenCalledTimes(2);
    expect(r3.cacheHit).toBe(true);
  });
});
