/**
 * Regression net for `code.tool.ts` response parsers.
 *
 * The v1.7.0 streaming refactor (T20) changes how `code.tool.ts` assembles its
 * response — chunks accumulated from `generateContentStream` instead of a single
 * `generateContent` string. These tests pin down the parser contract so any
 * subtle drift in the assembled text breaks the build.
 *
 * Coverage: minimum-shape happy path, OLD-omitted (insertion), multi-file,
 * Unicode filenames, paths with spaces and dots, multi-line OLD/NEW
 * preservation, language-tag variants, NEW-first regression-pin documenting
 * the regex contract, malformed input. (CRLF coverage deferred — `code.tool.ts`
 * is fed Gemini's UTF-8 LF responses; the regex is `\n`-anchored.)
 */

import { describe, expect, it } from 'vitest';
import { parseCodeBlocks, parseEdits } from '../../src/tools/code.tool.js';

describe('parseEdits', () => {
  it('parses a minimal OLD/NEW edit block', () => {
    const text = [
      '**FILE: src/foo.ts**',
      '```ts',
      'OLD:',
      'const x = 1;',
      'NEW:',
      'const x = 2;',
      '```',
    ].join('\n');
    const edits = parseEdits(text);
    expect(edits).toEqual([{ file: 'src/foo.ts', old: 'const x = 1;', new: 'const x = 2;' }]);
  });

  it('parses an insertion (no OLD block)', () => {
    const text = [
      '**FILE: src/new.ts**',
      '```ts',
      'NEW:',
      'export const greeting = "hello";',
      '```',
    ].join('\n');
    const edits = parseEdits(text);
    expect(edits).toEqual([
      { file: 'src/new.ts', old: '', new: 'export const greeting = "hello";' },
    ]);
  });

  it('parses multiple edits in one response', () => {
    const text = [
      'Here are the two changes:',
      '',
      '**FILE: a.ts**',
      '```ts',
      'OLD:',
      'foo()',
      'NEW:',
      'bar()',
      '```',
      '',
      '**FILE: b.ts**',
      '```ts',
      'OLD:',
      '1 + 1',
      'NEW:',
      '1 + 2',
      '```',
    ].join('\n');
    const edits = parseEdits(text);
    expect(edits).toHaveLength(2);
    expect(edits[0]?.file).toBe('a.ts');
    expect(edits[0]?.new).toBe('bar()');
    expect(edits[1]?.file).toBe('b.ts');
    expect(edits[1]?.new).toBe('1 + 2');
  });

  it('handles Unicode filenames', () => {
    const text = [
      '**FILE: src/composants/Bouton.tsx**',
      '```tsx',
      'OLD:',
      '<button>クリック</button>',
      'NEW:',
      '<button>Click — 点击</button>',
      '```',
    ].join('\n');
    const edits = parseEdits(text);
    expect(edits[0]?.file).toBe('src/composants/Bouton.tsx');
    expect(edits[0]?.old).toBe('<button>クリック</button>');
    expect(edits[0]?.new).toBe('<button>Click — 点击</button>');
  });

  it('handles paths with spaces and dots', () => {
    const text = [
      '**FILE: My Project/src/file.spec.ts**',
      '```ts',
      'OLD:',
      'a',
      'NEW:',
      'b',
      '```',
    ].join('\n');
    const edits = parseEdits(text);
    expect(edits[0]?.file).toBe('My Project/src/file.spec.ts');
  });

  it('preserves multi-line OLD/NEW content', () => {
    const text = [
      '**FILE: util.ts**',
      '```ts',
      'OLD:',
      'function a() {',
      '  return 1;',
      '}',
      'NEW:',
      'function a(): number {',
      '  return 2;',
      '}',
      '```',
    ].join('\n');
    const edits = parseEdits(text);
    expect(edits[0]?.old).toBe('function a() {\n  return 1;\n}');
    expect(edits[0]?.new).toBe('function a(): number {\n  return 2;\n}');
  });

  it('returns empty array on malformed input', () => {
    expect(parseEdits('')).toEqual([]);
    expect(parseEdits('Just some prose, no code blocks at all.')).toEqual([]);
    expect(parseEdits('**FILE: foo.ts**\nbut no code fence after')).toEqual([]);
  });

  it('NEW-first with arbitrary content following is treated as a NEW-only insertion', () => {
    // Regression-pin: regex semantics treat anything after NEW: until ``` as
    // the NEW block, even if it textually contains OLD:. Documented contract.
    const edits = parseEdits(
      ['**FILE: a.ts**', '```ts', 'NEW:', 'b', 'OLD:', 'a', '```'].join('\n'),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]?.file).toBe('a.ts');
    expect(edits[0]?.old).toBe('');
    expect(edits[0]?.new).toBe('b\nOLD:\na');
  });

  it('ignores blocks with NO file marker', () => {
    const text = ['```ts', 'OLD:', 'a', 'NEW:', 'b', '```'].join('\n');
    expect(parseEdits(text)).toEqual([]);
  });

  it('tolerates trailing whitespace on the FILE line', () => {
    const text = ['**FILE: foo.ts**   ', '```ts', 'OLD:', 'a', 'NEW:', 'b', '```'].join('\n');
    const edits = parseEdits(text);
    expect(edits[0]?.file).toBe('foo.ts');
  });

  it('language tag in fence is optional', () => {
    const text = ['**FILE: noext**', '```', 'OLD:', 'one', 'NEW:', 'two', '```'].join('\n');
    const edits = parseEdits(text);
    expect(edits).toEqual([{ file: 'noext', old: 'one', new: 'two' }]);
  });
});

