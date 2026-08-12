import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Wraps an async route handler so rejected promises reach Express's
// error middleware instead of becoming unhandled rejections.
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
}
