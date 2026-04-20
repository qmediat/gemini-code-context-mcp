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

describe('ask input schema — thinkingLevel', () => {
  it('accepts omitted thinkingLevel (runtime falls through to thinkingBudget path)', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingLevel).toBeUndefined();
    }
  });

  it.each(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const)('accepts %s', (level) => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingLevel: level });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingLevel).toBe(level);
    }
  });

  it('rejects unknown enum values', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingLevel: 'EXTREME' });
    expect(parsed.success).toBe(false);
  });

  it('rejects lowercase values (Google SDK enum is uppercase)', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi', thinkingLevel: 'high' });
    expect(parsed.success).toBe(false);
  });

  it('rejects THINKING_LEVEL_UNSPECIFIED (omit instead for model-native default)', () => {
    const parsed = askInputSchema.safeParse({
      prompt: 'hi',
      thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ask input schema — thinkingBudget × thinkingLevel mutual exclusion', () => {
  it('rejects setting both thinkingBudget and thinkingLevel', () => {
    // Gemini itself returns 400 on this combination ("cannot use both
    // thinking_level and the legacy thinking_budget parameter"). We refuse
    // at the schema boundary so callers get a clear Zod error instead of
    // discovering the conflict after a round-trip to Google.
    const parsed = askInputSchema.safeParse({
      prompt: 'hi',
      thinkingBudget: 4096,
      thinkingLevel: 'HIGH',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /mutually exclusive/i.test(i.message))).toBe(true);
    }
  });

  it('accepts either one alone (thinkingBudget only)', () => {
    expect(askInputSchema.safeParse({ prompt: 'hi', thinkingBudget: 4096 }).success).toBe(true);
  });

  it('accepts either one alone (thinkingLevel only)', () => {
    expect(askInputSchema.safeParse({ prompt: 'hi', thinkingLevel: 'HIGH' }).success).toBe(true);
  });

  it('accepts neither (default path — runtime omits thinkingConfig budget field)', () => {
    expect(askInputSchema.safeParse({ prompt: 'hi' }).success).toBe(true);
  });
});

describe('ask input schema — core fields unchanged', () => {
  it('requires a non-empty prompt', () => {
    expect(askInputSchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(askInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts the full optional surface (thinkingBudget variant)', () => {
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

  it('accepts the full optional surface (thinkingLevel variant)', () => {
    const parsed = askInputSchema.safeParse({
      prompt: 'what does this do?',
      workspace: '/tmp/x',
      model: 'latest-pro-thinking',
      includeGlobs: ['*.proto'],
      excludeGlobs: ['legacy'],
      noCache: true,
      thinkingLevel: 'HIGH',
    });
    expect(parsed.success).toBe(true);
  });
});
