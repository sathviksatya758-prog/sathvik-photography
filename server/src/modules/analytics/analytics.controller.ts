import { asyncHandler } from '../../utils/asyncHandler';
import { recordEvent, getAnalyticsSummary, getOrCreateAnalyticsSessionId } from './analytics.service';
import { env } from '../../config/env';

export const trackEventHandler = asyncHandler(async (req, res) => {
  const sid = getOrCreateAnalyticsSessionId(req);
  if (!req.cookies?.aid) {
    res.cookie('aid', sid, {
      httpOnly: false,
      sameSite: env.COOKIE_SECURE ? 'none' : 'lax',
      secure: env.COOKIE_SECURE,
      maxAge: 365 * 86_400_000
    });
  }
  await recordEvent({ ...req.body, req });
  res.status(204).end();
});

export const analyticsSummaryHandler = asyncHandler(async (req, res) => {
  const days = Number(req.query.days ?? 30);
  const summary = await getAnalyticsSummary(days);
  res.json(summary);
});
