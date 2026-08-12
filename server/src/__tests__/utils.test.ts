import { describe, it, expect } from 'vitest';
import { slugify, uniqueSlug } from '../utils/slug';
import { passwordStrength } from '../utils/password';
import { ttlToMs } from '../utils/jwt';
import { hashToken, generateToken } from '../utils/tokens';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Foggy Mountains, Vol. 2!')).toBe('foggy-mountains-vol-2');
  });

  it('falls back to "frame" for empty input', () => {
    expect(slugify('###')).toBe('frame');
  });

  it('uniqueSlug appends a random suffix', () => {
    const a = uniqueSlug('Sunset');
    const b = uniqueSlug('Sunset');
    expect(a).not.toBe(b);
    expect(a.startsWith('sunset-')).toBe(true);
  });
});

describe('passwordStrength', () => {
  it('scores weak passwords low', () => {
    expect(passwordStrength('abc')).toBeLessThan(3);
  });

  it('scores mixed-case + digits + symbols high', () => {
    expect(passwordStrength('Correct-Horse-9')).toBeGreaterThanOrEqual(5);
  });
});

describe('ttlToMs', () => {
  it('parses minutes, hours, days', () => {
    expect(ttlToMs('15m')).toBe(15 * 60_000);
    expect(ttlToMs('2h')).toBe(2 * 3_600_000);
    expect(ttlToMs('30d')).toBe(30 * 86_400_000);
  });

  it('throws on an invalid format', () => {
    expect(() => ttlToMs('soon')).toThrow();
  });
});

describe('tokens', () => {
  it('generateToken produces distinct, hashToken deterministic hashes', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b));
  });
});
