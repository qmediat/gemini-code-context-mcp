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
import { THINKING_LEVEL_RESERVE } from '../../src/tools/shared/thinking.js';

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

  it('attaches the mutual-exclusion error at the schema root (path: [])', () => {
    // The violation is the RELATION between two fields, not a problem with
    // either field individually. Emitting the error at the root (path: [])
    // rather than under one field prevents MCP clients that render
    // per-field errors from misattributing the issue to `thinkingLevel`
    // alone (the previous behaviour, see PR #16 self-review finding F6).
    const parsed = askInputSchema.safeParse({
      prompt: 'hi',
      thinkingBudget: 4096,
      thinkingLevel: 'HIGH',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const refineIssue = parsed.error.issues.find((i) => /mutually exclusive/i.test(i.message));
      expect(refineIssue).toBeDefined();
      expect(refineIssue?.path).toEqual([]);
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

describe('THINKING_LEVEL_RESERVE — per-tier cost-estimate reservations', () => {
  // Tier-aware reservations replace the previous "always worst-case" behaviour
  // that false-rejected long sequences of MINIMAL/LOW calls against
  // `GEMINI_DAILY_BUDGET_USD`. Actual values are heuristic upper bounds — if
  // Google changes them, bump here and re-check the comment in ask.tool.ts.

  it('MINIMAL reserves a small positive count', () => {
    expect(THINKING_LEVEL_RESERVE.MINIMAL).toBe(512);
  });

  it('LOW reserves more than MINIMAL', () => {
    expect(THINKING_LEVEL_RESERVE.LOW).toBeGreaterThan(THINKING_LEVEL_RESERVE.MINIMAL as number);
  });

  it('MEDIUM reserves more than LOW', () => {
    expect(THINKING_LEVEL_RESERVE.MEDIUM).toBeGreaterThan(THINKING_LEVEL_RESERVE.LOW as number);
  });

  it('HIGH is null (sentinel for "use maxOutputTokens - 1024" at call site)', () => {
    // The execute path substitutes the dynamic cap — keeps the reserve in
    // sync with the model's actual output cap rather than a hard-coded
    // duplicate of maxOutputTokens.
    expect(THINKING_LEVEL_RESERVE.HIGH).toBeNull();
  });

  it('covers every value in the enum (no drift between schema and reserve table)', () => {
    // If schema adds/renames a level, this test fails with a clear error
    // pointing at the missing or extra key. Compile-time TypeScript already
    // enforces this via `Record<(typeof THINKING_LEVELS)[number], …>`, but
    // a runtime check guards against accidental `as const` regressions.
    const keys = Object.keys(THINKING_LEVEL_RESERVE).sort();
    expect(keys).toEqual(['HIGH', 'LOW', 'MEDIUM', 'MINIMAL']);
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

describe('ask input schema — timeoutMs (T19, v1.6.0)', () => {
  it('accepts omitted timeoutMs (runtime falls through to env / disabled)', () => {
    const parsed = askInputSchema.safeParse({ prompt: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timeoutMs).toBeUndefined();
    }
  });

  it('accepts the documented bounds', () => {
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: 1_000 }).success).toBe(true);
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: 1_800_000 }).success).toBe(true);
  });

  it('rejects values below the 1s minimum', () => {
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: 999 }).success).toBe(false);
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: 0 }).success).toBe(false);
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: -1 }).success).toBe(false);
  });

  it('rejects values above the 30min maximum', () => {
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: 1_800_001 }).success).toBe(false);
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: 7_200_000 }).success).toBe(false);
  });

  it('rejects non-integer floats', () => {
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: 1500.5 }).success).toBe(false);
  });

  it('rejects non-numeric types', () => {
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: '5000' }).success).toBe(false);
    expect(askInputSchema.safeParse({ prompt: 'hi', timeoutMs: null }).success).toBe(false);
  });
});
