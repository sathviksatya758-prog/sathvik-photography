import nodemailer from 'nodemailer';
import { env, isProd } from '../config/env';
import { logger } from './logger';

// SMTP is provider-agnostic on purpose — point it at SES, SendGrid, Resend,
// Mailtrap, MailDev, or a Gmail app password in dev. See .env.example.
const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
});

export async function sendMail(opts: { to: string; subject: string; html: string; text: string }): Promise<void> {
  try {
    await transport.sendMail({ from: env.MAIL_FROM, ...opts });
  } catch (err) {
    // Email delivery must never take down the request that triggered it
    // (registration, password reset, contact form) — log and continue.
    logger.error({ err, to: opts.to, subject: opts.subject }, 'sendMail failed');
    if (!isProd) throw err;
  }
}

export function verifyEmailTemplate(link: string) {
  return {
    subject: 'Verify your email',
    text: `Confirm your email address: ${link}\n\nThis link expires in 24 hours.`,
    html: `<p>Confirm your email address to finish creating your account.</p>
      <p><a href="${link}">${link}</a></p><p>This link expires in 24 hours.</p>`
  };
}

export function resetPasswordTemplate(link: string) {
  return {
    subject: 'Reset your password',
    text: `Reset your password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
    html: `<p>Reset your password using the link below.</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`
  };
}

export function contactNotificationTemplate(msg: { name: string; email: string; subject?: string | null; message: string }) {
  return {
    subject: `New contact message${msg.subject ? `: ${msg.subject}` : ''}`,
    text: `From: ${msg.name} <${msg.email}>\n\n${msg.message}`,
    html: `<p><strong>From:</strong> ${msg.name} &lt;${msg.email}&gt;</p><p>${msg.message.replace(/\n/g, '<br/>')}</p>`
  };
}
