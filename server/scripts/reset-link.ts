/**
 * Local-development account recovery.
 *
 * Mints a one-time password-reset link for an existing account — the same
 * token the normal "Forgot password?" flow emails, using the same helpers
 * (generateToken/hashToken) and the same 1-hour expiry. It exists because in
 * local dev SMTP is usually unconfigured, so the emailed link would only be
 * written to the server console.
 *
 * It is deliberately narrow:
 *   - it NEVER sets or reads a password, and never prints a password hash;
 *   - it only INSERTS a password_reset_tokens row — it does not modify the
 *     user row (role/email/username are untouched) or any other data;
 *   - it refuses to create accounts; the user must already exist.
 *
 * The actual password change still goes through the normal, fully-validated
 * POST /api/auth/reset-password endpoint (strength check, Argon2id hashing,
 * single-use token, session revocation) — this only delivers the link.
 *
 * Usage:
 *   npm run admin:reset-link                          # OWNER_EMAIL, CLIENT_ORIGIN
 *   npm run admin:reset-link -- you@example.com
 *   npm run admin:reset-link -- you@example.com http://127.0.0.1:5500
 */
import fs from 'node:fs';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';
import { generateToken, hashToken } from '../src/utils/tokens';
import { DEV_LINK_FILE } from '../src/utils/devResetLink';

const RESET_TTL_MS = 60 * 60_000; // mirrors auth.service.ts

async function main() {
  const email = (process.argv[2] || env.OWNER_EMAIL).trim().toLowerCase();
  const base = (process.argv[3] || env.CLIENT_ORIGIN).replace(/\/$/, '');

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, username: true, role: true, lockedUntil: true }
  });
  if (!user) {
    // Never create an account here — recovery is for existing users only.
    console.error(`No account found for that email. Existing accounts are untouched.`);
    process.exit(1);
  }

  const token = generateToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) }
  });

  const url = `${base}/?reset=${token}`;
  const outFile = DEV_LINK_FILE; // same gitignored file the dev fallback uses
  fs.writeFileSync(outFile, url + '\n', { encoding: 'utf8' });

  // Print everything EXCEPT the token itself, so the secret lives only in the
  // gitignored file the operator opens locally.
  console.log('Reset link created for an existing account.');
  // Only report a lockout that is still in effect — a past lockedUntil has
  // already elapsed and no longer blocks sign-in.
  const lockActive = !!(user.lockedUntil && user.lockedUntil > new Date());
  console.log(`  account : ${user.username} (role ${user.role}${lockActive ? ', lockout active — completing this reset clears it' : ''})`);
  console.log(`  expires : 1 hour, single use`);
  console.log(`  link    : ${base}/?reset=<token hidden — see file>`);
  console.log(`  saved to: ${outFile}`);
  console.log('\nOpen that URL in your browser and choose a new password.');
  console.log('Nothing else about the account was modified.');
}

main()
  .catch(err => {
    console.error('Failed to create reset link:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
