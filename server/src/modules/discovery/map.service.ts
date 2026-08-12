/* ============================================================
   map.service.ts — GPS-driven photo map
   ------------------------------------------------------------
   Clusters photos by their EXIF GPS coordinates so the frontend
   can render a browsable world map without shipping every point
   to the client. Clustering is done server-side on a simple grid
   whose cell size scales with zoom, which keeps the payload flat
   even with thousands of geotagged frames.
   ============================================================ */

import { prisma } from '../../lib/prisma';
import { cached } from '../../lib/redis';
import { publicUrl } from '../../lib/storage';

const MAP_TTL_SECONDS = 600;

export interface MapCluster {
  lat: number;
  lon: number;
  count: number;
  /** Populated only for single-photo clusters, so markers can show a thumb. */
  photo: { id: string; slug: string; lqip: string | null; caption: string | null; thumb: string } | null;
  photoIds: string[];
  place: string | null;
}

/**
 * Grid cell size in degrees for a given zoom level. Lower zoom = coarser
 * cells = country-level grouping; higher zoom = city/street clustering.
 */
function cellSize(zoom: number): number {
  const z = Math.max(1, Math.min(12, Math.round(zoom)));
  return 180 / Math.pow(2, z);
}

export async function getMapClusters(zoom = 3, fromYear?: number, toYear?: number) {
  const key = `discovery:map:v1:${Math.round(zoom)}:${fromYear ?? ''}:${toYear ?? ''}`;
  return cached(key, MAP_TTL_SECONDS, async () => {
    const rows = await prisma.photoExif.findMany({
      where: {
        gpsLat: { not: null },
        gpsLon: { not: null },
        photo: { deletedAt: null, status: 'READY' }
      },
      select: {
        photoId: true,
        gpsLat: true,
        gpsLon: true,
        placeName: true,
        takenAt: true,
        photo: {
          select: {
            slug: true,
            lqip: true,
            storageKey: true,
            createdAt: true,
            ai: { select: { caption: true, title: true } }
          }
        }
      }
    });

    const size = cellSize(zoom);
    const buckets = new Map<string, MapCluster>();
    let earliest: number | null = null;
    let latest: number | null = null;

    for (const r of rows) {
      const when = r.takenAt ?? r.photo.createdAt;
      const year = when.getUTCFullYear();
      if (earliest === null || year < earliest) earliest = year;
      if (latest === null || year > latest) latest = year;
      if (fromYear != null && year < fromYear) continue;
      if (toYear != null && year > toYear) continue;

      const lat = r.gpsLat!;
      const lon = r.gpsLon!;
      const key = `${Math.floor(lat / size)}:${Math.floor(lon / size)}`;
      const existing = buckets.get(key);

      if (existing) {
        // Running mean keeps the marker centred on its members.
        existing.lat = (existing.lat * existing.count + lat) / (existing.count + 1);
        existing.lon = (existing.lon * existing.count + lon) / (existing.count + 1);
        existing.count++;
        existing.photoIds.push(r.photoId);
        existing.photo = null; // no longer a single-photo marker
        if (!existing.place && r.placeName) existing.place = r.placeName;
      } else {
        buckets.set(key, {
          lat,
          lon,
          count: 1,
          photoIds: [r.photoId],
          place: r.placeName ?? null,
          photo: {
            id: r.photoId,
            slug: r.photo.slug,
            lqip: r.photo.lqip,
            caption: r.photo.ai?.title ?? r.photo.ai?.caption ?? null,
            thumb: publicUrl(`renditions/${r.photo.slug}/640.jpeg`)
          }
        });
      }
    }

    return {
      zoom,
      clusters: [...buckets.values()].sort((a, b) => b.count - a.count),
      totalGeotagged: rows.length,
      yearRange: earliest !== null && latest !== null ? { from: earliest, to: latest } : null
    };
  });
}

/** Photos inside one cluster, for the marker's detail panel. */
export async function getPhotosAt(photoIds: string[]) {
  const photos = await prisma.photo.findMany({
    where: { id: { in: photoIds.slice(0, 60) }, deletedAt: null, status: 'READY' },
    select: {
      id: true,
      slug: true,
      lqip: true,
      aspect: true,
      ai: { select: { title: true, caption: true, altText: true } },
      exif: { select: { placeName: true, takenAt: true } }
    }
  });
  return photos.map(p => ({
    ...p,
    thumb: publicUrl(`renditions/${p.slug}/640.jpeg`)
  }));
}
