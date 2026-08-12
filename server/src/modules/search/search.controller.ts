import { asyncHandler } from '../../utils/asyncHandler';
import * as searchService from './search.service';

export const searchHandler = asyncHandler(async (req, res) => {
  const { q, k } = req.query as unknown as { q: string; k: number };
  const results = await searchService.searchPhotos(q, k);
  res.json({ results });
});

export const similarHandler = asyncHandler(async (req, res) => {
  const results = await searchService.similarPhotos(req.params.id, 6);
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=900').json({ results });
});
