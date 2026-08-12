import { asyncHandler } from '../../utils/asyncHandler';
import * as adminService from './admin.service';
import * as suggestionsService from './suggestions.service';
import { reindexKnowledge } from '../chat/chat.service';
import { retryUpload } from '../uploads/uploads.service';
import { getPortfolioInsights } from './insights.service';

export const dashboardStatsHandler = asyncHandler(async (req, res) => {
  const days = Number(req.query.days ?? 30);
  res.json(await adminService.getDashboardStats(days));
});

export const adminListPhotosHandler = asyncHandler(async (req, res) => {
  const { limit, offset, status } = req.query as unknown as { limit: number; offset: number; status?: 'PROCESSING' | 'READY' | 'FAILED' | 'HIDDEN' };
  res.json(await adminService.listAllPhotos({ limit, offset, status }));
});

export const adminListUsersHandler = asyncHandler(async (req, res) => {
  const { limit, offset } = req.query as unknown as { limit: number; offset: number };
  res.json(await adminService.listUsers({ limit, offset }));
});

export const updateUserRoleHandler = asyncHandler(async (req, res) => {
  const user = await adminService.updateUserRole(req.params.id, req.body.role, req.user!.sub);
  res.json({ user });
});

export const auditLogsHandler = asyncHandler(async (req, res) => {
  const { limit, offset } = req.query as unknown as { limit: number; offset: number };
  res.json(await adminService.listAuditLogs({ limit, offset }));
});

export const reindexKnowledgeHandler = asyncHandler(async (req, res) => {
  const count = await reindexKnowledge(req.body.entries);
  res.json({ ok: true, count });
});

export const listSuggestionsHandler = asyncHandler(async (req, res) => {
  const { limit, offset, status, kind } = req.query as unknown as {
    limit: number;
    offset: number;
    status?: 'PENDING' | 'APPROVED' | 'REJECTED';
    kind?: 'FEATURED' | 'DUPLICATE' | 'SIMILAR_GROUP' | 'COLLECTION';
  };
  res.json(await suggestionsService.listSuggestions({ limit, offset, status, kind }));
});

export const reviewSuggestionHandler = asyncHandler(async (req, res) => {
  const suggestion = await suggestionsService.reviewSuggestion(req.params.id, req.body.status, req.user!.sub);
  res.json({ suggestion });
});

export const retryPhotoHandler = asyncHandler(async (req, res) => {
  await retryUpload(req.params.id, req.user!.sub);
  res.status(202).json({ ok: true });
});

export const portfolioInsightsHandler = asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === 'true';
  res.json(await getPortfolioInsights(refresh));
});
