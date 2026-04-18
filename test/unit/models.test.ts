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
});
