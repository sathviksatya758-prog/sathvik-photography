import './lib/bigintJson';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
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
import { collectionsRouter } from './modules/collections/collections.routes';
import { discoveryRouter } from './modules/discovery/discovery.routes';
import { recommendationsRouter } from './modules/recommendations/recommendations.routes';

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

  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
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

  app.use('/api/auth', authRouter);
  app.use('/api/photos', photosRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/contact', contactRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/favorites', favoritesRouter);
  app.use('/api/collections', collectionsRouter);
  app.use('/api/discovery', discoveryRouter);
  app.use('/api/recommendations', recommendationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
