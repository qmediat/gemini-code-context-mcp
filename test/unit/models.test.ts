import type { GoogleGenAI } from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateModelCache } from '../../src/gemini/model-registry.js';
import { isAlias, resolveModel } from '../../src/gemini/models.js';

interface FakeModel {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  thinking?: boolean;
}

function fakeClient(models: FakeModel[]): GoogleGenAI {
  const asyncIterable = {
    async *[Symbol.asyncIterator]() {
      for (const m of models) yield m;
    },
  };
  return {
    models: {
      list: vi.fn().mockResolvedValue(asyncIterable),
    },
  } as unknown as GoogleGenAI;
}

describe('model alias detection', () => {
  it('recognizes supported aliases', () => {
    expect(isAlias('latest-pro')).toBe(true);
    expect(isAlias('latest-pro-thinking')).toBe(true);
    expect(isAlias('latest-flash')).toBe(true);
    expect(isAlias('latest-lite')).toBe(true);
  });

  it('rejects unknown aliases and literal IDs', () => {
    expect(isAlias('gemini-3-pro-preview')).toBe(false);
    expect(isAlias('banana')).toBe(false);
  });
});

describe('resolveModel', () => {
  beforeEach(() => {
    invalidateModelCache();
  });

  it("resolves 'latest-pro' to the newest pro-class model", async () => {
    const client = fakeClient([
      { name: 'models/gemini-2.5-pro', inputTokenLimit: 2_000_000 },
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000, thinking: true },
      { name: 'models/gemini-3-flash-preview', inputTokenLimit: 1_000_000 },
    ]);
    const result = await resolveModel('latest-pro', client);
    expect(result.resolved).toBe('gemini-3-pro-preview');
    expect(result.fallbackApplied).toBe(false);
    expect(result.inputTokenLimit).toBe(2_000_000);
  });

  it("resolves 'latest-pro-thinking' and prefers models with thinking=true", async () => {
    const client = fakeClient([
      { name: 'models/gemini-2.5-pro', inputTokenLimit: 2_000_000, thinking: false },
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000, thinking: true },
    ]);
    const result = await resolveModel('latest-pro-thinking', client);
    expect(result.resolved).toBe('gemini-3-pro-preview');
  });

  it('resolves literal model IDs when they are in the registry', async () => {
    const client = fakeClient([
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000 },
    ]);
    const result = await resolveModel('gemini-3-pro-preview', client);
    expect(result.resolved).toBe('gemini-3-pro-preview');
    expect(result.fallbackApplied).toBe(false);
  });

  it('falls back when a literal model ID is not available', async () => {
    const client = fakeClient([
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000 },
      { name: 'models/gemini-3-flash-preview', inputTokenLimit: 1_000_000 },
    ]);
    const result = await resolveModel('gemini-99-ultra', client);
    expect(result.fallbackApplied).toBe(true);
    expect(result.resolved).toBe('gemini-3-pro-preview');
  });

  it('throws when no models are available at all', async () => {
    const client = fakeClient([]);
    await expect(resolveModel('latest-pro', client)).rejects.toThrow();
  });

  it('excludes non-text-gen families (nano-banana, lyria) from latest-pro resolution', async () => {
    // Regression: Google's registry returns `nano-banana-pro-preview` (image
    // gen) and `lyria-3-pro-preview` (music gen) BEFORE `gemini-pro-latest`.
    // Pre-fix aliases matched on `includes('pro')` only, so `.find()` grabbed
    // banana first — every `ask` call resolved to an image model, returned
    // image-pricing bills, and 429-ed on the image-gen quota.
    const client = fakeClient([
      { name: 'models/nano-banana-pro-preview', inputTokenLimit: 131_072, thinking: true },
      { name: 'models/lyria-3-pro-preview', inputTokenLimit: 1_048_576 },
      { name: 'models/gemini-pro-latest', inputTokenLimit: 1_048_576, thinking: true },
    ]);
    const result = await resolveModel('latest-pro', client);
    expect(result.resolved).toBe('gemini-pro-latest');
    expect(result.fallbackApplied).toBe(false);
  });

  it('latest-pro-thinking skips non-text-gen even when they advertise thinking=true', async () => {
    // `nano-banana-pro-preview` advertises `supportsThinking: true` in the
    // live registry, so the thinking-aware alias also fell into the banana
    // trap pre-fix. The exclude list short-circuits before the thinking
    // preference kicks in.
    const client = fakeClient([
      { name: 'models/nano-banana-pro-preview', inputTokenLimit: 131_072, thinking: true },
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 1_048_576, thinking: true },
    ]);
    const result = await resolveModel('latest-pro-thinking', client);
    expect(result.resolved).toBe('gemini-3-pro-preview');
  });

  it("latest-pro rejects 'customtools' variants that require tool params on every call", async () => {
    const client = fakeClient([
      { name: 'models/gemini-3.1-pro-preview-customtools', inputTokenLimit: 1_048_576 },
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 1_048_576 },
    ]);
    const result = await resolveModel('latest-pro', client);
    expect(result.resolved).toBe('gemini-3-pro-preview');
  });

  it("latest-pro rejects the Deep Research 'research-pro' agent (not a drop-in Q&A model)", async () => {
    const client = fakeClient([
      { name: 'models/deep-research-pro-preview-12-2025', inputTokenLimit: 131_072 },
      { name: 'models/gemini-pro-latest', inputTokenLimit: 1_048_576 },
    ]);
    const result = await resolveModel('latest-pro', client);
    expect(result.resolved).toBe('gemini-pro-latest');
  });
});
