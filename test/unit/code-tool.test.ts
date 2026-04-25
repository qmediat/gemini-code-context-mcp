/**
 * Schema-level tests for the `code` tool input.
 *
 * Mirrors `ask-tool.test.ts` for the `thinkingBudget` / `thinkingLevel` /
 * mutual-exclusion contract. Differs from `ask` on one point: `code`
 * requires `task` (not `prompt`) and has additional optional fields
 * (`codeExecution`, `expectEdits`) — tests for the thinking knobs apply
 * identically once `task` is supplied.
 *
 * The runtime clamp + cost-estimate reservation logic lives in the tool
 * `execute` path; these tests guard the shape at the MCP boundary so
 * malformed inputs fail fast with a clear Zod error instead of sneaking
 * through to Gemini as a broken request.
 */

import { describe, expect, it } from 'vitest';
import { codeInputSchema } from '../../src/tools/code.tool.js';

describe('code input schema — thinkingBudget', () => {
  it('accepts omitted thinkingBudget (runtime applies the 16384 default)', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingBudget).toBeUndefined();
    }
  });

  it('accepts 0 (thinking disabled)', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingBudget: 0 });
    expect(parsed.success).toBe(true);
  });

  it('accepts a positive integer within range', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingBudget: 16_384 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingBudget).toBe(16_384);
    }
  });

  it('accepts the documented upper bound (65_536)', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingBudget: 65_536 });
    expect(parsed.success).toBe(true);
  });

  it('rejects negative values (code does not accept -1 — use thinkingLevel instead)', () => {
    // `code` schema uses `min(0)` not `min(-1)` — the `-1` legacy-dynamic
    // semantics are an `ask`-specific accommodation for Gemini 2.5 callers.
    // Code callers who want dynamic reasoning on Gemini 3 should use
    // `thinkingLevel: 'HIGH'` instead.
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingBudget: -1 });
    expect(parsed.success).toBe(false);
  });

  it('rejects values above the max (65_536)', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingBudget: 65_537 });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-integer floats', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingBudget: 10.5 });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-numeric types', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingBudget: 'auto' });
    expect(parsed.success).toBe(false);
  });
});

describe('code input schema — thinkingLevel', () => {
  it('accepts omitted thinkingLevel', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingLevel).toBeUndefined();
    }
  });

  it.each(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const)('accepts %s', (level) => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingLevel: level });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.thinkingLevel).toBe(level);
    }
  });

  it('rejects unknown enum values', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingLevel: 'EXTREME' });
    expect(parsed.success).toBe(false);
  });

  it('rejects lowercase values (Google SDK enum is uppercase)', () => {
    const parsed = codeInputSchema.safeParse({ task: 'hi', thinkingLevel: 'high' });
    expect(parsed.success).toBe(false);
  });

  it('rejects THINKING_LEVEL_UNSPECIFIED (omit instead for model-native default)', () => {
    const parsed = codeInputSchema.safeParse({
      task: 'hi',
      thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('code input schema — thinkingBudget × thinkingLevel mutual exclusion', () => {
  it('rejects setting both thinkingBudget and thinkingLevel', () => {
    // Gemini itself returns 400 on this combination. We refuse at the
    // schema boundary so callers get a clear Zod error instead of
    // discovering the conflict after a round-trip to Google.
    const parsed = codeInputSchema.safeParse({
      task: 'hi',
      thinkingBudget: 4096,
      thinkingLevel: 'HIGH',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /mutually exclusive/i.test(i.message))).toBe(true);
    }
  });

  it('attaches the mutual-exclusion error at the schema root (path: [])', () => {
    // Same rationale as `ask`: the violation is the RELATION between two
    // fields, not a problem with either field individually.
    const parsed = codeInputSchema.safeParse({
      task: 'hi',
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
    expect(codeInputSchema.safeParse({ task: 'hi', thinkingBudget: 4096 }).success).toBe(true);
  });

  it('accepts either one alone (thinkingLevel only)', () => {
    expect(codeInputSchema.safeParse({ task: 'hi', thinkingLevel: 'HIGH' }).success).toBe(true);
  });

  it('accepts neither (default path — runtime uses the 16384 thinkingBudget default)', () => {
    expect(codeInputSchema.safeParse({ task: 'hi' }).success).toBe(true);
  });
});

describe('code input schema — core fields unchanged', () => {
  it('requires a non-empty task', () => {
    expect(codeInputSchema.safeParse({ task: '' }).success).toBe(false);
    expect(codeInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts the full optional surface (thinkingBudget variant)', () => {
    const parsed = codeInputSchema.safeParse({
      task: 'refactor X',
      workspace: '/tmp/x',
      model: 'latest-pro-thinking',
      thinkingBudget: 16_384,
      codeExecution: true,
      expectEdits: true,
      includeGlobs: ['*.ts'],
      excludeGlobs: ['dist'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the full optional surface (thinkingLevel variant)', () => {
    const parsed = codeInputSchema.safeParse({
      task: 'refactor X',
      workspace: '/tmp/x',
      model: 'latest-pro-thinking',
      thinkingLevel: 'HIGH',
      codeExecution: false,
      expectEdits: true,
      includeGlobs: ['*.ts'],
      excludeGlobs: ['dist'],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('code input schema — timeoutMs (T19, v1.6.0)', () => {
  it('accepts omitted timeoutMs', () => {
    const parsed = codeInputSchema.safeParse({ task: 'refactor x' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timeoutMs).toBeUndefined();
    }
  });

  it('accepts the documented bounds', () => {
    expect(codeInputSchema.safeParse({ task: 't', timeoutMs: 1_000 }).success).toBe(true);
    expect(codeInputSchema.safeParse({ task: 't', timeoutMs: 1_800_000 }).success).toBe(true);
  });

  it('rejects values below the 1s minimum', () => {
    expect(codeInputSchema.safeParse({ task: 't', timeoutMs: 999 }).success).toBe(false);
    expect(codeInputSchema.safeParse({ task: 't', timeoutMs: 0 }).success).toBe(false);
  });

  it('rejects values above the 30min maximum', () => {
    expect(codeInputSchema.safeParse({ task: 't', timeoutMs: 1_800_001 }).success).toBe(false);
  });
});
