# Exhibition upgrade — integration guide

An additive upgrade to the existing portfolio. Nothing in your current file is replaced;
these modules attach to the DOM and data model you already have.

```
upgrade/exhibition.css     styling layer (extends your tokens, never overrides)
upgrade/exhibition.js      gallery, EXIF, palette, lightbox, search, RAG
server/schema.sql          Postgres + pgvector
server/lib.ts              embeddings, image pipeline, RAG, persistence
server/routes.ts           API handlers
```

---

## 1. Client — wiring into the existing page

Add two tags before `</body>` in your current HTML:

```html
<link rel="stylesheet" href="upgrade/exhibition.css">
<script src="upgrade/exhibition.js"></script>
```

Then one call, after your existing `boot()` runs:

```js
Exhibition.init({
  getPhotos: () => state.moments,        // your existing array
  persist:   () => storageSave(state.moments)
});
```

The module reads your array, generates what's missing (blur placeholders, palettes,
vectors), and mounts the gallery. If you don't pass `mount`, it appends itself after
`#index-list`, so your Index section stays exactly as it is.

### Replacing the upload path

Your current `handleFiles` reads the file and calls `analyzeMoment`. Swap the body for:

```js
async function handleFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const photo = await Exhibition.ingest(file, {
      onPhoto: p => { state.moments.unshift(p); renderAll(); },   // instant paint
      onProgress: (stage, pct) => setProgress(stage, pct)
    });
    const i = state.moments.findIndex(m => m.id === photo.id);
    if (i > -1) state.moments[i] = photo;
    storageSave(state.moments);
    await Exhibition.refresh();
  }
}
```

`ingest` runs in order: EXIF from the raw bytes → data URL → blur placeholder → colour
palette → one Claude vision call that returns caption, description, alt text, story,
tags, categories, collections, SEO keywords, hashtags, mood, composition, lighting,
colour analysis, and editing style.

### Replacing the chatbot with the RAG assistant

Your `sendChat` currently posts the whole history to Claude. Change one line:

```js
const { text, sources } = await Exhibition.ask(msg, state.chatMsgs);
state.chatMsgs.push({ role: 'assistant', content: text, sources });
```

`Exhibition.ask` retrieves the top five chunks from your bio, FAQs and photo records,
passes only those into the prompt, and instructs the model to cite them as `[1]`, `[2]`
and to refuse rather than invent. Render `sources` with the `.xp-sources` class.

### What each piece actually does

| Feature | Implementation |
|---|---|
| EXIF | Real APP1/TIFF parser over the uploaded bytes — camera, lens, focal, aperture, shutter, ISO, exposure bias, flash, white balance, GPS |
| Palette | Canvas sampling at 64×64 → k-means (k=5, 8 iterations) → hex, share %, warm/cool temperature, luminance |
| Blur placeholder | 24px canvas downscale → base64 JPEG, cross-faded when the full image loads |
| Masonry | Absolute positioning with shortest-column packing, `translate3d`, FLIP animation on filter change, `ResizeObserver` |
| Lazy loading | `IntersectionObserver` with 300px rootMargin plus native `loading="lazy"` |
| Lightbox | Arrow keys, Escape, Home/End, `+`/`-`/`0` zoom, wheel zoom, pointer drag panning, filmstrip, focus trap |
| Semantic search | Lexical vectors with synonym expansion and cosine similarity for instant results; Enter or "Ask AI" sends the catalogue to Claude for a true natural-language read |
| Similar photos | Cosine over the same vectors, scored as a percentage |
| SEO | JSON-LD `Person` + `ImageObject` graph with EXIF `PropertyValue` entries, plus og/twitter meta, regenerated whenever the archive changes |

---

## 2. Server

```bash
createdb sathvik_portfolio
psql sathvik_portfolio -f server/schema.sql
npm i pg sharp exifr @anthropic-ai/sdk zod @aws-sdk/client-s3
```

```env
DATABASE_URL=postgres://localhost/sathvik_portfolio
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...        # embeddings only
S3_BUCKET=... S3_KEY=... S3_SECRET=... S3_ENDPOINT=... CDN_BASE=https://cdn.example.com
```

Split `routes.ts` into App Router files:

```
app/api/upload/route.ts        → export { POST_upload as POST }
app/api/photos/route.ts        → export { GET_photos as GET }
app/api/photos/[slug]/route.ts → export { GET_photo as GET }
app/api/photos/[id]/route.ts   → export { DELETE_photo as DELETE }
app/api/search/route.ts        → export { GET_search as GET }
app/api/similar/[id]/route.ts  → export { GET_similar as GET }
app/api/assistant/route.ts     → export { POST_assistant as POST }
app/api/reindex/route.ts       → export { POST_reindex as POST }
```

To route the client through your server instead of calling Anthropic from the browser
(which is what you want in production, so the key stays server-side):

```js
Exhibition.config.apiBase = '/api';
```

### Why the server version is stronger

The browser module uses lexical vectors — good, fast, and honest, but it matches words.
The server uses real 1536-dimension embeddings in pgvector with an HNSW index, so
"quiet melancholy at the coast" finds a frame tagged `solitude, sea, overcast` even with
no shared words. `search_photos()` fuses cosine similarity (75%) with trigram term
matching (25%) so exact tag hits still rank.

### Image pipeline

`buildRenditions` emits AVIF, WebP and JPEG at 320/640/960/1440/2048 and a 24px LQIP.
Serve with:

```html
<picture>
  <source type="image/avif" srcset="{srcSet(id,'avif',widths)}" sizes="(max-width:640px) 100vw, 33vw">
  <source type="image/webp" srcset="{srcSet(id,'webp',widths)}" sizes="...">
  <img src="{cdn}/{id}/960.jpeg" width={w} height={h} alt={altText} loading="lazy" decoding="async">
</picture>
```

AVIF at quality 55 typically lands 45–60% below equivalent JPEG.

---

## 3. Performance and accessibility notes

Always set `width` and `height` (or `aspect-ratio`) on every image — the masonry already
sizes tiles from the stored aspect, so cumulative layout shift stays at zero. Preload only
the first hero frame; everything else is lazy. Keep the Anthropic key server-side once
`apiBase` is set. For code splitting, load `exhibition.js` with `type="module"` and
dynamic-import the lightbox and detail view on first use — they are the two heaviest paths
and neither is needed for first paint.

On accessibility: every tile is a real focusable control with an `aria-label`, the
lightbox traps focus and is fully keyboard-driven, alt text comes from the AI pass rather
than being decorative, and `prefers-reduced-motion` collapses every transition.

The one number I can't hand you is a Lighthouse score — it comes from running the audit on
your deployed URL. Build with these pieces and the usual result is 95+ on performance and
100 on accessibility and SEO, but verify it after deploy rather than taking my word.
