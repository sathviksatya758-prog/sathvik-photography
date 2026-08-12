# API Reference

Base URL: `{API_BASE_URL}/api` (default local dev: `http://localhost:4000/api`).

All responses are JSON. Errors follow:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": { } } }
```

Auth uses httpOnly cookies (`access_token`, `refresh_token`), not bearer tokens
in the body — the frontend must call with `credentials: 'include'`. Every
mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) requires an `X-CSRF-Token`
header matching the `csrf_token` cookie value (set automatically on any GET).

Rate limits (per IP, Redis-backed): general API 120/min, `/auth/*` 10/min,
`/uploads` 20/min, `/search` + `/chat` 30/min, `/contact` 5/hour.

---

## Auth — `/auth`

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/register` | – | `{email, username, password}` | Password ≥8 chars, strength ≥4/6. Role is `ADMIN` only if email matches `OWNER_EMAIL`. |
| POST | `/login` | – | `{email, password}` | Locks account for 15 min after 5 failed attempts. |
| POST | `/logout` | – | – | Revokes the current refresh token. |
| POST | `/refresh` | refresh cookie | – | Rotates the refresh token; reuse of an old one revokes all sessions for that user. |
| POST | `/verify-email` | – | `{token}` | Token from the emailed link. |
| POST | `/resend-verification` | – | `{email}` | Always 200, whether or not the account exists. |
| POST | `/forgot-password` | – | `{email}` | Always 200; emails a reset link if the account exists. |
| POST | `/reset-password` | – | `{token, password}` | Revokes all existing sessions on success. |
| GET | `/me` | required | – | Current user `{id,email,username,role,emailVerified}`. |

## Photos — `/photos`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | – | Query: `limit` (≤60), `cursor` (ISO date), `category`. Cursor-paginated, cached 45s. |
| GET | `/:slug` | – | Full detail: EXIF, AI metadata, palette, related photos. Records a view. |
| DELETE | `/:id` | admin | Soft delete. |
| POST | `/:id/download` | optional | Body via query `format` (avif/webp/jpeg). Logs a `Download` row, returns a URL. |
| POST | `/:id/critique` | admin | On-demand only — a second Claude call, never automatic. Query `?regenerate=true` to force a fresh critique instead of the cached one. Returns exposure/composition/cropping/white-balance/sharpness/noise/editing feedback. |

## Uploads — `/uploads`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/` | admin | `multipart/form-data`, field `file` (≤`MAX_UPLOAD_MB`, image/* only). Returns `202` with `{id,slug,status:"PROCESSING",lqip,exif,palette}` immediately; AI captioning/renditions/embeddings finish in the background worker. |
| GET | `/:id/status` | admin | Poll until `status` is `READY` or `FAILED`. Once ready, includes the full expanded `PhotoAi` record (title, multi-platform captions, composition/quality scores, etc — see schema.prisma). |
| POST | `/:id/retry` | admin | Re-enqueues a `FAILED` photo's background job (e.g. after a transient Claude/OpenAI outage). 400 if the photo isn't currently `FAILED`. |

## Discovery — `/discovery`

The Discovery feed is the default browsing experience: horizontal,
AI-categorised rows rather than one long vertical list. Rows are derived
entirely from each photo's generated metadata, so they re-populate
themselves whenever the upload worker finishes a new photograph — there is
no manual curation step. Add or change a collection by editing
`server/src/modules/discovery/taxonomy.ts`; no schema change or migration
is required.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | – | The whole feed: `{rows[], totalPhotos, generatedAt}`. Each row is `{slug, title, subtitle?, kind, total, photos[]}` where `kind` is `featured\|recent\|collection\|camera\|category`. Rows are capped at 24 photos; cached 5 min. |
| GET | `/collections` | – | Lightweight index of every populated auto-collection with a cover photo. |
| GET | `/collections/:slug?limit=&offset=` | – | Full, paginated contents of one collection (not capped like the feed rows). |
| GET | `/map?zoom=&fromYear=&toYear=` | – | GPS clusters for the photography map. Grid-clustered server-side; cell size scales with `zoom` (1–12), giving country-level grouping at low zoom and city clustering at high zoom. Returns `{clusters[], totalGeotagged, yearRange}`. |
| POST | `/map/photos` | – | `{photoIds[]}` — photos inside one clicked cluster. |

## Recommendations — `/recommendations`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/:id` | – | Every "keep exploring" rail for one photograph, in display order. Cached 15 min per photo. |

Rails returned (empty ones are omitted, and a rail is dropped if an earlier
rail already showed nearly all of its photos — so the same six frames never
appear under four headings):

`ai-recommended` · `related` · `more-like-this` · `same-category` ·
`shared-subjects` · `same-palette` · `same-mood` · `same-camera` ·
`same-lens` · `same-location` · `recent`

**Signals.** `ai-recommended` is a weighted fusion, not any single measure —
semantic embeddings (0.40), colour distance (0.14), shared AI categories
(0.14), shared detection tags normalised by overlap depth (0.12), mood
(0.08), camera (0.07), lens (0.05). It degrades gracefully: a photo with no
GPS, no EXIF and no palette still gets sensible semantic results. The
supporting SQL lives in `prisma/manual-additions.sql`
(`similar_by_palette`, `nearby_photos`, alongside the existing
`similar_photos`).

## Client galleries — `/collections`

Shareable deliveries of a manually-curated collection, on top of the
existing collection CRUD. The **client-gallery management** screen drives
all of these; the public share URL (`/?gallery=<slug>`) renders the
**shared-gallery view**.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | owner | Lists the owner's collections with `photoCount` and `hasPassword` (the Argon2 hash is never returned to the client). |
| POST | `/` | owner | `{name, description?, isPublic?, kind?}` where `kind` ∈ COLLECTION/ALBUM/PROJECT/STORY/JOURNAL/SEASONAL. |
| POST | `/:id/share` | owner | `{password?, expiresAt?, allowDownload?, watermark?}` → mints (or updates) an unguessable share slug and returns the share URL. Passwords are Argon2-hashed, never stored plaintext. |
| DELETE | `/:id/share` | owner | Revokes the link and clears any password/expiry. |
| GET | `/shared/:shareSlug` | – | Public read. Returns `{locked:true, name, photoCount}` **without photos** when a password is set and not yet unlocked; `410 Gone` past `expiresAt`. |
| POST | `/shared/:shareSlug/unlock` | – | `{password}` → sets a 12h httpOnly unlock cookie scoped to that one gallery (unlocking gallery A grants no access to gallery B). |

## Search — `/search`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/?q=&k=` | – | Hybrid: 75% cosine similarity over embeddings + 25% trigram term match (`search_photos` SQL function). Results cached 5 min per query, invalidated on any upload/delete. |
| GET | `/similar/:id` | – | Visually/semantically similar photos, cached 5 min. |

## Chat — `/chat`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/` | optional | `{message, sessionId?}`. RAG over `knowledge_chunks` (bio/FAQ + per-photo chunks) plus a live-computed stats block (total count, most recent upload, camera/lens diversity — never cached, always current). Claude call scoped to a photography-only system prompt. Returns `{sessionId, message, sources, cached}`. First-turn answers are cached 10 min by normalized question text; follow-ups (with prior context) are never cached. |
| POST | `/stream` | optional | Same inputs/retrieval as above, but responds as Server-Sent Events instead of a single JSON body — frames are `event: sessionId\|delta\|sources\|error\|done`, `data: <json>`. Used by the chat widget for progressive rendering. |
| GET | `/:sessionId` | optional | Full transcript. 403 if the session belongs to a different logged-in user. |

## Contact — `/contact`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/` | – | `{name, email, subject?, message, company?}`. `company` is a honeypot — filled-in submissions are silently dropped. Emails `CONTACT_TO_EMAIL`. |
| GET | `/` | admin | Query: `status`, `limit`, `offset`. |
| PATCH | `/:id` | admin | `{status: NEW\|READ\|REPLIED\|ARCHIVED}` |

## Favorites — `/favorites`

| Method | Path | Auth |
|---|---|---|
| GET | `/` | required |
| PUT | `/:photoId` | required |
| DELETE | `/:photoId` | required |

## Collections — `/collections`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | required | Own collections only. |
| POST | `/` | required | `{name, description?, isPublic?}` |
| GET | `/:id` | optional | Public collections are readable by anyone; private ones require ownership. |
| DELETE | `/:id` | required (owner) | |
| POST | `/:id/photos` | required (owner) | `{photoId}` |
| DELETE | `/:id/photos/:photoId` | required (owner) | |

## Analytics — `/analytics`

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/event` | – | `{type, path?, photoId?, meta?}`. Sets an anonymous `aid` cookie to group events per browser. |
| GET | `/summary?days=30` | admin | Totals, events by type, top paths, top photos, daily counts. |

## Admin — `/admin` (all routes require `role: ADMIN`)

| Method | Path | Notes |
|---|---|---|
| GET | `/stats` | Dashboard summary (wraps `/analytics/summary` + photo status counts). |
| GET | `/photos?status=&limit=&offset=` | All photos including `PROCESSING`/`HIDDEN`/`FAILED`. |
| POST | `/photos/:id/retry` | Same as `POST /uploads/:id/retry` — re-enqueues a failed photo's job. |
| GET | `/users?limit=&offset=` | User list. |
| PATCH | `/users/:id/role` | `{role: USER\|ADMIN}`. Can't remove your own admin access. |
| GET | `/audit-logs?limit=&offset=` | Who did what (logins, uploads, deletes, role changes, suggestion reviews). |
| POST | `/knowledge/reindex` | `{entries:[{kind,title,body}]}` — rebuilds the bio/FAQ half of the chat knowledge base. |
| GET | `/suggestions?status=&kind=&limit=&offset=` | AI-generated auto-organization proposals (`FEATURED`, `DUPLICATE`) awaiting review. Generated automatically after each upload (see `jobs/worker.ts::generateSuggestions`) — nothing is ever applied without approval. |
| PATCH | `/suggestions/:id` | `{status: APPROVED\|REJECTED}`. Approving a `FEATURED` suggestion sets `Photo.featured = true`. Approving a `DUPLICATE` suggestion only records the decision — it never deletes anything; that stays a deliberate `DELETE /photos/:id` call. |
| GET | `/insights?refresh=true` | Portfolio-wide statistics: top subjects, genre/camera/lens/focal-length/ISO distribution, color trends, shooting locations, seasonal + monthly upload trends, average composition/quality scores, `mostViewed[]` and `mostDownloaded[]` (each `{slug, lqip, thumb, caption, count}`), plus a short AI-written narrative summary. Cached 6h; `?refresh=true` recomputes (including a fresh narrative) immediately. Backs the **analytics dashboard** screen. |

### A note on the AI-estimated fields

`compositionScore`, `qualityScore`, `sceneClassification`, `weatherEstimate`,
`timeOfDayEstimate`, `ruleOfThirds`, `symmetryDetected`, and `leadingLines`
(on `PhotoAi`) are Claude's holistic visual judgment from looking at the
image — the same mechanism that produces the caption/mood/story fields. This
is **not** a dedicated object-detection or scene-classification model (no
YOLO, no CV pipeline); treat scores as an expert opinion, not a measurement.
See the comment at the top of `server/src/modules/uploads/ai.service.ts`.

## Health

`GET /health` — `{ok: true, ts}`, unauthenticated, excluded from request logging.
