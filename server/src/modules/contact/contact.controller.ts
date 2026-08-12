import { asyncHandler } from '../../utils/asyncHandler';
import * as contactService from './contact.service';

export const submitContactHandler = asyncHandler(async (req, res) => {
  await contactService.submitContact(req.body, { ip: req.ip, userAgent: req.headers['user-agent'] });
  // Same response whether the honeypot tripped or not.
  res.status(201).json({ ok: true });
});

export const listMessagesHandler = asyncHandler(async (req, res) => {
  const { status, limit, offset } = req.query as unknown as { status?: 'NEW' | 'READ' | 'REPLIED' | 'ARCHIVED'; limit: number; offset: number };
  const result = await contactService.listMessages({ status, limit, offset });
  res.json(result);
});

export const updateStatusHandler = asyncHandler(async (req, res) => {
  const message = await contactService.updateStatus(req.params.id, req.body.status);
  res.json({ message });
});
