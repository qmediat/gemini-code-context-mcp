/**
 * Schema-level tests for the `ask` tool input.
 *
 * We cover the `thinkingBudget` contract in particular:
 *   - `undefined` → downstream defaults to `-1` (dynamic / max-effort).
 *   - `-1` / `0` / positive ints within range are accepted.
 *   - Non-integers, out-of-range values, and garbage types are rejected.
 *
 * The runtime clamp + cost-estimate reservation logic lives in the tool
 * `execute` path; these tests guard the shape at the MCP boundary so
 * malformed inputs fail fast with a clear Zod error instead of sneaking
 * through to Gemini as a broken request.
 */

import { describe, expect, it } from 'vitest';
import { askInputSchema } from '../../src/tools/ask.tool.js';

describe('ask input schema — thinkingBudget', () => {
  it('accepts omitted thinkingBudget (runtime applies the -1 default)', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingBudget).toBeUndefined();
    }
  });

  it('accepts -1 (explicit dynamic / auto)', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: -1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingBudget).toBe(-1);
    }
  });

  it('accepts 0 (thinking disabled)', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: 0 });
    expect(parsed.success).toBe(true);
  });

  it('accepts a positive integer within range', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: 16_384 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingBudget).toBe(16_384);
    }
  });

  it('accepts the documented upper bound (65_536)', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: 65_536 });
    expect(parsed.success).toBe(true);
  });

  it('rejects values below -1', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: -2 });
    expect(parsed.success).toBe(false);
  });

  it('rejects values above the max (65_536)', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: 65_537 });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-integer floats', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: 10.5 });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-numeric types', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: 'auto' });
    expect(parsed.success).toBe(false);
  });
});

describe('ask input schema — core fields unchanged', () => {
  it('requires a non-empty prompt', () => {
    expect(askInputSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(askInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts the full optional surface', () => {
    const parsed = askInputSchema.safeParse({
      prompt: 'what does this do?',
      workspace: '/tmp/x',
      model: 'latest-pro-thinking',
      includeGlobs: ['*.proto'],
      excludeGlobs: ['legacy'],
      noCache: true,
      thinkingBudget: -1,
    });
    expect(parsed.success).toBe(true);
  });
});
