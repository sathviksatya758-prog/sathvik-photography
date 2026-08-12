import crypto from 'node:crypto';

// Long random tokens are handed to the client (in URLs/cookies); only a
// SHA-256 hash of them is ever persisted, so a DB leak doesn't expose
// usable session/reset/verification tokens.
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