describe('parseCodeBlocks', () => {
  it('extracts a plain code block with language tag', () => {
    const text = ['Here is some code:', '', '```ts', 'const x = 1;', '```'].join('\n');
    const blocks = parseCodeBlocks(text);
    expect(blocks).toEqual([{ lang: 'ts', content: 'const x = 1;' }]);
  });

  it('extracts multiple blocks', () => {
    const text = ['```ts', 'a;', '```', '', 'and then', '', '```python', 'b = 1', '```'].join('\n');
    const blocks = parseCodeBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.lang).toBe('ts');
    expect(blocks[1]?.lang).toBe('python');
    expect(blocks[1]?.content).toBe('b = 1');
  });

  it('block with no language tag → empty lang', () => {
    const text = ['```', 'plain text', '```'].join('\n');
    const blocks = parseCodeBlocks(text);
    expect(blocks).toEqual([{ lang: '', content: 'plain text' }]);
  });

  it('skips OLD: / NEW: blocks (those are handled by parseEdits)', () => {
    const text = [
      '```ts',
      'OLD:',
      'a',
      '```',
      '',
      '```ts',
      'NEW:',
      'b',
      '```',
      '',
      '```ts',
      'const real = "block";',
      '```',
    ].join('\n');
    const blocks = parseCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('const real = "block";');
  });

  it('returns empty when no fences', () => {
    expect(parseCodeBlocks('plain prose only')).toEqual([]);
    expect(parseCodeBlocks('')).toEqual([]);
  });

  it('lang tag accepts c++, x86_64, plus and minus', () => {
    const inputs = ['c++', 'x86_64', 'foo-bar', 'foo_bar'];
    for (const lang of inputs) {
      const text = [`\`\`\`${lang}`, 'code', '```'].join('\n');
      const blocks = parseCodeBlocks(text);
      expect(blocks[0]?.lang).toBe(lang);
    }
  });

  it('handles multi-line content', () => {
    const text = ['```ts', 'line one', 'line two', 'line three', '```'].join('\n');
    const blocks = parseCodeBlocks(text);
    expect(blocks[0]?.content).toBe('line one\nline two\nline three');
  });

  it('does not extract from incomplete (no closing fence)', () => {
    const text = ['```ts', 'never closed', ''].join('\n');
    const blocks = parseCodeBlocks(text);
    expect(blocks).toEqual([]);
  });
});
