/**
 * Regression for v1.16.4: `latest-flash` must skip Google's `gemini-omni-*` family.
 *
 * The family is served only by the Interactions API (a text prompt returns
 * 400 "This model only supports Interactions API.") while `ListModels` still
 * advertises `generateContent` for it, and the registry's version-descending
 * sort places `omni` ahead of every `gemini-N.M-flash`. The registry is mocked
 * with the live order observed on 2026-09-23.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '../../src/gemini/model-registry.js';

const listAvailableModels = vi.fn<() => Promise<ModelInfo[]>>();

vi.mock('../../src/gemini/model-registry.js', () => ({
  listAvailableModels: (): Promise<ModelInfo[]> => listAvailableModels(),
}));

const { resolveModel } = await import('../../src/gemini/models.js');

function model(id: string, inputTokenLimit: number): ModelInfo {
  return {
    id,
    resourceName: `models/${id}`,
    displayName: id,
    inputTokenLimit,
    outputTokenLimit: 65_536,
    supportsThinking: true,
    supportsLongContext: inputTokenLimit >= 100_000,
  };
}

// The registry's own order: pro tier first, then flash by ID descending — `omni` sorts before the digits.
const LIVE_ORDER: ModelInfo[] = [
  model('gemini-pro-latest', 1_048_576),
  model('gemini-3.1-pro-preview', 1_048_576),
  model('gemini-omni-flash-preview', 131_072),
  model('gemini-omni-1.1-flash', 131_072),
  model('gemini-flash-latest', 1_048_576),
  model('gemini-3.8-flash', 1_048_576),
  model('gemini-3.7-flash', 1_048_576),
  model('gemini-flash-lite-latest', 1_048_576),
];

describe('resolveModel — Interactions-API-only models never satisfy a text alias', () => {
  beforeEach(() => {
    listAvailableModels.mockReset();
    listAvailableModels.mockResolvedValue(LIVE_ORDER);
  });

  it('latest-flash skips gemini-omni-* and resolves the newest flash text model', async () => {
    const resolved = await resolveModel('latest-flash', {} as never);
    expect(resolved.resolved).toBe('gemini-flash-latest');
    expect(resolved.category).toBe('text-fast');
    expect(resolved.fallbackApplied).toBe(false);
  });

  it('latest-pro is unaffected', async () => {
    const resolved = await resolveModel('latest-pro', {} as never);
    expect(resolved.resolved).toBe('gemini-pro-latest');
  });

  it('a literal omni ID fails the text-fast category check with an actionable error', async () => {
    await expect(
      resolveModel('gemini-omni-flash-preview', {} as never, { requiredCategory: ['text-fast'] }),
    ).rejects.toThrow(/gemini-omni-flash-preview/);
  });
});
