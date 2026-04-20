/**
 * Tests for the allowlist-first model taxonomy.
 *
 * Coverage split into three groups:
 *   1. Every currently-shipping Gemini model ID → expected category
 *   2. Hypothetical future models → should fall back to `unknown`
 *   3. Edge / precedence cases that would slip through a naïve substring match
 *
 * The third group is the load-bearing one — it locks in the invariant that
 * the v1.4.0 work was taken on to fix: a `pro` token in the ID does NOT
 * automatically classify as `text-reasoning` when a more-specific rule
 * (image-generation, audio-generation, agent) matches first.
 */

import { describe, expect, it } from 'vitest';
import {
  type ModelCategory,
  ModelCategoryMismatchError,
  categorizeModel,
  costTierOf,
  extractCapabilityFlags,
  isTextGenCategory,
} from '../../src/gemini/model-taxonomy.js';

describe('categorizeModel — current Gemini lineup', () => {
  const cases: ReadonlyArray<readonly [string, ModelCategory]> = [
    // Text reasoning (pro tier)
    ['gemini-3-pro-preview', 'text-reasoning'],
    ['gemini-3-pro-latest', 'text-reasoning'],
    ['gemini-2.5-pro', 'text-reasoning'],
    ['gemini-pro-latest', 'text-reasoning'],
    ['gemini-pro', 'text-reasoning'],

    // Text fast (flash tier)
    ['gemini-3-flash-preview', 'text-fast'],
    ['gemini-2.5-flash', 'text-fast'],
    ['gemini-flash-latest', 'text-fast'],

    // Text lite (budget)
    ['gemini-3-flash-lite', 'text-lite'],
    ['gemini-2.5-flash-lite', 'text-lite'],
    ['gemini-flash-lite', 'text-lite'],

    // Image generation — the primary attack vector the taxonomy was built to close
    ['nano-banana-pro-preview', 'image-generation'],
    ['nano-banana-flash-preview', 'image-generation'],
    ['gemini-3-pro-image', 'image-generation'],
    ['gemini-3-flash-image', 'image-generation'],
    ['imagen-4-ultra', 'image-generation'],
    ['imagen-3', 'image-generation'],

    // Audio generation
    ['lyria-3-pro-preview', 'audio-generation'],
    ['gemini-2.5-flash-tts', 'audio-generation'],

    // Video generation
    ['veo-3', 'video-generation'],
    ['veo-3.1-preview', 'video-generation'],

    // Embeddings
    ['text-embedding-004', 'embedding'],
    ['gemini-embedding-001', 'embedding'],

    // Agents
    ['gemini-deep-research-pro', 'agent'],
    ['gemini-3-pro-customtools', 'agent'],
  ];

  for (const [modelId, expected] of cases) {
    it(`${modelId} → ${expected}`, () => {
      expect(categorizeModel(modelId)).toBe(expected);
    });
  }
});

describe('categorizeModel — precedence (the invariant v1.4.0 fixes)', () => {
  it('nano-banana-pro-preview is image-generation, NOT text-reasoning', () => {
    // The exact scenario the user flagged: a `pro` model that must NOT be
    // picked up by `latest-pro-thinking` for code review.
    expect(categorizeModel('nano-banana-pro-preview')).toBe('image-generation');
  });

  it('gemini-3-pro-image classified before the general -pro rule', () => {
    // Would-be-bug: `gemini-3-pro-image` contains `pro`, a naive rule would
    // tag it `text-reasoning`. Image rule must run first.
    expect(categorizeModel('gemini-3-pro-image')).toBe('image-generation');
  });

  it('lyria-3-pro-preview is audio-generation, not text-reasoning', () => {
    expect(categorizeModel('lyria-3-pro-preview')).toBe('audio-generation');
  });

  it('gemini-deep-research-pro is agent, not text-reasoning', () => {
    expect(categorizeModel('gemini-deep-research-pro')).toBe('agent');
  });

  it('lite wins over flash when both match (lite is the more specific tier)', () => {
    // `gemini-3-flash-lite` contains both `flash` and `lite`. Lite rule
    // runs before flash, so model resolves to `text-lite` (cheapest tier),
    // NOT `text-fast`.
    expect(categorizeModel('gemini-3-flash-lite')).toBe('text-lite');
  });
});

describe('categorizeModel — unknown fallback', () => {
  it('unrecognised future model → unknown', () => {
    // The crucial safety net: unknown-family model is NOT silently slotted
    // into any text-* tier. Aliases will refuse to pick it; explicit
    // model ID pass still works (caller takes responsibility).
    expect(categorizeModel('quantum-gemini-7-supernova-2030')).toBe('unknown');
  });

  it('empty / non-string input → unknown', () => {
    expect(categorizeModel('')).toBe('unknown');
    expect(categorizeModel(undefined as unknown as string)).toBe('unknown');
    expect(categorizeModel(null as unknown as string)).toBe('unknown');
    expect(categorizeModel(42 as unknown as string)).toBe('unknown');
  });

  it('whitespace-only → unknown', () => {
    // Not matched by any rule (patterns expect alphanumeric tokens).
    expect(categorizeModel('   ')).toBe('unknown');
  });
});

