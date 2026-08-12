import sharp from 'sharp';
import exifr from 'exifr';

/* ------------------------------------------------------------
   EXIF — real APP1/TIFF parse over the uploaded bytes
   Ported from legacy/lib.ts::readExif
   ------------------------------------------------------------ */
export interface ExifData {
  make: string | null;
  model: string | null;
  lens: string | null;
  focal_mm: number | null;
  focal_35mm: number | null;
  aperture: number | null;
  shutter_sec: number | null;
  iso: number | null;
  exposure_bias: number | null;
  flash: string | null;
  white_balance: string | null;
  software: string | null;
  taken_at: Date | null;
  gps_lat: number | null;
  gps_lon: number | null;
  raw: unknown;
}

export async function readExif(buffer: Buffer): Promise<ExifData | null> {
  // exifr's TS types don't cleanly union boolean + FormatOptions across
  // these keys together; the options object itself is correct per
  // exifr's docs, so this is a narrow, deliberate cast.
  const x = await exifr
    .parse(buffer, {
      tiff: true,
      exif: true,
      gps: true,
      ifd0: true,
      pick: [
        'Make', 'Model', 'LensModel', 'FocalLength', 'FocalLengthIn35mmFormat',
        'FNumber', 'ExposureTime', 'ISO', 'ExposureCompensation', 'Flash',
        'WhiteBalance', 'Software', 'DateTimeOriginal', 'latitude', 'longitude'
      ]
    } as unknown as Parameters<typeof exifr.parse>[1])
    .catch(() => null);
  if (!x) return null;
  return {
    make: x.Make ?? null,
    model: x.Model ?? null,
    lens: x.LensModel ?? null,
    focal_mm: x.FocalLength ?? null,
    focal_35mm: x.FocalLengthIn35mmFormat ?? null,
    aperture: x.FNumber ?? null,
    shutter_sec: x.ExposureTime ?? null,
    iso: x.ISO ?? null,
    exposure_bias: x.ExposureCompensation ?? null,
    flash: typeof x.Flash === 'string' ? x.Flash : x.Flash ? 'Fired' : null,
    white_balance: x.WhiteBalance != null ? String(x.WhiteBalance) : null,
    software: x.Software ?? null,
    taken_at: x.DateTimeOriginal ?? null,
    gps_lat: x.latitude ?? null,
    gps_lon: x.longitude ?? null,
    raw: x
  };
}

/* ------------------------------------------------------------
   Renditions — AVIF + WebP + JPEG fallback at 5 breakpoints
   Ported from legacy/lib.ts::buildRenditions
   ------------------------------------------------------------ */
export const RENDITION_WIDTHS = [320, 640, 960, 1440, 2048] as const;

export interface Rendition {
  format: 'avif' | 'webp' | 'jpeg';
  width: number;
  height: number;
  bytes: number;
  buffer: Buffer;
}

export async function buildRenditions(original: Buffer): Promise<{
  renditions: Rendition[];
  lqip: string;
  width: number;
  height: number;
  aspect: number;
}> {
  const base = sharp(original, { failOn: 'none' }).rotate();
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const targets: number[] = RENDITION_WIDTHS.filter(w => w <= width);
  if (!targets.length) targets.push(width || 1024);

  const renditions: Rendition[] = [];
  for (const w of targets) {
    const resized = sharp(original).rotate().resize({ width: w, withoutEnlargement: true });
    const [avif, webp, jpeg] = await Promise.all([
      resized.clone().avif({ quality: 55, effort: 4 }).toBuffer({ resolveWithObject: true }),
      resized.clone().webp({ quality: 78 }).toBuffer({ resolveWithObject: true }),
      resized.clone().jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true })
    ]);
    renditions.push(
      { format: 'avif', width: avif.info.width, height: avif.info.height, bytes: avif.info.size, buffer: avif.data },
      { format: 'webp', width: webp.info.width, height: webp.info.height, bytes: webp.info.size, buffer: webp.data },
      { format: 'jpeg', width: jpeg.info.width, height: jpeg.info.height, bytes: jpeg.info.size, buffer: jpeg.data }
    );
  }

  const lqipBuf = await sharp(original).rotate().resize({ width: 24 }).blur(1.2).jpeg({ quality: 40 }).toBuffer();

  return {
    renditions,
    lqip: `data:image/jpeg;base64,${lqipBuf.toString('base64')}`,
    width,
    height,
    aspect: height ? width / height : 1
  };
}

/* ------------------------------------------------------------
   Palette — k-means quantization over a downsampled raw buffer
   Ported from legacy/routes.ts::quantize
   ------------------------------------------------------------ */
export interface PaletteColor {
  hex: string;
  r: number;
  g: number;
  b: number;
  share: number;
}

const rgbHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

function quantize(raw: Buffer, k: number): PaletteColor[] {
  const px: number[][] = [];
  for (let i = 0; i < raw.length; i += 3) px.push([raw[i], raw[i + 1], raw[i + 2]]);
  if (!px.length) return [];
  const cents = Array.from({ length: k }, (_, i) => px[Math.floor((i * px.length) / k)].slice());
  const assign = new Array(px.length).fill(0);
  for (let it = 0; it < 8; it++) {
    px.forEach((p, i) => {
      let best = 0;
      let bd = Infinity;
      cents.forEach((c, ci) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) {
          bd = d;
          best = ci;
        }
      });
      assign[i] = best;
    });
    const sums = cents.map(() => [0, 0, 0, 0]);
    px.forEach((p, i) => {
      const a = assign[i];
      sums[a][0] += p[0];
      sums[a][1] += p[1];
      sums[a][2] += p[2];
      sums[a][3]++;
    });
    sums.forEach((s, i) => {
      if (s[3]) cents[i] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    });
  }
  const counts = new Array(k).fill(0);
  assign.forEach(a => counts[a]++);
  return cents
    .map((c, i) => ({ hex: rgbHex(c[0], c[1], c[2]), r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), share: counts[i] / px.length }))
    .filter(c => c.share > 0.02)
    .sort((a, b) => b.share - a.share);
}

export async function extractPalette(buffer: Buffer, k = 5): Promise<PaletteColor[]> {
  const { data } = await sharp(buffer).resize(48, 48, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true });
  const palette = quantize(data, k);
  if (palette.length) return palette;

  const { dominant } = await sharp(buffer).stats();
  return [{ hex: rgbHex(dominant.r, dominant.g, dominant.b), r: dominant.r, g: dominant.g, b: dominant.b, share: 1 }];
}

// Downsized JPEG sent to Claude's vision API — full originals aren't
// needed for captioning and would waste tokens/bandwidth.
export async function buildAiPreview(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).rotate().resize({ width: 1024 }).jpeg({ quality: 80 }).toBuffer();
}

// Fast synchronous pass for the upload response: dimensions + blur
// placeholder only. The expensive multi-format/multi-width rendition
// build happens in the background worker (see jobs/worker.ts) so the
// client gets an instant paint without blocking on it.
export async function quickPreview(buffer: Buffer): Promise<{ width: number; height: number; aspect: number; lqip: string }> {
  const meta = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const lqipBuf = await sharp(buffer).rotate().resize({ width: 24 }).blur(1.2).jpeg({ quality: 40 }).toBuffer();
  return { width, height, aspect: height ? width / height : 1, lqip: `data:image/jpeg;base64,${lqipBuf.toString('base64')}` };
}
