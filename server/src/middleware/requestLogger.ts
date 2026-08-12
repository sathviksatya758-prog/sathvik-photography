import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger';

export const requestLogger = pinoHttp({
  logger,
  genReqId: req => (req.headers['x-request-id'] as string) || randomUUID(),
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} -> ${res.statusCode} (${err.message})`,
  autoLogging: {
    ignore: req => req.url === '/health' || req.url === '/favicon.ico'
  }
});
