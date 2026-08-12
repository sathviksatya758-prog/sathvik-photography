import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { sendMail, contactNotificationTemplate } from '../../lib/mailer';
import { env } from '../../config/env';
import type { ContactStatus } from '@prisma/client';

export async function submitContact(
  input: { name: string; email: string; subject?: string; message: string; company?: string },
  meta: { ip?: string; userAgent?: string }
): Promise<{ id: string } | { id: null }> {
  // Honeypot tripped — pretend success so the bot moves on, but don't
  // touch the database or send an email.
  if (input.company) return { id: null };

  const msg = await prisma.contactMessage.create({
    data: { name: input.name, email: input.email, subject: input.subject, message: input.message, ip: meta.ip, userAgent: meta.userAgent }
  });

  await sendMail({ to: env.CONTACT_TO_EMAIL, ...contactNotificationTemplate(msg) });

  return { id: msg.id };
}

export async function listMessages(opts: { status?: ContactStatus; limit: number; offset: number }) {
  const [messages, total] = await Promise.all([
    prisma.contactMessage.findMany({
      where: opts.status ? { status: opts.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      skip: opts.offset
    }),
    prisma.contactMessage.count({ where: opts.status ? { status: opts.status } : undefined })
  ]);
  return { messages, total };
}

export async function updateStatus(id: string, status: ContactStatus) {
  const msg = await prisma.contactMessage.findUnique({ where: { id } });
  if (!msg) throw AppError.notFound('Message not found');
  return prisma.contactMessage.update({ where: { id }, data: { status } });
}
