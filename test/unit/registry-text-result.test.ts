import { describe, expect, it } from 'vitest';
import { RESPONSE_TEXT_KEY, errorResult, textResult } from '../../src/tools/registry.js';

describe('textResult — wire-format invariant (T23)', () => {
  it('mirrors text into structuredContent.responseText when no structured arg is passed', () => {
    // Invariant: sub-agent orchestrations extract tool output from
    // `structuredContent.responseText`; they must ALWAYS find it there,
    // even for tools that emit only a narrative string.
    const result = textResult('hello world');
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello world' });
    expect(result.structuredContent?.responseText).toBe('hello world');
    expect(result.structuredContent?.[RESPONSE_TEXT_KEY]).toBe('hello world');
    expect(result.isError).toBeUndefined();
  });

  it('preserves caller metadata alongside responseText', () => {
    const result = textResult('body', { foo: 1, cacheHit: true });
    expect(result.structuredContent?.responseText).toBe('body');
    expect(result.structuredContent?.foo).toBe(1);
    expect(result.structuredContent?.cacheHit).toBe(true);
  });

  it('structuredContent.responseText === content[0].text (single source of truth)', () => {
    // Strongest invariant — MCP hosts rendering either side see the same
    // string. Any drift is a wire-format bug.
    const samples = ['', 'short', 'multi\nline\ntext', 'a'.repeat(10_000)];
    for (const text of samples) {
      const result = textResult(text, { extra: 'meta' });
      expect(result.structuredContent?.responseText).toBe(result.content[0]?.text);
    }
  });

  it("caller's responseText key is overridden by textResult's canonical value", () => {
    // If a tool accidentally passes `responseText` in its metadata, the
    // canonical field wins. Callers must not shadow the wire-format
    // contract with their own value — this test locks that in.
    const result = textResult('real body', { responseText: 'caller attempted shadow' });
    expect(result.structuredContent?.responseText).toBe('real body');
  });

  it('does not treat undefined structured arg as structuredContent: undefined', () => {
    // Regression guard: before T23, omitted `structured` meant the whole
    // `structuredContent` key was absent. Some MCP hosts tolerated that;
    // sub-agent parsers didn't. Now the key is always present.
    const result = textResult('text only');
    expect(result.structuredContent).toBeDefined();
    expect(Object.keys(result.structuredContent ?? {})).toContain('responseText');
  });
});

describe('errorResult — wire-format invariant (T23)', () => {
  it('mirrors error message into structuredContent.responseText', () => {
    const result = errorResult('something broke');
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'something broke' });
    expect(result.structuredContent?.responseText).toBe('something broke');
  });

  it('error structuredContent.responseText === content[0].text', () => {
    const message = 'failure: daily budget cap would be exceeded';
    const result = errorResult(message);
    expect(result.structuredContent?.responseText).toBe(result.content[0]?.text);
  });

  it('flag isError=true is preserved alongside responseText', () => {
    const result = errorResult('nope');
    expect(result.isError).toBe(true);
    // Sub-agents should detect failure from `isError`, then extract detail
    // from `responseText`. Both surfaces must be present.
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent?.responseText).toBeDefined();
  });
});
