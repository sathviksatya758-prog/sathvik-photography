import { z } from 'zod';

export const askSchema = z.object({
  message: z.string().trim().min(1).max(600),
  // .nullable() matters: the frontend's chat state starts as
  // `chatSessionId: null` and sends it verbatim on the very first message
  // of every session — `JSON.stringify({sessionId: null})` produces a
  // literal `null`, not an omitted key, which `.optional()` alone rejects.
  // That meant the first message of *every* chat session 400'd.
  sessionId: z.string().uuid().nullable().optional()
});
