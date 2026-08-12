import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../lib/errors';
import * as authService from './auth.service';

function meta(req: Request) {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

export const registerHandler = asyncHandler(async (req, res) => {
  const user = await authService.register(req.body, res, meta(req));
  res.status(201).json({ user });
});

export const loginHandler = asyncHandler(async (req, res) => {
  const user = await authService.login(req.body, res, meta(req));
  res.json({ user });
});

export const logoutHandler = asyncHandler(async (req, res) => {
  await authService.logout(res, req.cookies?.refresh_token);
  res.status(204).end();
});

export const refreshHandler = asyncHandler(async (req, res) => {
  const user = await authService.refresh(req.cookies?.refresh_token, res, meta(req));
  res.json({ user });
});

export const verifyEmailHandler = asyncHandler(async (req, res) => {
  await authService.verifyEmail(req.body.token);
  res.json({ ok: true });
});

export const resendVerificationHandler = asyncHandler(async (req, res) => {
  await authService.resendVerification(req.body.email);
  res.json({ ok: true });
});

export const forgotPasswordHandler = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body.email);
  res.json({ ok: true });
});

export const resetPasswordHandler = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  res.json({ ok: true });
});

export const meHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const user = await authService.getCurrentUser(req.user.sub);
  res.json({ user });
});
