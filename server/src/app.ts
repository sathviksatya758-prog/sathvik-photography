import './lib/bigintJson';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { env, isProd, caps } from './config/env';
import { LOCAL_STORAGE_ROOT } from './lib/storage';
import { requestLogger } from './middleware/requestLogger';
import { ensureCsrfCookie, verifyCsrf } from './middleware/csrf';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/error';

import { authRouter } from './modules/auth/auth.routes';
import { photosRouter } from './modules/photos/photos.routes';
import { uploadsRouter } from './modules/uploads/uploads.routes';
import { searchRouter } from './modules/search/search.routes';
import { chatRouter } from './modules/chat/chat.routes';
import { contactRouter } from './modules/contact/contact.routes';
import { analyticsRouter } from './modules/analytics/analytics.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { favoritesRouter } from './modules/favorites/favorites.routes';
import { discoveryRouter } from './modules/discovery/discovery.routes';
import { recommendationsRouter } from './modules/recommendations/recommendations.routes';
import { settingsRouter } from './modules/settings/settings.routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API only ever returns JSON — no HTML is rendered here, so a
      // strict CSP mainly protects error pages / any future admin UI.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );

  // Credentialed requests (the frontend sends cookies) require the exact
  // page origin to be echoed back — a wildcard is not allowed. A single
  // hardcoded CLIENT_ORIGIN broke sign-in/sign-up whenever the page was
  // served from any other local origin (Live Server on :5500, a different
  // port, or 127.0.0.1 vs localhost), which the browser surfaces only as
  // an opaque "Failed to fetch". So: allow the configured origin(s), and
  // in development additionally reflect any localhost/127.0.0.1 origin.
  const allowedOrigins = new Set([env.CLIENT_ORIGIN, env.API_BASE_URL]);
  const isLocalOrigin = (origin: string): boolean => {
    try {
      const h = new URL(origin).hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
    } catch {
      return false;
    }
  };
  app.use(
    cors({
      origin(origin, cb) {
        // No Origin header = same-origin, curl, or a mobile app — allow.
        if (!origin) return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        if (!isProd && isLocalOrigin(origin)) return cb(null, true);
        // Reject without throwing (a thrown error would 500 rather than
        // cleanly omit the CORS headers).
        return cb(null, false);
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
      exposedHeaders: ['X-Request-Id']
    })
  );

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());
  app.use(requestLogger);
  app.use(ensureCsrfCookie);
  app.use(verifyCsrf);
  app.use(apiLimiter);

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  // When no S3 is configured, uploaded originals and renditions live on
  // local disk (see lib/storage.ts) and are served from here. In production
  // you'd put a real object store + CDN in front instead; this exists so the
  // upload pipeline works with zero external storage setup.
  if (!caps.s3 && !caps.blob) {
    app.use(
      '/media',
      express.static(LOCAL_STORAGE_ROOT, {
        immutable: true,
        maxAge: '1y',
        fallthrough: false,
        setHeaders(res, filePath) {
          // express.static's mime table doesn't know AVIF; originals are
          // stored extensionless. Set an image content-type so browsers and
          // caches treat them correctly instead of octet-stream.
          if (filePath.endsWith('.avif')) res.type('image/avif');
          else if (!/\.[a-z0-9]+$/i.test(filePath)) res.type('image/jpeg');
        }
      })
    );
  }

  app.use('/api/auth', authRouter);
  app.use('/api/photos', photosRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/contact', contactRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/favorites', favoritesRouter);
  app.use('/api/discovery', discoveryRouter);
  app.use('/api/recommendations', recommendationsRouter);
  app.use('/api/settings', settingsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
