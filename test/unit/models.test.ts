import type { GoogleGenAI } from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateModelCache } from '../../src/gemini/model-registry.js';
import { ModelCategoryMismatchError } from '../../src/gemini/model-taxonomy.js';
import { describeAlias, isAlias, listAliases, resolveModel } from '../../src/gemini/models.js';

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

  it('throws when a literal model ID is not available (v1.4.0 fail-fast)', async () => {
    // v1.4.0 behaviour change: the pre-v1.4.0 fallback silently swapped to
    // `latest-pro`, which could resolve to an image-gen model and dispatch
    // the user's call to the wrong category. Fail-fast with a clear error
    // lets the caller pick a valid ID — see docs/models.md.
    const client = fakeClient([
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000 },
      { name: 'models/gemini-3-flash-preview', inputTokenLimit: 1_000_000 },
    ]);
    await expect(resolveModel('gemini-99-ultra', client)).rejects.toThrow(
      /not available for this API key/,
    );
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

  // === v1.4.0 category-based filtering (T24) ===

  it('resolved model carries category + capabilities (v1.4.0 contract)', async () => {
    const client = fakeClient([
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000, thinking: true },
    ]);
    const result = await resolveModel('latest-pro', client);
    expect(result.category).toBe('text-reasoning');
    expect(result.capabilities.supportsThinking).toBe(true);
    expect(result.capabilities.costTier).toBe('premium');
  });

  it('requiredCategory rejects literal model ID in wrong category', async () => {
    // Core attack-surface test: user explicitly passes an image-gen model
    // to a tool that requires text-reasoning. Pre-v1.4.0 this dispatched
    // silently (wrong billing, wrong API shape). Now throws with an
    // actionable error pointing at docs/models.md.
    const client = fakeClient([
      { name: 'models/nano-banana-pro-preview', inputTokenLimit: 131_072, thinking: true },
    ]);
    await expect(
      resolveModel('nano-banana-pro-preview', client, {
        requiredCategory: ['text-reasoning'],
      }),
    ).rejects.toBeInstanceOf(ModelCategoryMismatchError);
  });

  it('requiredCategory accepts model within the required set', async () => {
    const client = fakeClient([
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000, thinking: true },
    ]);
    const result = await resolveModel('gemini-3-pro-preview', client, {
      requiredCategory: ['text-reasoning'],
    });
    expect(result.resolved).toBe('gemini-3-pro-preview');
  });

  it('requiredCategory on an alias path enforces category too', async () => {
    // Registry only contains image-gen + audio-gen models. `latest-pro` is
    // bound to `text-reasoning` category — nothing to pick → clear error.
    // Pre-v1.4.0 this would have silently fallen to the image model.
    const client = fakeClient([
      { name: 'models/nano-banana-pro-preview', inputTokenLimit: 131_072, thinking: true },
      { name: 'models/lyria-3-pro-preview', inputTokenLimit: 1_048_576 },
    ]);
    await expect(resolveModel('latest-pro', client)).rejects.toThrow(
      /no model in category \[text-reasoning\]/,
    );
  });

  it('latest-vision alias picks vision-capable text model', async () => {
    const client = fakeClient([
      { name: 'models/gemini-3-flash-lite', inputTokenLimit: 1_048_576 }, // no vision on lite
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000, thinking: true },
    ]);
    const result = await resolveModel('latest-vision', client);
    expect(result.resolved).toBe('gemini-3-pro-preview');
    expect(result.capabilities.supportsVision).toBe(true);
  });

  it('latest-lite binds strictly to text-lite category', async () => {
    const client = fakeClient([
      { name: 'models/gemini-3-pro-preview', inputTokenLimit: 2_000_000 },
      { name: 'models/gemini-3-flash-lite', inputTokenLimit: 1_048_576 },
    ]);
    const result = await resolveModel('latest-lite', client);
    expect(result.category).toBe('text-lite');
    expect(result.capabilities.costTier).toBe('budget');
  });

  it('explicit model ID of category-unknown throws under required category', async () => {
    // A future Google family not yet in the taxonomy resolves to `unknown`.
    // Aliases will refuse. Explicit ID with `requiredCategory` set also
    // refuses — user must either (a) upgrade MCP, (b) omit requiredCategory
    // for direct pass, or (c) pick a known category member.
    const client = fakeClient([
      { name: 'models/quantum-gemini-7-supernova-2030', inputTokenLimit: 1_048_576 },
    ]);
    await expect(
      resolveModel('quantum-gemini-7-supernova-2030', client, {
        requiredCategory: ['text-reasoning'],
      }),
    ).rejects.toBeInstanceOf(ModelCategoryMismatchError);
  });
});

describe('alias registry', () => {
  it('listAliases exposes the full v1.4.0 alias set', () => {
    const aliases = listAliases();
    expect(aliases).toContain('latest-pro');
    expect(aliases).toContain('latest-pro-thinking');
    expect(aliases).toContain('latest-flash');
    expect(aliases).toContain('latest-lite');
    expect(aliases).toContain('latest-vision');
  });

  it('describeAlias surfaces the category contract for documentation', () => {
    const pro = describeAlias('latest-pro');
    expect(pro.acceptedCategories).toEqual(['text-reasoning']);
    expect(pro.requiresThinking).toBe(false);

    const thinking = describeAlias('latest-pro-thinking');
    expect(thinking.requiresThinking).toBe(true);

    const vision = describeAlias('latest-vision');
    expect(vision.requiresVision).toBe(true);
    expect(vision.acceptedCategories).toContain('text-reasoning');
    expect(vision.acceptedCategories).toContain('text-fast');
  });
});
