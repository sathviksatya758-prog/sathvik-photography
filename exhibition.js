/* ============================================================
   exhibition.js — additive upgrade module
   Attaches to the existing portfolio. Reads the host's photo
   array, enriches it, and mounts premium gallery UI.

   Integration (one line in your existing page):
     Exhibition.init({ getPhotos: () => state.moments,
                       persist:  () => storageSave(state.moments) });
   ============================================================ */

(function (root) {
  'use strict';

  /* ---------------------------------------------------------
     0. Config + tiny utilities
     --------------------------------------------------------- */
  const CFG = {
    model: 'claude-sonnet-4-20250514',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiBase: null,          // set to '/api' to route through your server
    gutter: 18,
    breakpoints: [[1400, 4], [1024, 3], [640, 2], [0, 1]],
    lqipWidth: 24,
    paletteK: 5
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------
     1. EXIF — real APP1/TIFF parser over the uploaded bytes
     --------------------------------------------------------- */
  const Exif = (() => {
    const TAGS = {
      0x010F: 'make', 0x0110: 'model', 0x0112: 'orientation',
      0x0132: 'dateTime', 0x8769: 'exifIFD', 0x8825: 'gpsIFD',
      0x011A: 'xRes', 0x011B: 'yRes', 0x0131: 'software',
      0x013B: 'artist', 0x8298: 'copyright'
    };
    const EXIF_TAGS = {
      0x829A: 'exposureTime', 0x829D: 'fNumber', 0x8822: 'exposureProgram',
      0x8827: 'iso', 0x9003: 'dateTimeOriginal', 0x9204: 'exposureBias',
      0x9207: 'meteringMode', 0x9209: 'flash', 0x920A: 'focalLength',
      0xA002: 'pixelX', 0xA003: 'pixelY', 0xA402: 'exposureMode',
      0xA403: 'whiteBalance', 0xA406: 'sceneType', 0xA434: 'lensModel',
      0xA405: 'focalLength35', 0x9291: 'subsecOriginal'
    };
    const GPS_TAGS = {
      0x0001: 'latRef', 0x0002: 'lat', 0x0003: 'lonRef',
      0x0004: 'lon', 0x0005: 'altRef', 0x0006: 'alt'
    };
    const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

    function readValue(dv, entry, le, tiffStart) {
      const { type, count, valueOffset } = entry;
      const size = TYPE_SIZE[type] || 1;
      const total = size * count;
      const base = total > 4 ? tiffStart + valueOffset : entry.selfOffset + 8;
      if (base + total > dv.byteLength) return null;
      const read = i => {
        const o = base + i * size;
        switch (type) {
          case 1: case 7: return dv.getUint8(o);
          case 2: return dv.getUint8(o);
          case 3: return dv.getUint16(o, le);
          case 4: return dv.getUint32(o, le);
          case 9: return dv.getInt32(o, le);
          case 5: { const n = dv.getUint32(o, le), d = dv.getUint32(o + 4, le); return d ? n / d : 0; }
          case 10: { const n = dv.getInt32(o, le), d = dv.getInt32(o + 4, le); return d ? n / d : 0; }
          default: return 0;
        }
      };
      if (type === 2) {
        let s = '';
        for (let i = 0; i < count; i++) { const c = read(i); if (!c) break; s += String.fromCharCode(c); }
        return s.trim();
      }
      if (count === 1) return read(0);
      const out = []; for (let i = 0; i < count; i++) out.push(read(i));
      return out;
    }

    function readIFD(dv, offset, tiffStart, le, map) {
      const out = {};
      if (offset + 2 > dv.byteLength) return out;
      const n = dv.getUint16(offset, le);
      for (let i = 0; i < n; i++) {
        const e = offset + 2 + i * 12;
        if (e + 12 > dv.byteLength) break;
        const tag = dv.getUint16(e, le);
        const name = map[tag];
        if (!name) continue;
        const entry = {
          type: dv.getUint16(e + 2, le),
          count: dv.getUint32(e + 4, le),
          valueOffset: dv.getUint32(e + 8, le),
          selfOffset: e
        };
        out[name] = readValue(dv, entry, le, tiffStart);
      }
      return out;
    }

    function dms(arr, ref) {
      if (!Array.isArray(arr) || arr.length < 3) return null;
      let d = arr[0] + arr[1] / 60 + arr[2] / 3600;
      if (ref === 'S' || ref === 'W') d = -d;
      return Math.round(d * 1e6) / 1e6;
    }

    function fmtShutter(t) {
      if (!t) return null;
      if (t >= 1) return `${Math.round(t * 10) / 10}s`;
      return `1/${Math.round(1 / t)}s`;
    }

    function parse(buffer) {
      try {
        const dv = new DataView(buffer);
        if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;
        let off = 2, app1 = -1;
        while (off + 4 < dv.byteLength) {
          const marker = dv.getUint16(off);
          if ((marker & 0xFF00) !== 0xFF00) break;
          const len = dv.getUint16(off + 2);
          if (marker === 0xFFE1) {
            const sig = String.fromCharCode(
              dv.getUint8(off + 4), dv.getUint8(off + 5),
              dv.getUint8(off + 6), dv.getUint8(off + 7));
            if (sig === 'Exif') { app1 = off + 10; break; }
          }
          if (marker === 0xFFDA) break;
          off += 2 + len;
        }
        if (app1 < 0) return null;

        const bo = dv.getUint16(app1);
        if (bo !== 0x4949 && bo !== 0x4D4D) return null;
        const le = bo === 0x4949;
        if (dv.getUint16(app1 + 2, le) !== 0x002A) return null;
        const ifd0Off = dv.getUint32(app1 + 4, le);

        const ifd0 = readIFD(dv, app1 + ifd0Off, app1, le, TAGS);
        const exif = ifd0.exifIFD ? readIFD(dv, app1 + ifd0.exifIFD, app1, le, EXIF_TAGS) : {};
        const gps = ifd0.gpsIFD ? readIFD(dv, app1 + ifd0.gpsIFD, app1, le, GPS_TAGS) : {};

        const lat = dms(gps.lat, gps.latRef);
        const lon = dms(gps.lon, gps.lonRef);

        const data = {
          make: ifd0.make || null,
          model: ifd0.model || null,
          lens: exif.lensModel || null,
          software: ifd0.software || null,
          artist: ifd0.artist || null,
          shutter: fmtShutter(exif.exposureTime),
          shutterRaw: exif.exposureTime || null,
          aperture: exif.fNumber ? `f/${(Math.round(exif.fNumber * 10) / 10)}` : null,
          iso: exif.iso != null ? (Array.isArray(exif.iso) ? exif.iso[0] : exif.iso) : null,
          focal: exif.focalLength ? `${Math.round(exif.focalLength)}mm` : null,
          focal35: exif.focalLength35 ? `${Math.round(exif.focalLength35)}mm` : null,
          exposureBias: exif.exposureBias != null
            ? `${exif.exposureBias > 0 ? '+' : ''}${Math.round(exif.exposureBias * 10) / 10} EV` : null,
          flash: exif.flash != null ? ((exif.flash & 1) ? 'Fired' : 'Did not fire') : null,
          whiteBalance: exif.whiteBalance === 1 ? 'Manual' : (exif.whiteBalance === 0 ? 'Auto' : null),
          taken: exif.dateTimeOriginal || ifd0.dateTime || null,
          width: exif.pixelX || null,
          height: exif.pixelY || null,
          orientation: ifd0.orientation || 1,
          gps: (lat != null && lon != null) ? { lat, lon } : null
        };
        data.hasData = Object.keys(data).some(k =>
          !['orientation', 'hasData'].includes(k) && data[k] != null);
        return data;
      } catch (e) { return null; }
    }

    async function fromFile(file) {
      const buf = await file.arrayBuffer();
      return parse(buf);
    }

    function bodyLabel(x) {
      if (!x) return null;
      if (!x.make) return x.model || null;
      const make = x.make.split(' ')[0];
      if (x.model && x.model.toLowerCase().startsWith(make.toLowerCase())) return x.model;
      return `${make} ${x.model || ''}`.trim();
    }

    return { parse, fromFile, bodyLabel };
  })();

  /* ---------------------------------------------------------
     2. Colour — dominant palette via k-means over sampled pixels
     --------------------------------------------------------- */
  const Palette = (() => {
    function loadImage(src) {
      return new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = src;
      });
    }

    function sample(img, side) {
      const c = document.createElement('canvas');
      c.width = side; c.height = side;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, side, side);
      const d = ctx.getImageData(0, 0, side, side).data;
      const px = [];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        px.push([d[i], d[i + 1], d[i + 2]]);
      }
      return px;
    }

    function kmeans(px, k, iters) {
      if (!px.length) return [];
      const cents = [];
      const step = Math.floor(px.length / k) || 1;
      for (let i = 0; i < k; i++) cents.push(px[Math.min(i * step, px.length - 1)].slice());
      let assign = new Array(px.length).fill(0);
      for (let it = 0; it < iters; it++) {
        for (let i = 0; i < px.length; i++) {
          let best = 0, bd = Infinity;
          for (let c = 0; c < cents.length; c++) {
            const dr = px[i][0] - cents[c][0], dg = px[i][1] - cents[c][1], db = px[i][2] - cents[c][2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bd) { bd = d; best = c; }
          }
          assign[i] = best;
        }
        const sums = cents.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < px.length; i++) {
          const a = assign[i];
          sums[a][0] += px[i][0]; sums[a][1] += px[i][1];
          sums[a][2] += px[i][2]; sums[a][3]++;
        }
        for (let c = 0; c < cents.length; c++) {
          if (!sums[c][3]) continue;
          cents[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
        }
      }
      const counts = new Array(cents.length).fill(0);
      assign.forEach(a => counts[a]++);
      return cents
        .map((c, i) => ({
          rgb: c.map(Math.round),
          share: counts[i] / px.length
        }))
        .filter(c => c.share > 0.02)
        .sort((a, b) => b.share - a.share);
    }

    const hex = ([r, g, b]) => '#' + [r, g, b].map(v =>
      clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

    function luminance([r, g, b]) {
      const s = [r, g, b].map(v => {
        v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
    }

    function temperature(colors) {
      if (!colors.length) return null;
      let warm = 0, cool = 0;
      colors.forEach(c => {
        const [r, , b] = c.rgb;
        if (r > b) warm += c.share; else cool += c.share;
      });
      if (warm > cool * 1.6) return 'Warm';
      if (cool > warm * 1.6) return 'Cool';
      return 'Neutral';
    }

    async function extract(src, k) {
      try {
        const img = await loadImage(src);
        const px = sample(img, 64);
        const clusters = kmeans(px, k || CFG.paletteK, 8);
        const colors = clusters.map(c => ({
          hex: hex(c.rgb), rgb: c.rgb,
          share: Math.round(c.share * 100),
          light: luminance(c.rgb) > 0.55
        }));
        return {
          colors,
          temperature: temperature(clusters),
          averageLuma: Math.round(
            (clusters.reduce((s, c) => s + luminance(c.rgb) * c.share, 0)) * 100)
        };
      } catch (e) { return null; }
    }

    return { extract, hex, luminance };
  })();

  /* ---------------------------------------------------------
     3. LQIP — tiny blurred placeholder generated on device
     --------------------------------------------------------- */
  const Lqip = (() => {
    async function make(src, w) {
      return new Promise(res => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => {
          try {
            const width = w || CFG.lqipWidth;
            const height = Math.max(1, Math.round(width * (im.naturalHeight / im.naturalWidth)));
            const c = document.createElement('canvas');
            c.width = width; c.height = height;
            const ctx = c.getContext('2d');
            ctx.drawImage(im, 0, 0, width, height);
            res({
              uri: c.toDataURL('image/jpeg', 0.4),
              aspect: im.naturalWidth / im.naturalHeight,
              width: im.naturalWidth,
              height: im.naturalHeight
            });
          } catch (e) { res(null); }
        };
        im.onerror = () => res(null);
        im.src = src;
      });
    }
    return { make };
  })();

  /* ---------------------------------------------------------
     4. Vectors — lexical embeddings for search + similarity
     --------------------------------------------------------- */
  const Vec = (() => {
    const STOP = new Set(('a an the of in on at to for with and or is are was were this that ' +
      'it its by as from photo photograph image picture shot frame').split(' '));

    const SYN = {
      sunset: ['dusk', 'golden', 'evening', 'orange', 'sundown', 'twilight', 'warm', 'horizon'],
      sunrise: ['dawn', 'morning', 'daybreak', 'golden', 'early'],
      night: ['dark', 'nocturnal', 'stars', 'moon', 'evening', 'lowlight'],
      portrait: ['face', 'person', 'human', 'people', 'eyes', 'expression'],
      wildlife: ['animal', 'bird', 'creature', 'fauna', 'nature', 'wild'],
      landscape: ['vista', 'scenery', 'horizon', 'mountain', 'valley', 'field'],
      monument: ['temple', 'architecture', 'heritage', 'ruins', 'historic', 'building'],
      water: ['sea', 'ocean', 'river', 'lake', 'wave', 'beach', 'coast'],
      forest: ['tree', 'woods', 'jungle', 'green', 'foliage', 'canopy'],
      city: ['urban', 'street', 'building', 'town', 'metropolitan'],
      rain: ['wet', 'monsoon', 'storm', 'drizzle', 'water'],
      fog: ['mist', 'haze', 'cloudy', 'atmospheric', 'soft'],
      moody: ['dark', 'dramatic', 'shadow', 'contrast', 'brooding'],
      minimal: ['simple', 'clean', 'sparse', 'empty', 'negative'],
      warm: ['orange', 'amber', 'golden', 'red', 'sunset'],
      cool: ['blue', 'teal', 'cold', 'shade', 'winter']
    };

    function tokens(text) {
      return String(text || '').toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2 && !STOP.has(t));
    }

    function expand(list) {
      const out = new Set(list);
      list.forEach(t => {
        if (SYN[t]) SYN[t].forEach(s => out.add(s));
        Object.keys(SYN).forEach(k => { if (SYN[k].includes(t)) out.add(k); });
      });
      return Array.from(out);
    }

    function build(text, weightedText) {
      const v = Object.create(null);
      const add = (arr, w) => arr.forEach(t => { v[t] = (v[t] || 0) + w; });
      add(expand(tokens(text)), 1);
      if (weightedText) add(expand(tokens(weightedText)), 2.5);
      let norm = 0;
      for (const k in v) norm += v[k] * v[k];
      norm = Math.sqrt(norm) || 1;
      for (const k in v) v[k] /= norm;
      return v;
    }

    function cosine(a, b) {
      if (!a || !b) return 0;
      let s = 0;
      const small = Object.keys(a).length < Object.keys(b).length ? a : b;
      const big = small === a ? b : a;
      for (const k in small) if (big[k]) s += small[k] * big[k];
      return s;
    }

    function photoVector(p) {
      const ai = p.ai || {};
      const strong = [ai.caption, (ai.tags || []).join(' '), (ai.categories || []).join(' '),
        ai.mood, ai.subject].filter(Boolean).join(' ');
      const body = [ai.description, ai.story, ai.lighting, ai.composition,
        ai.colorAnalysis, p.ownerNote, (p.palette && p.palette.temperature)].filter(Boolean).join(' ');
      return build(body, strong);
    }

    return { build, cosine, photoVector, tokens, expand };
  })();

  /* ---------------------------------------------------------
     5. AI — vision enrichment, analysis, RAG, semantic rerank
     --------------------------------------------------------- */
  const AI = (() => {
    async function call(messages, system, tools, maxTokens) {
      const body = { model: CFG.model, max_tokens: maxTokens || 1024, messages };
      if (system) body.system = system;
      if (tools) body.tools = tools;
      const url = CFG.apiBase ? `${CFG.apiBase}/claude` : CFG.endpoint;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!data.content) throw new Error((data.error && data.error.message) || 'No response');
      return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }

    function parseJSON(text) {
      const cleaned = String(text).replace(/```json|```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start < 0 || end < 0) throw new Error('No JSON found');
      return JSON.parse(cleaned.slice(start, end + 1));
    }

    const ENRICH_SYSTEM =
      'You are a photography curator and metadata specialist writing for an exhibition catalogue. ' +
      'You reply with a single JSON object and nothing else — no prose, no markdown fences. ' +
      'Write with specificity and warmth. Never generic filler.';

    function enrichPrompt(exif, palette) {
      const ctx = [];
      if (exif && exif.hasData) {
        ctx.push('Camera metadata: ' + [
          Exif.bodyLabel(exif) && 'body ' + Exif.bodyLabel(exif),
          exif.lens && 'lens ' + exif.lens,
          exif.focal && 'focal ' + exif.focal,
          exif.aperture && 'aperture ' + exif.aperture,
          exif.shutter && 'shutter ' + exif.shutter,
          exif.iso && 'ISO ' + exif.iso
        ].filter(Boolean).join(', ') + '.');
      }
      if (palette && palette.colors) {
        ctx.push('Dominant colours: ' + palette.colors.map(c => c.hex).join(', ') +
          ' (overall ' + (palette.temperature || 'neutral').toLowerCase() + ').');
      }
      return `Analyse this photograph for an exhibition catalogue.${ctx.length ? ' ' + ctx.join(' ') : ''}

Return exactly this JSON shape:
{
  "caption": "under 8 words, evocative, title-like",
  "subject": "3-6 words naming the literal subject",
  "description": "2-3 sentences a curator would print beside the print",
  "altText": "one factual sentence for screen readers, describes what is visible",
  "story": "3-4 sentences of atmospheric narrative written in the photographer's first person voice",
  "tags": ["6-10 lowercase single words"],
  "categories": ["1-3 from: nature, wildlife, monuments, humans, landscape, street, abstract, architecture"],
  "collections": ["1-2 evocative series names this could belong to"],
  "seoKeywords": ["5-8 search phrases, 2-4 words each"],
  "hashtags": ["6-10 without the # symbol"],
  "mood": "2-4 words",
  "composition": "1-2 sentences on framing, balance, leading lines, rule of thirds",
  "lighting": "1-2 sentences on light quality, direction, time of day",
  "colorAnalysis": "1-2 sentences on the palette and how it carries the mood",
  "editingStyle": "1-2 sentences on grade, contrast, grain, likely post-processing",
  "technicalNote": "1 sentence on what the camera settings achieved, or a best guess if absent",
  "locationGuess": "place type or region if inferable, else null"
}`;
    }

    async function enrich(dataUrl, mediaType, exif, palette) {
      const base64 = dataUrl.split(',')[1];
      const raw = await call([{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: enrichPrompt(exif, palette) }
        ]
      }], ENRICH_SYSTEM, null, 1600);
      const j = parseJSON(raw);
      const arr = v => Array.isArray(v) ? v.filter(Boolean).map(String) : [];
      return {
        caption: j.caption || 'Untitled',
        subject: j.subject || '',
        description: j.description || '',
        altText: j.altText || j.description || 'Photograph',
        story: j.story || '',
        tags: arr(j.tags).map(t => t.toLowerCase()),
        categories: arr(j.categories).map(t => t.toLowerCase()),
        collections: arr(j.collections),
        seoKeywords: arr(j.seoKeywords),
        hashtags: arr(j.hashtags).map(h => h.replace(/^#/, '')),
        mood: j.mood || '',
        composition: j.composition || '',
        lighting: j.lighting || '',
        colorAnalysis: j.colorAnalysis || '',
        editingStyle: j.editingStyle || '',
        technicalNote: j.technicalNote || '',
        locationGuess: j.locationGuess || null,
        enrichedAt: Date.now()
      };
    }

    async function semanticSearch(query, photos) {
      // Real pgvector hybrid search on the backend (server/src/modules/search)
      // — not the generic AI.call() passthrough, since the server doesn't
      // expose a raw Claude proxy (any visitor could otherwise run arbitrary
      // prompts through the site's API key). Falls back to throwing, which
      // the caller (Gallery.aiSearch) already catches and handles by
      // showing the offline lexical results instead.
      const base = CFG.apiBase || 'http://localhost:4000/api';
      const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&k=12`, { credentials: 'include' });
      if (!res.ok) throw new Error('search request failed: ' + res.status);
      const { results } = await res.json();
      const byId = new Map(photos.map(p => [p.id, p]));
      return (results || [])
        .filter(r => byId.has(r.photo.id))
        .map(r => ({ photo: byId.get(r.photo.id), why: Math.round(r.score * 100) + '% match' }));
    }

    return { call, parseJSON, enrich, semanticSearch };
  })();

  /* ---------------------------------------------------------
     6. RAG — chunk, retrieve, cite over portfolio knowledge
     --------------------------------------------------------- */
  const RAG = (() => {
    let chunks = [];

    const BIO = [
      { id: 'bio-1', title: 'Biography', text: 'Katnam Sathvik is a photographer based in Visakhapatnam, Andhra Pradesh, India. He started photography in 2023, shooting nature, monuments, wildlife and humans, primarily on film.' },
      { id: 'bio-2', title: 'Approach', text: 'His approach is patient and slow. Most of his strongest frames happen inside five minutes of real conversation rather than direction. The work sits in the seam between documentary and memory.' },
      { id: 'faq-gear', title: 'Equipment', text: 'Works primarily with film cameras, supported by digital bodies. Camera and lens details for each frame are recorded in the EXIF panel on every photograph.' }
    ];

    function rebuild(photos) {
      chunks = BIO.map(b => ({ ...b, kind: 'knowledge', vec: Vec.build(b.text, b.title) }));
      const list = photos || [];
      if (list.length) {
        const years = list.map(p => p.createdAt && new Date(p.createdAt).getFullYear()).filter(Boolean);
        const span = years.length ? ` The earliest dates back to ${Math.min.apply(null, years)}.` : '';
        chunks.push({
          id: 'stats-total',
          title: 'Archive stats',
          kind: 'knowledge',
          text: `The archive currently holds ${list.length} photograph${list.length === 1 ? '' : 's'} total.${span}`,
          vec: Vec.build(`total photos taken so far how many photographs in the archive count`, 'Archive stats')
        });
      }
      (photos || []).forEach((p, i) => {
        const ai = p.ai || {};
        const parts = [ai.caption, ai.description, ai.story, ai.mood,
          (ai.tags || []).join(' '), p.ownerNote].filter(Boolean).join('. ');
        if (!parts) return;
        const exifLine = p.exif && p.exif.hasData
          ? ` Shot on ${Exif.bodyLabel(p.exif) || 'unrecorded camera'}${p.exif.lens ? ' with ' + p.exif.lens : ''}${p.exif.aperture ? ' at ' + p.exif.aperture : ''}${p.exif.iso ? ', ISO ' + p.exif.iso : ''}.`
          : '';
        chunks.push({
          id: 'photo-' + p.id,
          title: ai.caption || 'Untitled frame',
          text: parts + exifLine,
          kind: 'photo',
          photoId: p.id,
          index: i,
          vec: Vec.build(parts + exifLine, ai.caption)
        });
      });
      return chunks.length;
    }

    function retrieve(query, k) {
      const qv = Vec.build(query, query);
      return chunks
        .map(c => ({ chunk: c, score: Vec.cosine(qv, c.vec) }))
        .filter(r => r.score > 0.02)
        .sort((a, b) => b.score - a.score)
        .slice(0, k || 5);
    }

    async function answer(question, history) {
      const hits = retrieve(question, 5);
      const context = hits.length
        ? hits.map((h, i) => `[${i + 1}] ${h.chunk.title}: ${h.chunk.text}`).join('\n\n')
        : 'No matching entries in the archive.';
      const msgs = (history || []).slice(-6).map(m => ({ role: m.role, content: m.content }));
      msgs.push({
        role: 'user',
        content: `Retrieved context from the portfolio:\n\n${context}\n\nVisitor question: ${question}`
      });
      const text = await AI.call(msgs,
        'You are the studio assistant for photographer Katnam Sathvik. This is a personal ' +
        'portfolio, not a business — Sathvik does not sell prints, take commissions, or quote ' +
        'rates. Only answer questions about his photography: individual photographs in the ' +
        'archive, his biography, when he started, how many photos are in the archive, his ' +
        'approach and style, and his equipment. Answer ONLY from the retrieved context above ' +
        'and cite the sources you used inline as [1], [2]. If asked about pricing, prints, ' +
        'licensing, bookings or anything unrelated to his photography, say plainly that this ' +
        'is personal work and not for sale, and invite a question about the photos or his ' +
        'practice instead. If the context does not contain the answer to an in-scope question, ' +
        'say so plainly. Warm, concise, under 5 sentences. Never invent dates, gear, or counts.',
        null, 700);
      return { text, sources: hits.map(h => h.chunk) };
    }

    return { rebuild, retrieve, answer, get chunks() { return chunks; } };
  })();

  /* ---------------------------------------------------------
     7. Masonry — FLIP-animated absolute layout
     --------------------------------------------------------- */
  function Masonry(container) {
    let items = [];
    let ro = null;

    function columns(width) {
      for (const [min, n] of CFG.breakpoints) if (width >= min) return n;
      return 1;
    }

    function layout(animate) {
      if (!container) return;
      const width = container.clientWidth;
      if (!width) return;
      const cols = columns(width);
      const gutter = CFG.gutter;
      const colW = (width - gutter * (cols - 1)) / cols;
      const heights = new Array(cols).fill(0);

      const visible = items.filter(it => !it.hidden);
      items.filter(it => it.hidden).forEach(it => it.el.classList.add('xp-hidden'));

      visible.forEach(it => {
        it.el.classList.remove('xp-hidden');
        const aspect = it.aspect || 0.75;
        const h = colW / aspect;
        let c = 0;
        for (let i = 1; i < cols; i++) if (heights[i] < heights[c]) c = i;
        const x = c * (colW + gutter);
        const y = heights[c];
        if (!animate || reduceMotion()) it.el.style.transition = 'none';
        it.el.style.width = colW + 'px';
        it.el.style.height = h + 'px';
        it.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (!animate || reduceMotion()) requestAnimationFrame(() => { it.el.style.transition = ''; });
        heights[c] = y + h + gutter;
      });

      container.style.height = (Math.max.apply(null, heights.concat([0])) - gutter) + 'px';
    }

    function set(newItems) { items = newItems; layout(true); }
    function filter(predicate) {
      items.forEach(it => { it.hidden = !predicate(it); });
      layout(true);
    }
    function observe() {
      if (ro || !window.ResizeObserver) return;
      ro = new ResizeObserver(debounce(() => layout(false), 80));
      ro.observe(container);
    }

    observe();
    return { set, filter, layout, get items() { return items; } };
  }

  /* ---------------------------------------------------------
     8. Lightbox — keyboard nav, zoom, pan, focus trap
     --------------------------------------------------------- */
  const Lightbox = (() => {
    let el, imgEl, list = [], idx = 0, zoom = 1, panX = 0, panY = 0;
    let dragging = false, sx = 0, sy = 0, lastFocus = null, onOpenDetail = null;

    function build() {
      el = document.createElement('div');
      el.className = 'xp-lb';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Photograph viewer');
      el.innerHTML = `
        <div class="xp-lb-stage" data-stage>
          <img class="xp-lb-img" data-img alt=""/>
        </div>
        <div class="xp-lb-top">
          <span class="xp-lb-count" data-count></span>
          <div class="xp-lb-tools">
            <button class="xp-lb-btn" data-zoomout aria-label="Zoom out">&minus;</button>
            <button class="xp-lb-btn" data-zoomin aria-label="Zoom in">+</button>
            <button class="xp-lb-btn" data-film aria-label="Toggle thumbnails">&#9636;</button>
            <button class="xp-lb-btn wide" data-detail>Full detail</button>
            <button class="xp-lb-btn" data-close aria-label="Close viewer">&times;</button>
          </div>
        </div>
        <button class="xp-lb-btn xp-lb-nav prev" data-prev aria-label="Previous photograph">&#8249;</button>
        <button class="xp-lb-btn xp-lb-nav next" data-next aria-label="Next photograph">&#8250;</button>
        <div class="xp-lb-bottom">
          <div>
            <div class="xp-lb-title" data-title></div>
            <div class="xp-lb-sub" data-sub></div>
          </div>
          <div class="xp-lb-exif" data-exif></div>
        </div>
        <div class="xp-lb-film" data-filmstrip></div>`;
      document.body.appendChild(el);
      imgEl = $('[data-img]', el);

      $('[data-close]', el).onclick = close;
      $('[data-prev]', el).onclick = () => step(-1);
      $('[data-next]', el).onclick = () => step(1);
      $('[data-zoomin]', el).onclick = () => setZoom(zoom + 0.5);
      $('[data-zoomout]', el).onclick = () => setZoom(zoom - 0.5);
      $('[data-film]', el).onclick = () => $('[data-filmstrip]', el).classList.toggle('show');
      $('[data-detail]', el).onclick = () => {
        const p = list[idx]; close();
        if (onOpenDetail && p) onOpenDetail(p);
      };
      el.addEventListener('click', e => { if (e.target === el) close(); });

      const stage = $('[data-stage]', el);
      stage.addEventListener('wheel', e => {
        e.preventDefault();
        setZoom(zoom + (e.deltaY < 0 ? 0.25 : -0.25));
      }, { passive: false });
      imgEl.addEventListener('dblclick', () => setZoom(zoom > 1 ? 1 : 2.5));
      imgEl.addEventListener('pointerdown', e => {
        if (zoom <= 1) return;
        dragging = true; sx = e.clientX - panX; sy = e.clientY - panY;
        imgEl.setPointerCapture(e.pointerId);
      });
      imgEl.addEventListener('pointermove', e => {
        if (!dragging) return;
        panX = e.clientX - sx; panY = e.clientY - sy; applyTransform();
      });
      imgEl.addEventListener('pointerup', e => {
        dragging = false;
        try { imgEl.releasePointerCapture(e.pointerId); } catch (_) {}
      });

      document.addEventListener('keydown', onKey);
    }

    function onKey(e) {
      if (!el || !el.classList.contains('open')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom + 0.5); }
      else if (e.key === '-') { e.preventDefault(); setZoom(zoom - 0.5); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); }
      else if (e.key === 'Home') { e.preventDefault(); goto(0); }
      else if (e.key === 'End') { e.preventDefault(); goto(list.length - 1); }
      else if (e.key === 'Tab') {
        const f = $$('button', el);
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    function applyTransform() {
      imgEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      imgEl.classList.toggle('zoomed', zoom > 1);
    }
    function setZoom(z) {
      zoom = clamp(z, 1, 5);
      if (zoom === 1) { panX = 0; panY = 0; }
      applyTransform();
    }

    function render() {
      const p = list[idx];
      if (!p) return;
      const ai = p.ai || {};
      imgEl.classList.add('xp-swap');
      setTimeout(() => {
        imgEl.src = p.url;
        imgEl.alt = ai.altText || ai.caption || 'Photograph';
        imgEl.classList.remove('xp-swap');
      }, 120);
      setZoom(1);
      $('[data-count]', el).textContent =
        `N°${String(idx + 1).padStart(2, '0')} — ${String(list.length).padStart(2, '0')}`;
      $('[data-title]', el).textContent = ai.caption || p.ownerNote || 'Untitled frame';
      $('[data-sub]', el).textContent = [
        (ai.categories || []).join(' · '),
        ai.mood,
        p.createdAt ? new Date(p.createdAt).getFullYear() : ''
      ].filter(Boolean).join('  ·  ');

      const x = p.exif || {};
      const cells = [
        ['Camera', Exif.bodyLabel(x)], ['Lens', x.lens], ['Focal', x.focal],
        ['Aperture', x.aperture], ['Shutter', x.shutter], ['ISO', x.iso]
      ].filter(c => c[1]);
      $('[data-exif]', el).innerHTML = cells.length
        ? cells.map(c => `<span>${esc(c[0])}<b>${esc(c[1])}</b></span>`).join('')
        : '<span>Film frame<b>No digital metadata</b></span>';

      const strip = $('[data-filmstrip]', el);
      strip.innerHTML = list.map((q, i) =>
        `<button class="xp-thumb ${i === idx ? 'active' : ''}" data-goto="${i}"
          aria-label="View photograph ${i + 1}"><img src="${esc(q.lqip || q.url)}" alt=""/></button>`
      ).join('');
      $$('[data-goto]', strip).forEach(b =>
        b.onclick = () => goto(parseInt(b.dataset.goto, 10)));
      const active = $('.xp-thumb.active', strip);
      if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }

    function goto(i) { idx = (i + list.length) % list.length; render(); }
    function step(d) { goto(idx + d); }

    function open(photos, startIndex, detailHandler) {
      if (!el) build();
      list = photos; idx = startIndex || 0; onOpenDetail = detailHandler;
      lastFocus = document.activeElement;
      el.classList.add('open');
      document.body.style.overflow = 'hidden';
      render();
      setTimeout(() => $('[data-close]', el).focus(), 50);
    }
    function close() {
      if (!el) return;
      el.classList.remove('open');
      document.body.style.overflow = '';
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    return { open, close };
  })();

  /* ---------------------------------------------------------
     9. SEO — JSON-LD + meta kept in sync with the archive
     --------------------------------------------------------- */
  const Seo = (() => {
    function setMeta(name, content, prop) {
      if (!content) return;
      const key = prop ? 'property' : 'name';
      let tag = document.head.querySelector(`meta[${key}="${name}"]`);
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute(key, name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    }

    function sync(photos) {
      const count = photos.length;
      const keywords = Array.from(new Set(
        photos.flatMap(p => (p.ai && p.ai.seoKeywords) || []))).slice(0, 22);
      const desc = `Photography by Katnam Sathvik — an archive of ${count} frames of nature, ` +
        `monuments, wildlife and people, made on film in Visakhapatnam, India.`;

      setMeta('description', desc);
      if (keywords.length) setMeta('keywords', keywords.join(', '));
      setMeta('og:title', 'Katnam Sathvik — Photographer, Visakhapatnam', true);
      setMeta('og:description', desc, true);
      setMeta('og:type', 'website', true);
      setMeta('twitter:card', 'summary_large_image');
      if (photos[0]) setMeta('og:image', photos[0].url, true);

      const ld = {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Person',
            name: 'Katnam Sathvik',
            jobTitle: 'Photographer',
            email: 'mailto:sathviksatya758@gmail.com',
            address: {
              '@type': 'PostalAddress',
              addressLocality: 'Visakhapatnam',
              addressRegion: 'Andhra Pradesh',
              addressCountry: 'IN'
            },
            knowsAbout: ['Film photography', 'Wildlife photography',
              'Documentary photography', 'Landscape photography']
          },
          ...photos.slice(0, 30).map(p => ({
            '@type': 'ImageObject',
            name: (p.ai && p.ai.caption) || 'Untitled frame',
            description: (p.ai && p.ai.description) || undefined,
            caption: (p.ai && p.ai.altText) || undefined,
            keywords: ((p.ai && p.ai.tags) || []).join(', ') || undefined,
            dateCreated: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
            creator: { '@type': 'Person', name: 'Katnam Sathvik' },
            ...(p.exif && p.exif.hasData ? {
              exifData: [
                p.exif.aperture && { '@type': 'PropertyValue', name: 'Aperture', value: p.exif.aperture },
                p.exif.shutter && { '@type': 'PropertyValue', name: 'Shutter', value: p.exif.shutter },
                p.exif.iso && { '@type': 'PropertyValue', name: 'ISO', value: String(p.exif.iso) }
              ].filter(Boolean)
            } : {})
          }))
        ]
      };
      let script = document.getElementById('xp-jsonld');
      if (!script) {
        script = document.createElement('script');
        script.type = 'application/ld+json';
        script.id = 'xp-jsonld';
        document.head.appendChild(script);
      }
      script.textContent = JSON.stringify(ld);
    }

    return { sync };
  })();

  /* ---------------------------------------------------------
     10. Gallery — orchestrates everything
     --------------------------------------------------------- */
  const Gallery = (() => {
    let mount, masonry, photos = [], activeFilter = 'all', searchState = null;
    let getPhotos = () => [], persist = () => {}, detailMount = null;

    /* ---- View modes -------------------------------------------------
       Discovery is the default browsing experience; Masonry is the
       original layout, preserved byte-for-byte (same card(), same
       Masonry() engine, same FLIP animation) and simply no longer the
       only option. Grid is a new uniform layout. The choice persists
       per-visitor in localStorage.
       ---------------------------------------------------------------- */
    const VIEWS = ['discovery', 'masonry', 'grid'];
    const VIEW_KEY = 'xp_view';
    let view = (() => {
      try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.includes(v) ? v : 'discovery'; }
      catch (e) { return 'discovery'; }
    })();
    let discoveryFeed = null;

    function setView(next, { persistChoice = true } = {}) {
      if (!VIEWS.includes(next) || next === view) return;
      view = next;
      if (persistChoice) { try { localStorage.setItem(VIEW_KEY, next); } catch (e) {} }
      build();
    }

    /** A search or category filter is narrowing the archive right now. */
    function queryActive() {
      return !!searchState || activeFilter !== 'all';
    }

    function categoriesOf(p) {
      const ai = p.ai || {};
      return Array.from(new Set([...(ai.categories || []), ...(ai.collections || [])]))
        .filter(Boolean);
    }

    function allFacets() {
      const map = new Map();
      photos.forEach(p => categoriesOf(p).forEach(c => {
        const key = c.toLowerCase();
        map.set(key, (map.get(key) || 0) + 1);
      }));
      return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    }

    function card(p, i) {
      const ai = p.ai || {};
      const el = document.createElement('article');
      el.className = 'xp-masonry-item xp-enter';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `Open ${ai.caption || 'photograph'} ${i + 1} of ${photos.length}`);
      const swatches = (p.palette && p.palette.colors || []).slice(0, 4)
        .map(c => `<span class="xp-swatch" style="background:${esc(c.hex)}"></span>`).join('');
      el.innerHTML = `
        <div class="xp-frame">
          ${p.lqip ? `<img class="xp-lqip" src="${esc(p.lqip)}" alt="" aria-hidden="true"/>`
                   : '<div class="xp-skel"></div>'}
          <img class="xp-full" data-src="${esc(p.url)}"${
            p.urls && p.urls.jpeg
              ? ` data-srcset="${esc(p.urls.jpeg)}" sizes="(max-width:640px) 50vw, (max-width:1100px) 33vw, 25vw"`
              : ''}
               alt="${esc(ai.altText || ai.caption || 'Photograph')}" loading="lazy" decoding="async"/>
          <div class="xp-badge">${(ai.categories || []).slice(0, 2)
            .map(c => `<span class="xp-pill">${esc(c)}</span>`).join('')}</div>
          <div class="xp-swatches">${swatches}</div>
          <div class="xp-cap">
            <div class="xp-cap-t">${esc(ai.caption || p.ownerNote || 'Untitled frame')}</div>
            <div class="xp-cap-m">N°${String(i + 1).padStart(2, '0')}${
              ai.mood ? ' · ' + esc(ai.mood) : ''}${
              p.exif && p.exif.aperture ? ' · ' + esc(p.exif.aperture) : ''}</div>
          </div>
        </div>`;
      const open = () => Lightbox.open(visiblePhotos(), visiblePhotos().indexOf(p), showDetail);
      el.addEventListener('click', open);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      return el;
    }

    function visiblePhotos() {
      return masonry ? masonry.items.filter(it => !it.hidden).map(it => it.photo) : photos;
    }

    /* ---- Discovery ---------------------------------------------------
       Horizontal, AI-categorised rows built server-side from each
       photo's generated metadata (see server/src/modules/discovery).
       Rows scroll sideways while the page scrolls down.
       ------------------------------------------------------------------ */

    /** Backend card → the internal photo shape the rest of this file uses.
     *  Prefers the already-hydrated local object when we have it (it has
     *  the client-side palette/vector), falling back to a minimal object
     *  built from the card so rails still work for photos outside the
     *  first page of /api/photos. */
    function adaptCard(c) {
      const local = photos.find(p => p.id === c.id);
      if (local) return local;
      const srcset = (c.urls && c.urls.jpeg) || '';
      const entries = srcset.split(',').map(s => s.trim()).filter(Boolean);
      const largest = entries.length ? entries[entries.length - 1].split(' ')[0] : '';
      return {
        id: c.id, slug: c.slug,
        url: largest || (c.urls && c.urls.original) || '',
        lqip: c.lqip, aspect: c.aspect || 0.75,
        width: c.width, height: c.height,
        createdAt: c.createdAt,
        palette: { colors: c.colors || [] },
        ai: c.ai ? {
          caption: c.ai.title || c.ai.caption, altText: c.ai.altText,
          story: c.ai.story, mood: c.ai.mood, categories: c.ai.genre ? [c.ai.genre] : []
        } : null
      };
    }

    function railTile(c, rowPhotos, idx) {
      const el = document.createElement('article');
      el.className = 'xp-rail-item';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      const ai = c.ai || {};
      const label = ai.title || ai.caption || 'Untitled frame';
      el.setAttribute('aria-label', `Open ${label}`);
      const thumb = (() => {
        const set = (c.urls && c.urls.jpeg) || '';
        const first = set.split(',')[0];
        return first ? first.trim().split(' ')[0] : (c.urls && c.urls.original) || '';
      })();
      el.innerHTML = `
        <div class="xp-rail-frame">
          ${c.lqip ? `<img class="xp-rail-lqip" src="${esc(c.lqip)}" alt="" aria-hidden="true"/>` : ''}
          <img class="xp-rail-img" data-src="${esc(thumb)}"
               data-srcset="${esc((c.urls && c.urls.jpeg) || '')}"
               sizes="(max-width:640px) 60vw, 280px"
               alt="${esc(ai.altText || label)}" loading="lazy" decoding="async"/>
          <div class="xp-rail-cap"><span>${esc(label)}</span></div>
        </div>`;
      const open = () => {
        const list = rowPhotos.map(adaptCard);
        Lightbox.open(list, idx, showDetail);
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      io.observe($('.xp-rail-img', el));
      return el;
    }

    function renderRail(row) {
      const section = document.createElement('section');
      section.className = 'xp-rail';
      section.setAttribute('aria-labelledby', 'rail-' + row.slug);
      section.innerHTML = `
        <div class="xp-rail-head">
          <div>
            <h3 class="xp-rail-title" id="rail-${esc(row.slug)}">${esc(row.title)}</h3>
            ${row.subtitle ? `<p class="xp-rail-sub">${esc(row.subtitle)}</p>` : ''}
          </div>
          <div class="xp-rail-tools">
            <span class="xp-rail-count">${row.total != null ? row.total : (row.photos || []).length}</span>
            <button class="xp-rail-nav" data-dir="-1" aria-label="Scroll ${esc(row.title)} left">&#8249;</button>
            <button class="xp-rail-nav" data-dir="1" aria-label="Scroll ${esc(row.title)} right">&#8250;</button>
          </div>
        </div>
        <div class="xp-rail-track" role="list" tabindex="0"
             aria-label="${esc(row.title)}, horizontally scrollable"></div>`;

      const track = $('.xp-rail-track', section);
      row.photos.forEach((c, i) => {
        const tile = railTile(c, row.photos, i);
        tile.setAttribute('role', 'listitem');
        track.appendChild(tile);
      });

      $$('.xp-rail-nav', section).forEach(btn => {
        btn.onclick = () => {
          const dir = Number(btn.dataset.dir);
          track.scrollBy({ left: dir * Math.round(track.clientWidth * 0.85),
            behavior: reduceMotion() ? 'auto' : 'smooth' });
        };
      });
      // Arrow keys move the row when the track itself has focus, so the
      // rails are fully operable without a mouse or trackpad gesture.
      track.addEventListener('keydown', e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        track.scrollBy({ left: (e.key === 'ArrowRight' ? 1 : -1) * 300,
          behavior: reduceMotion() ? 'auto' : 'smooth' });
      });

      const sync = () => {
        const max = track.scrollWidth - track.clientWidth - 2;
        $$('.xp-rail-nav', section).forEach(b => {
          const dir = Number(b.dataset.dir);
          b.disabled = dir < 0 ? track.scrollLeft <= 2 : track.scrollLeft >= max;
        });
      };
      track.addEventListener('scroll', debounce(sync, 80), { passive: true });
      requestAnimationFrame(sync);
      return section;
    }

    async function buildDiscovery(container) {
      const note = document.createElement('div');
      note.className = 'xp-discovery-loading';
      note.innerHTML = '<span class="xp-status"><span class="xp-dotpulse"></span>Composing your archive…</span>';
      container.appendChild(note);

      try {
        if (!discoveryFeed) {
          const base = CFG.apiBase || 'http://localhost:4000/api';
          const res = await fetch(base + '/discovery', { credentials: 'include' });
          if (!res.ok) throw new Error('discovery unavailable');
          discoveryFeed = await res.json();
        }
      } catch (e) {
        // Backend unreachable — fall back to the local masonry layout so
        // the gallery is never blank, and say so rather than failing quietly.
        note.remove();
        const fb = document.createElement('p');
        fb.className = 'xp-empty';
        fb.textContent = 'Discovery needs the archive service — showing the masonry layout instead.';
        container.appendChild(fb);
        buildMasonry(container);
        return;
      }

      note.remove();
      const rows = (discoveryFeed && discoveryFeed.rows) || [];
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'xp-empty';
        empty.textContent = 'No photographs in the archive yet.';
        container.appendChild(empty);
        return;
      }
      const frag = document.createDocumentFragment();
      rows.forEach(r => frag.appendChild(renderRail(r)));
      container.appendChild(frag);
    }

    /* ---- Grid: uniform, denser alternative to masonry ---- */
    function buildGrid(container) {
      const grid = document.createElement('div');
      grid.className = 'xp-grid';
      grid.setAttribute('role', 'list');
      container.appendChild(grid);

      const list = photos.filter(p => {
        if (searchState) return searchState.ids.has(p.id);
        if (activeFilter !== 'all') return categoriesOf(p).some(c => c.toLowerCase() === activeFilter);
        return true;
      });

      if (!list.length) {
        const empty = document.createElement('p');
        empty.className = 'xp-empty';
        empty.textContent = 'No frames match that yet.';
        container.appendChild(empty);
        return;
      }

      list.forEach((p, i) => {
        const ai = p.ai || {};
        const el = document.createElement('article');
        el.className = 'xp-grid-item';
        el.tabIndex = 0;
        el.setAttribute('role', 'listitem');
        el.setAttribute('aria-label', `Open ${ai.caption || 'photograph'}`);
        el.innerHTML = `
          ${p.lqip ? `<img class="xp-grid-lqip" src="${esc(p.lqip)}" alt="" aria-hidden="true"/>` : ''}
          <img class="xp-grid-img" data-src="${esc(p.url)}"${
            p.urls && p.urls.jpeg
              ? ` data-srcset="${esc(p.urls.jpeg)}" sizes="(max-width:640px) 33vw, 220px"`
              : ''}
               alt="${esc(ai.altText || ai.caption || 'Photograph')}" loading="lazy" decoding="async"/>
          <div class="xp-grid-cap"><span>${esc(ai.caption || 'Untitled frame')}</span></div>`;
        const open = () => Lightbox.open(list, i, showDetail);
        el.addEventListener('click', open);
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        grid.appendChild(el);
        io.observe($('.xp-grid-img', el));
      });
    }

    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const img = en.target;
        if (img.dataset.src) {
          // srcset must be applied here too, not inline in the markup: a
          // browser resolves srcset the moment it parses it (src isn't
          // required), which would download every rail image up front and
          // defeat the deferral entirely.
          if (img.dataset.srcset) {
            img.srcset = img.dataset.srcset;
            img.removeAttribute('data-srcset');
          }
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
          img.addEventListener('load', () => {
            img.classList.add('xp-loaded');
            // Masonry uses .xp-lqip; the discovery rails and grid use
            // .xp-rail-lqip / .xp-grid-lqip. Match any of them so every
            // layout gets the same blur-up cross-fade.
            const lq = img.previousElementSibling;
            if (lq && /(^|\s|-)lqip/.test(lq.className)) lq.style.opacity = '0';
          }, { once: true });
        }
        io.unobserve(img);
      });
    }, { rootMargin: '300px 0px' });

    const VIEW_ICONS = {
      discovery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="12" height="6" rx="1.5"/></svg>',
      masonry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="7" height="10" rx="1.2"/><rect x="14" y="3" width="7" height="6" rx="1.2"/><rect x="3" y="17" width="7" height="4" rx="1.2"/><rect x="14" y="13" width="7" height="8" rx="1.2"/></svg>',
      grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="1.2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.2"/></svg>'
    };
    const VIEW_LABELS = { discovery: 'Discovery', masonry: 'Masonry', grid: 'Grid' };

    function toolbar() {
      const bar = document.createElement('div');
      bar.className = 'xp-toolbar';
      bar.innerHTML = `
        <div class="xp-filters" role="group" aria-label="Filter photographs by category"></div>
        <div class="xp-searchwrap">
          <svg class="xp-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/>
               <line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
          <input class="xp-search" type="search" data-search
                 placeholder="Try: sunset over water, quiet portraits…"
                 aria-label="Search photographs in natural language"/>
          <button class="xp-search-ai" data-aisearch>Ask AI</button>
        </div>
        <div class="xp-viewswitch" role="group" aria-label="Gallery layout">
          ${VIEWS.map(v => `
            <button class="xp-view-btn" data-view="${v}" type="button"
                    aria-pressed="${v === view}" title="${VIEW_LABELS[v]} view"
                    aria-label="${VIEW_LABELS[v]} view">
              ${VIEW_ICONS[v]}<span>${VIEW_LABELS[v]}</span>
            </button>`).join('')}
        </div>
        <div class="xp-searchnote" data-note hidden></div>`;
      $$('[data-view]', bar).forEach(b => {
        b.onclick = () => setView(b.dataset.view);
      });
      return bar;
    }

    function renderFilters(bar) {
      const wrap = $('.xp-filters', bar);
      const facets = allFacets();
      wrap.innerHTML = [['all', photos.length]].concat(facets).map(([name, n]) =>
        `<button class="xp-filter-chip" data-filter="${esc(name)}"
           aria-pressed="${activeFilter === name}">${esc(name)}
           <span class="xp-chip-n">${n}</span></button>`).join('');
      $$('[data-filter]', wrap).forEach(b => {
        b.onclick = () => {
          activeFilter = b.dataset.filter;
          searchState = null;
          $('[data-search]', bar).value = '';
          $('[data-note]', bar).hidden = true;
          $$('[data-filter]', wrap).forEach(o =>
            o.setAttribute('aria-pressed', String(o.dataset.filter === activeFilter)));
          applyFilter();
        };
      });
    }

    function applyFilter() {
      // Masonry filters in place, keeping its FLIP animation. The other
      // two layouts have no live filter engine, so they re-render — and
      // because `view` itself is never changed by a query, rebuilding is
      // all that's needed to swap Discovery↔grid and back again.
      if (!masonry) { build(); return; }
      masonry.filter(it => {
        const p = it.photo;
        if (searchState) return searchState.ids.has(p.id);
        if (activeFilter === 'all') return true;
        return categoriesOf(p).some(c => c.toLowerCase() === activeFilter);
      });
      const shown = masonry.items.filter(i => !i.hidden).length;
      const empty = $('[data-empty]', mount);
      if (empty) empty.hidden = shown > 0;
    }

    function localSearch(query, bar) {
      const note = $('[data-note]', bar);
      if (!query.trim()) {
        searchState = null; note.hidden = true; applyFilter(); return;
      }
      const qv = Vec.build(query, query);
      const scored = photos.map(p => ({ p, s: Vec.cosine(qv, p.vector || Vec.photoVector(p)) }))
        .filter(r => r.s > 0.05).sort((a, b) => b.s - a.s);
      searchState = { ids: new Set(scored.map(r => r.p.id)), query };
      note.hidden = false;
      note.textContent = scored.length
        ? `${scored.length} frame${scored.length > 1 ? 's' : ''} match "${query}" · press Ask AI for a deeper read`
        : `No local match for "${query}" · try Ask AI`;
      applyFilter();
    }

    async function aiSearch(bar) {
      const input = $('[data-search]', bar);
      const btn = $('[data-aisearch]', bar);
      const note = $('[data-note]', bar);
      const q = input.value.trim();
      if (!q) return;
      btn.disabled = true;
      note.hidden = false;
      note.innerHTML = '<span class="xp-status"><span class="xp-dotpulse"></span>Reading the archive…</span>';
      try {
        const matches = await AI.semanticSearch(q, photos);
        searchState = { ids: new Set(matches.map(m => m.photo.id)), query: q };
        note.textContent = matches.length
          ? `AI found ${matches.length} frame${matches.length > 1 ? 's' : ''} — ${matches[0].why || 'best match first'}`
          : `Nothing in the archive matches "${q}" yet.`;
        applyFilter();
      } catch (e) {
        note.textContent = 'AI search unavailable right now — showing local matches.';
        localSearch(q, bar);
      } finally { btn.disabled = false; }
    }

    /* The original masonry layout, unchanged — same card(), same Masonry()
       engine, same staggered FLIP entrance. Only extracted into its own
       function so the view switcher can call it. */
    function buildMasonry(container) {
      const grid = document.createElement('div');
      grid.className = 'xp-masonry';
      grid.setAttribute('role', 'list');
      container.appendChild(grid);

      const empty = document.createElement('p');
      empty.className = 'xp-empty';
      empty.dataset.empty = '';
      empty.textContent = 'No frames match that yet.';
      empty.hidden = true;
      container.appendChild(empty);

      masonry = Masonry(grid);
      const items = photos.map((p, i) => {
        const el = card(p, i);
        el.setAttribute('role', 'listitem');
        grid.appendChild(el);
        io.observe($('.xp-full', el));
        return { el, photo: p, aspect: p.aspect || 0.75, hidden: false };
      });
      masonry.set(items);
      requestAnimationFrame(() => items.forEach((it, i) =>
        setTimeout(() => it.el.classList.remove('xp-enter'), Math.min(i * 45, 600))));

      // Re-apply any filter/search that was active before the rebuild.
      if (queryActive()) applyFilter();
    }

    function build() {
      mount.innerHTML = '';
      const bar = toolbar();
      mount.appendChild(bar);
      renderFilters(bar);

      const stage = document.createElement('div');
      stage.className = 'xp-stage';
      stage.dataset.view = view;
      mount.appendChild(stage);

      // mount.innerHTML above just detached whatever the previous layout
      // built, so any existing masonry engine now points at dead DOM.
      // Cleared unconditionally here; buildMasonry reassigns it when it
      // actually builds one. (Missing this let a stale engine survive a
      // Masonry→Discovery switch and silently swallow later filtering.)
      masonry = null;

      // Discovery is a curated browse of the whole archive, so it can't
      // express "only photos matching X" — while a query is active we
      // show the results in the grid instead, and return to the rails
      // automatically once the query is cleared.
      if (view === 'discovery') {
        if (queryActive()) buildGrid(stage);
        else buildDiscovery(stage);
      } else if (view === 'grid') {
        buildGrid(stage);
      } else {
        buildMasonry(stage);
      }

      const onType = debounce(() => localSearch($('[data-search]', bar).value, bar), 220);
      $('[data-search]', bar).addEventListener('input', onType);
      $('[data-search]', bar).addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); aiSearch(bar); }
      });
      $('[data-aisearch]', bar).onclick = () => aiSearch(bar);
    }

    /* ---- Detail view ---- */

    /** Fetches and renders the "keep exploring" rails under a photograph.
     *  Reuses the exact same rail renderer as the Discovery feed, so the
     *  two surfaces stay visually and behaviourally identical. */
    async function loadRecommendationRails(p, container) {
      if (!container || !p || !p.id) return;
      try {
        const base = CFG.apiBase || 'http://localhost:4000/api';
        const res = await fetch(`${base}/recommendations/${encodeURIComponent(p.id)}`,
          { credentials: 'include' });
        if (!res.ok) return;
        const { rails } = await res.json();
        if (!rails || !rails.length) return;
        const frag = document.createDocumentFragment();
        rails.forEach(r => frag.appendChild(renderRail(r)));
        container.appendChild(frag);
      } catch (e) {
        /* offline / API down — the local related grid above still stands */
      }
    }

    function similar(p, n) {
      const base = p.vector || Vec.photoVector(p);
      return photos.filter(q => q.id !== p.id)
        .map(q => ({ q, s: Vec.cosine(base, q.vector || Vec.photoVector(q)) }))
        .sort((a, b) => b.s - a.s).slice(0, n || 6)
        .filter(r => r.s > 0.03);
    }

    function showDetail(p) {
      if (!detailMount) return;
      const ai = p.ai || {}, x = p.exif || {}, pal = p.palette || {};
      const rel = similar(p, 6);
      const exifCells = [
        ['Camera', Exif.bodyLabel(x)], ['Lens', x.lens], ['Focal length', x.focal],
        ['Aperture', x.aperture], ['Shutter', x.shutter], ['ISO', x.iso],
        ['Exposure bias', x.exposureBias], ['Flash', x.flash],
        ['White balance', x.whiteBalance], ['Captured', x.taken],
        ['Dimensions', x.width && x.height ? `${x.width} × ${x.height}` : null],
        ['Location', x.gps ? `${x.gps.lat}, ${x.gps.lon}` : (ai.locationGuess || null)]
      ].filter(c => c[1]);

      detailMount.innerHTML = `
        <div class="wrap xp-detail">
          <button class="xp-filter-chip" data-back style="margin-bottom:2rem">&larr; Back to the archive</button>
          <div class="xp-detail-hero">
            <img src="${esc(p.url)}" alt="${esc(ai.altText || ai.caption || 'Photograph')}"/>
          </div>
          <div class="xp-detail-grid">
            <div>
              <div class="xp-kicker">${esc((ai.categories || ['frame']).join(' · '))}${
                p.createdAt ? ' · ' + new Date(p.createdAt).getFullYear() : ''}</div>
              <h1>${esc(ai.caption || 'Untitled')}<em>.</em></h1>
              ${ai.story ? `<p class="xp-story">${esc(ai.story)}</p>` : ''}
              ${ai.description ? `<p class="xp-desc">${esc(ai.description)}</p>` : ''}
              ${p.ownerNote ? `<div class="xp-panel" style="margin-top:2rem">
                <div class="xp-panel-h"><span>Photographer's note</span></div>
                <p class="xp-story" style="font-size:1.05rem">"${esc(p.ownerNote)}"</p></div>` : ''}
              ${(ai.tags || []).length ? `<div class="xp-tagrow">${
                ai.tags.map(t => `<span class="xp-tag">${esc(t)}</span>`).join('')}</div>` : ''}
              ${(ai.hashtags || []).length ? `<div class="xp-tagrow">${
                ai.hashtags.slice(0, 8).map(t => `<span class="xp-tag hash">#${esc(t)}</span>`).join('')}</div>` : ''}
            </div>
            <aside>
              <div class="xp-panel xp-ai-ask">
                <div class="xp-panel-h"><span>Ask AI</span><span>Description</span></div>
                <p class="xp-analysis-v" data-ai-hint>Generate a comprehensive description of this photograph from its real data.</p>
                <button class="xp-ai-btn" data-ask-ai>Generate description</button>
                <p class="xp-ai-out" data-ai-out></p>
              </div>
              ${exifCells.length ? `<div class="xp-panel">
                <div class="xp-panel-h"><span>Camera data</span><span>EXIF</span></div>
                <div class="xp-exif-grid">${exifCells.map(c =>
                  `<div><div class="xp-exif-k">${esc(c[0])}</div>
                        <div class="xp-exif-v">${esc(c[1])}</div></div>`).join('')}</div>
              </div>` : `<div class="xp-panel"><div class="xp-panel-h"><span>Camera data</span></div>
                <p class="xp-analysis-v">No embedded EXIF — likely a scanned film frame.</p></div>`}

              ${(pal.colors || []).length ? `<div class="xp-panel">
                <div class="xp-panel-h"><span>Palette</span><span>${esc(pal.temperature || '')}</span></div>
                <div class="xp-palette">${pal.colors.map(c =>
                  `<div class="xp-pal-chip"><div class="xp-pal-sw" style="background:${esc(c.hex)}"></div>
                   <div class="xp-pal-hex">${esc(c.hex)}<br/>${c.share}%</div></div>`).join('')}</div>
              </div>` : ''}

              <div class="xp-panel">
                <div class="xp-panel-h"><span>AI analysis</span><span>Vision</span></div>
                ${[['Composition', ai.composition], ['Lighting', ai.lighting],
                   ['Colour', ai.colorAnalysis], ['Mood', ai.mood],
                   ['Editing style', ai.editingStyle], ['Technical', ai.technicalNote]]
                  .filter(r => r[1]).map(r => `<div class="xp-analysis-row">
                    <div class="xp-analysis-k">${esc(r[0])}</div>
                    <div class="xp-analysis-v">${esc(r[1])}</div></div>`).join('') ||
                  '<p class="xp-analysis-v">Analysis pending.</p>'}
              </div>
            </aside>
          </div>

          ${rel.length ? `<section class="xp-related">
            <div class="xp-kicker">Visually related</div>
            <div class="xp-related-grid">${rel.map(r =>
              `<div class="xp-related-card" data-rel="${esc(r.q.id)}" tabindex="0" role="button"
                    aria-label="Open ${esc((r.q.ai && r.q.ai.caption) || 'related photograph')}">
                <img src="${esc(r.q.lqip || r.q.url)}" data-full="${esc(r.q.url)}"
                     alt="${esc((r.q.ai && r.q.ai.altText) || 'Related photograph')}" loading="lazy"/>
                <span class="xp-related-score">${Math.round(r.s * 100)}% match</span>
              </div>`).join('')}</div>
          </section>` : ''}

          <div class="xp-recs" data-recs></div>
        </div>`;

      $$('[data-full]', detailMount).forEach(im => { im.src = im.dataset.full; });
      const back = $('[data-back]', detailMount);
      if (back) back.onclick = () => root.Exhibition.showGallery();

      // "Ask AI" — on demand, generate a comprehensive description of this
      // photograph from its real data. GET (idempotent, cached server-side),
      // so no CSRF token is needed; works for any visitor.
      const askBtn = $('[data-ask-ai]', detailMount);
      if (askBtn) {
        askBtn.onclick = async () => {
          const out = $('[data-ai-out]', detailMount);
          const hint = $('[data-ai-hint]', detailMount);
          askBtn.disabled = true;
          const label = askBtn.textContent;
          askBtn.textContent = 'Generating…';
          if (out) out.textContent = '';
          try {
            const base = CFG.apiBase || 'http://localhost:4000/api';
            const res = await fetch(`${base}/photos/${encodeURIComponent(p.id)}/describe`, { credentials: 'include' });
            if (!res.ok) throw new Error('describe failed');
            const data = await res.json();
            if (hint) hint.style.display = 'none';
            if (out) out.textContent = data.description || 'No description available.';
            askBtn.textContent = 'Regenerate';
          } catch (e) {
            if (out) out.textContent = 'Could not generate a description right now — the server may be offline.';
            askBtn.textContent = label;
          } finally {
            askBtn.disabled = false;
          }
        };
      }
      $$('[data-rel]', detailMount).forEach(c => {
        const go = () => {
          const q = photos.find(z => z.id === c.dataset.rel);
          if (q) { showDetail(q); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        };
        c.onclick = go;
        c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      });

      // Server-side multi-signal rails (semantic + colour + EXIF + mood +
      // GPS). Loaded after the page paints so the photograph itself is
      // never waiting on them; silently skipped if the API is unreachable,
      // leaving the local "Visually related" grid above as the fallback.
      loadRecommendationRails(p, $('[data-recs]', detailMount));

      if (typeof root.go === 'function') root.go('photo');
      else {
        $$('.page').forEach(el => { el.style.display = 'none'; });
        detailMount.style.display = 'block';
      }
      window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
    }

    async function hydrate(p) {
      if (!p.lqip) {
        const l = await Lqip.make(p.url);
        if (l) { p.lqip = l.uri; p.aspect = l.aspect; p.width = l.width; p.height = l.height; }
      }
      if (!p.palette) p.palette = await Palette.extract(p.url);
      if (!p.vector) p.vector = Vec.photoVector(p);
      return p;
    }

    async function refresh() {
      // The feed is memoised per page-load; drop it here so an upload or
      // delete is reflected in the Discovery rails without a hard reload.
      discoveryFeed = null;
      photos = (getPhotos() || []).slice();
      await Promise.all(photos.map(hydrate));
      photos.forEach(p => { p.vector = Vec.photoVector(p); });
      RAG.rebuild(photos);
      Seo.sync(photos);
      if (mount) build();
      return photos;
    }

    function init(opts) {
      getPhotos = opts.getPhotos || getPhotos;
      persist = opts.persist || persist;
      mount = typeof opts.mount === 'string' ? $(opts.mount) : opts.mount;
      detailMount = typeof opts.detailMount === 'string' ? $(opts.detailMount) : opts.detailMount;
      if (!mount) {
        mount = document.createElement('section');
        mount.id = 'xp-gallery';
        const anchor = $('#index-list') || $('.index .wrap') || $('main') || document.body;
        anchor.appendChild(mount);
      }
      if (!detailMount) {
        detailMount = document.createElement('div');
        detailMount.id = 'page-photo';
        detailMount.className = 'page';
        detailMount.style.display = 'none';
        ($('main') || document.body).appendChild(detailMount);
      }
      return refresh();
    }

    return {
      init, refresh, showDetail, similar,
      setView, get view() { return view; }, get views() { return VIEWS.slice(); },
      get photos() { return photos; },
      showGallery() {
        detailMount.style.display = 'none';
        if (typeof root.go === 'function') root.go('home');
        else { const h = $('#page-home'); if (h) h.style.display = 'block'; }
      }
    };
  })();

  /* ---------------------------------------------------------
     11. Upload pipeline — EXIF + palette + LQIP + AI in order
     --------------------------------------------------------- */
  async function ingest(file, opts) {
    const o = opts || {};
    const progress = o.onProgress || (() => {});
    progress('reading', 0.05);

    const exif = await Exif.fromFile(file).catch(() => null);
    progress('exif', 0.2);

    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    progress('encoded', 0.35);

    const lq = await Lqip.make(dataUrl);
    progress('placeholder', 0.5);

    const palette = await Palette.extract(dataUrl);
    progress('palette', 0.65);

    const photo = {
      id: 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      url: dataUrl,
      mediaType: file.type,
      fileName: file.name,
      fileSize: file.size,
      createdAt: Date.now(),
      exif, palette,
      lqip: lq && lq.uri,
      aspect: lq && lq.aspect,
      width: lq && lq.width,
      height: lq && lq.height,
      ownerNote: '',
      ai: null,
      analyzing: true
    };

    if (o.onPhoto) o.onPhoto(photo);

    try {
      photo.ai = await AI.enrich(dataUrl, file.type, exif, palette);
      progress('analysed', 0.95);
    } catch (e) {
      photo.ai = { caption: 'Untitled frame', description: '', altText: 'Photograph',
        tags: [], categories: [], error: e.message };
    }
    photo.analyzing = false;
    photo.vector = Vec.photoVector(photo);
    progress('done', 1);
    return photo;
  }

  /* ---------------------------------------------------------
     12. Public surface
     --------------------------------------------------------- */
  const Exhibition = {
    config: CFG,
    Exif, Palette, Lqip, Vec, AI, RAG, Lightbox, Seo, Gallery,
    ingest,
    init(opts) { return Gallery.init(opts || {}); },
    refresh() { return Gallery.refresh(); },
    showDetail(p) { return Gallery.showDetail(p); },
    showGallery() { return Gallery.showGallery(); },
    ask(question, history) { return RAG.answer(question, history); },
    similar(p, n) { return Gallery.similar(p, n); },
    setView(v) { return Gallery.setView(v); },
    get view() { return Gallery.view; }
  };

  root.Exhibition = Exhibition;
  if (typeof module !== 'undefined' && module.exports) module.exports = Exhibition;
})(typeof window !== 'undefined' ? window : this);