describe('costTierOf', () => {
  it('premium for pro-tier and most specialised generation models', () => {
    expect(costTierOf('gemini-3-pro-preview')).toBe('premium');
    expect(costTierOf('nano-banana-pro-preview')).toBe('premium');
    expect(costTierOf('lyria-3-pro-preview')).toBe('premium');
    expect(costTierOf('veo-3')).toBe('premium');
  });

  it('standard for flash-tier (non-lite)', () => {
    expect(costTierOf('gemini-3-flash-preview')).toBe('standard');
    expect(costTierOf('gemini-2.5-flash')).toBe('standard');
    expect(costTierOf('gemini-2.5-flash-tts')).toBe('standard');
  });

  it('budget for lite and embedding', () => {
    expect(costTierOf('gemini-3-flash-lite')).toBe('budget');
    expect(costTierOf('text-embedding-004')).toBe('budget');
  });

  it('unknown for unrecognised', () => {
    expect(costTierOf('quantum-gemini-7-supernova-2030')).toBe('unknown');
  });
});

describe('extractCapabilityFlags', () => {
  it('pro-tier gets vision + codeExec + premium tier', () => {
    const flags = extractCapabilityFlags('gemini-3-pro-preview', { supportsThinking: true });
    expect(flags).toEqual({
      supportsThinking: true,
      supportsVision: true,
      supportsCodeExecution: true,
      costTier: 'premium',
    });
  });

  it('lite-tier has vision disabled (Google does not advertise vision on *-lite)', () => {
    const flags = extractCapabilityFlags('gemini-3-flash-lite', { supportsThinking: false });
    expect(flags.supportsVision).toBe(false);
    expect(flags.supportsCodeExecution).toBe(true);
    expect(flags.costTier).toBe('budget');
  });

  it('image-generation model does NOT report code execution', () => {
    const flags = extractCapabilityFlags('nano-banana-pro-preview', { supportsThinking: false });
    expect(flags.supportsCodeExecution).toBe(false);
    expect(flags.supportsVision).toBe(true); // still accepts image input even as generator
    expect(flags.costTier).toBe('premium');
  });

  it('embedding model has no vision / code exec', () => {
    const flags = extractCapabilityFlags('text-embedding-004', { supportsThinking: false });
    expect(flags.supportsVision).toBe(false);
    expect(flags.supportsCodeExecution).toBe(false);
    expect(flags.costTier).toBe('budget');
  });

  it('audio-generation does not get vision flag', () => {
    const flags = extractCapabilityFlags('lyria-3-pro-preview', { supportsThinking: false });
    expect(flags.supportsVision).toBe(false);
    expect(flags.supportsCodeExecution).toBe(false);
  });

  it('passes through supportsThinking from SDK metadata unchanged', () => {
    expect(
      extractCapabilityFlags('gemini-3-pro-preview', { supportsThinking: true }).supportsThinking,
    ).toBe(true);
    expect(
      extractCapabilityFlags('gemini-3-pro-preview', { supportsThinking: false }).supportsThinking,
    ).toBe(false);
  });
});

describe('isTextGenCategory', () => {
  it('accepts text-reasoning / text-fast / text-lite', () => {
    expect(isTextGenCategory('text-reasoning')).toBe(true);
    expect(isTextGenCategory('text-fast')).toBe(true);
    expect(isTextGenCategory('text-lite')).toBe(true);
  });

  it('rejects specialised categories', () => {
    expect(isTextGenCategory('image-generation')).toBe(false);
    expect(isTextGenCategory('audio-generation')).toBe(false);
    expect(isTextGenCategory('video-generation')).toBe(false);
    expect(isTextGenCategory('embedding')).toBe(false);
    expect(isTextGenCategory('agent')).toBe(false);
    expect(isTextGenCategory('unknown')).toBe(false);
  });
});

describe('ModelCategoryMismatchError', () => {
  it('carries modelId + categories in its fields', () => {
    const err = new ModelCategoryMismatchError({
      modelId: 'nano-banana-pro-preview',
      actualCategory: 'image-generation',
      requiredCategory: ['text-reasoning'],
    });
    expect(err.modelId).toBe('nano-banana-pro-preview');
    expect(err.actualCategory).toBe('image-generation');
    expect(err.requiredCategory).toEqual(['text-reasoning']);
    expect(err.name).toBe('ModelCategoryMismatchError');
  });

  it('has an actionable message naming the offender and accepted categories', () => {
    const err = new ModelCategoryMismatchError({
      modelId: 'nano-banana-pro-preview',
      actualCategory: 'image-generation',
      requiredCategory: ['text-reasoning'],
    });
    expect(err.message).toContain('nano-banana-pro-preview');
    expect(err.message).toContain('image-generation');
    expect(err.message).toContain('text-reasoning');
    // Users should know where to get the authoritative model list.
    expect(err.message).toContain('docs/models.md');
  });

  it('is catchable as Error and narrows via instanceof', () => {
    try {
      throw new ModelCategoryMismatchError({
        modelId: 'x',
        actualCategory: 'unknown',
        requiredCategory: ['text-reasoning'],
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(ModelCategoryMismatchError);
    }
  });
});
