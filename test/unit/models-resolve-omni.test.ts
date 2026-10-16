/**
 * Regression for v1.16.4: `latest-flash` must skip Google's `gemini-omni-*` family.
 *
 * The family is served only by the Interactions API (a text prompt returns
 * 400 "This model only supports Interactions API.") while `ListModels` still
 * advertises `generateContent` for it. The taxonomy classifies it `agent`, so
 * no text alias picks it wherever the listing places it. The ids go through the
 * real registry (only the API client's list call is faked), so the listing's
 * comparator is exercised too.
 */

import type { GoogleGenAI } from '@google/genai';
import { beforeEach, describe, expect, it } from 'vitest';
import { invalidateModelCache } from '../../src/gemini/model-registry.js';
import { resolveModel } from '../../src/gemini/models.js';

const IDS = [
  'gemini-flash-lite-latest',
  'gemini-3.7-flash',
  'gemini-omni-1.1-flash',
  'gemini-pro-latest',
  'gemini-3.8-flash',
  'gemini-omni-flash-preview',
  'gemini-flash-latest',
  'gemini-3.1-pro-preview',
];

function client(): GoogleGenAI {
  const pager = {
    async *[Symbol.asyncIterator]() {
      for (const id of IDS)
        yield { name: `models/${id}`, inputTokenLimit: 1_048_576, thinking: true };
    },
  };
  return { models: { list: async () => pager } } as unknown as GoogleGenAI;
}

describe('resolveModel — Interactions-API-only models never satisfy a text alias', () => {
  beforeEach(() => {
    invalidateModelCache();
  });

  it('latest-flash skips gemini-omni-* and resolves the newest flash text model', async () => {
    const resolved = await resolveModel('latest-flash', client());
    expect(resolved.resolved).toBe('gemini-3.8-flash');
    expect(resolved.category).toBe('text-fast');
    expect(resolved.fallbackApplied).toBe(false);
  });

  it('latest-pro is unaffected', async () => {
    const resolved = await resolveModel('latest-pro', client());
    expect(resolved.resolved).toBe('gemini-3.1-pro-preview');
  });

  it('a literal omni ID fails the text-fast category check with an actionable error', async () => {
    await expect(
      resolveModel('gemini-omni-flash-preview', client(), { requiredCategory: ['text-fast'] }),
    ).rejects.toThrow(/gemini-omni-flash-preview/);
  });
});
