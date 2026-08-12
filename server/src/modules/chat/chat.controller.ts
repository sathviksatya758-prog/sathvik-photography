import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import * as chatService from './chat.service';
import { logger } from '../../lib/logger';

export const askHandler = asyncHandler(async (req, res) => {
  const { message, sessionId } = req.body as { message: string; sessionId?: string };
  const result = await chatService.ask(message, sessionId, req.user?.sub);
  res.json(result);
});

// Server-Sent Events: same retrieval + answer as POST /chat, but streamed
// as text deltas so the widget can render progressively instead of
// waiting for the full reply. Event frames: sessionId, delta*, sources, done.
export const askStreamHandler = asyncHandler(async (req, res) => {
  const { message, sessionId } = req.body as { message: string; sessionId?: string };

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    for await (const chunk of chatService.askStream(message, sessionId, req.user?.sub)) {
      send(chunk.type, chunk.data);
    }
  } catch (err) {
    logger.error({ err }, 'chat stream failed');
    send('error', { message: 'The studio assistant is unavailable right now — try again shortly.' });
  } finally {
    res.end();
  }
});

const sessionParams = z.object({ sessionId: z.string().uuid() });

export const getSessionHandler = asyncHandler(async (req, res) => {
  const { sessionId } = sessionParams.parse(req.params);
  const session = await chatService.getSession(sessionId, req.user?.sub);
  res.json({ session });
});
