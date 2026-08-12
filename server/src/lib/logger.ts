import pino from 'pino';
import { isProd } from '../config/env';

// Pretty logging in dev is a convenience, not a requirement. pino-pretty is a
// devDependency, so a production/CI install (or a partial `npm install`) may
// not have it — in that case fall back to plain JSON logs rather than
// crashing the whole server on startup.
function prettyTransport() {
  if (isProd) return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
  } catch {
    return undefined;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.accessToken'
    ],
    remove: true
  },
  transport: prettyTransport()
});
