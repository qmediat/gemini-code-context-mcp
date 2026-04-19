import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/auth/fingerprint.js';

describe('fingerprint', () => {
  it('returns a safe preview for normal keys', () => {
    expect(fingerprint('AIzaSyD0123456789abcdefXYZ')).toBe('AIza...fXYZ');
  });

  it('obscures keys that are too short', () => {
    expect(fingerprint('short')).toBe('***');
    expect(fingerprint('')).toBe('***');
  });

  it('handles undefined and null', () => {
    expect(fingerprint(undefined)).toBe('***');
    expect(fingerprint(null)).toBe('***');
  });
});
