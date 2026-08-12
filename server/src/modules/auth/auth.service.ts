import type { Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { hashPassword, verifyPassword, passwordStrength } from '../../utils/password';
import { generateToken, hashToken } from '../../utils/tokens';
import { signAccessToken, signRefreshToken, verifyRefreshToken, ttlToMs } from '../../utils/jwt';
import { setAccessCookie, setRefreshCookie, clearAuthCookies } from '../../utils/cookies';
import { sendMail, verifyEmailTemplate, resetPasswordTemplate } from '../../lib/mailer';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { recordAudit } from '../admin/audit.service';
import type { Role } from '@prisma/client';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60_000;
const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 60 * 60_000;

export type PublicUser = {
  id: string;
  email: string;
  username: string;
  role: Role;
  emailVerified: boolean;
};

function toPublicUser(u: { id: string; email: string; username: string; role: Role; emailVerified: boolean }): PublicUser {
  return { id: u.id, email: u.email, username: u.username, role: u.role, emailVerified: u.emailVerified };
}

// Issues a fresh access+refresh pair, persists the refresh token
// (hashed) for rotation/revocation tracking, and sets both as
// httpOnly cookies on the response.
async function issueSession(
  res: Response,
  user: { id: string; role: Role; username: string },
  meta: { userAgent?: string; ip?: string }
) {
  const access = signAccessToken({ sub: user.id, role: user.role, username: user.username });
  const { token: refresh, jti } = signRefreshToken(user.id);

  await prisma.refreshToken.create({
    data: {
      id: jti,
      userId: user.id,
      tokenHash: hashToken(refresh),
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt: new Date(Date.now() + ttlToMs(env.REFRESH_TOKEN_TTL))
    }
  });

  setAccessCookie(res, access);
  setRefreshCookie(res, refresh);
}

export async function register(
  input: { email: string; username: string; password: string },
  res: Response,
  meta: { userAgent?: string; ip?: string }
): Promise<PublicUser> {
  if (passwordStrength(input.password) < 4) {
    throw AppError.badRequest('Password too weak — mix uppercase, lowercase, numbers and symbols');
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: input.email }, { username: input.username }] }
  });
  if (existing) {
    throw AppError.conflict(
      existing.email === input.email ? 'An account with this email already exists' : 'That username is taken'
    );
  }

  // Server-verified admin role — the fix for the old client-only
  // "isOwner" flag, which any visitor could spoof by typing the
  // owner's email into the public signup form. Only the account that
  // registers with OWNER_EMAIL (and proves it via password) is ADMIN.
  const role: Role = input.email === env.OWNER_EMAIL.toLowerCase() ? 'ADMIN' : 'USER';

  const user = await prisma.user.create({
    data: { email: input.email, username: input.username, passwordHash: await hashPassword(input.password), role }
  });

  await issueSession(res, user, meta);
  await sendVerificationEmail(user.id, user.email).catch(err => logger.error({ err }, 'verification email failed'));
  await recordAudit({ actorId: user.id, action: 'user.register', targetType: 'user', targetId: user.id, ip: meta.ip });

  return toPublicUser(user);
}

export async function login(
  input: { email: string; password: string },
  res: Response,
  meta: { userAgent?: string; ip?: string }
): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) throw AppError.unauthorized('Incorrect email or password');

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw AppError.tooManyRequests('Account temporarily locked from too many failed attempts — try again later');
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    const failedLogins = user.failedLogins + 1;
    const lockedUntil = failedLogins >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null;
    await prisma.user.update({ where: { id: user.id }, data: { failedLogins, lockedUntil } });
    throw AppError.unauthorized('Incorrect email or password');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }
  });

  await issueSession(res, user, meta);
  await recordAudit({ actorId: user.id, action: 'user.login', targetType: 'user', targetId: user.id, ip: meta.ip });

  return toPublicUser(user);
}

export async function logout(res: Response, refreshTokenRaw: string | undefined): Promise<void> {
  if (refreshTokenRaw) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshTokenRaw), revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
  clearAuthCookies(res);
}

export async function refresh(
  refreshTokenRaw: string | undefined,
  res: Response,
  meta: { userAgent?: string; ip?: string }
): Promise<PublicUser> {
  if (!refreshTokenRaw) throw AppError.unauthorized('No refresh token');

  let payload;
  try {
    payload = verifyRefreshToken(refreshTokenRaw);
  } catch {
    throw AppError.unauthorized('Refresh token invalid or expired');
  }

  const tokenHash = hashToken(refreshTokenRaw);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  // Token not found, or already revoked/rotated: possible theft/replay
  // of a stolen refresh token. Revoke the entire family defensively.
  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    await prisma.refreshToken.updateMany({
      where: { userId: payload.sub, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    clearAuthCookies(res);
    throw AppError.unauthorized('Session invalid — please sign in again');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw AppError.unauthorized();

  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  await issueSession(res, user, meta);

  return toPublicUser(user);
}

export async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  const token = generateToken();
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) }
  });
  const link = `${env.CLIENT_ORIGIN}/?verify=${token}`;
  await sendMail({ to: email, ...verifyEmailTemplate(link) });
}

export async function resendVerification(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  // Always behave the same whether or not the account exists, to avoid
  // leaking which emails are registered.
  if (!user || user.emailVerified) return;
  await sendVerificationEmail(user.id, user.email);
}

export async function verifyEmail(token: string): Promise<void> {
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw AppError.badRequest('Verification link is invalid or has expired');
  }
  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } })
  ]);
}

export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return; // don't leak account existence

  const token = generateToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) }
  });
  const link = `${env.CLIENT_ORIGIN}/?reset=${token}`;
  await sendMail({ to: user.email, ...resetPasswordTemplate(link) });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  if (passwordStrength(newPassword) < 4) {
    throw AppError.badRequest('Password too weak — mix uppercase, lowercase, numbers and symbols');
  }
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw AppError.badRequest('Reset link is invalid or has expired');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash, failedLogins: 0, lockedUntil: null }
    }),
    // Force re-login on every device — a password reset should
    // invalidate any session that might belong to an attacker.
    prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } })
  ]);
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.unauthorized();
  return toPublicUser(user);
}
