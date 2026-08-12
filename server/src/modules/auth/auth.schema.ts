import { z } from 'zod';

const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const username = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Username: 3-20 chars, letters, numbers, . _ -');

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  username,
  password
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1)
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email()
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password
});

export const verifyEmailSchema = z.object({
  token: z.string().min(10)
});

export const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email()
});
