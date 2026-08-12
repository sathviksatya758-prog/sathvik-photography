/* ============================================================
   taxonomy.ts — declarative auto-collection definitions
   ------------------------------------------------------------
   These drive BOTH the Discovery view's horizontal rows and the
   "Dynamic AI Collections" feature: a photo joins a collection
   purely by matching its AI-generated metadata, so collections
   update themselves as soon as a new upload finishes processing.
   Nothing here is manually curated per-photo.

   Matching is deliberately data-driven rather than hardcoded per
   photo: each definition lists substrings checked (case-insensitively)
   against a photo's aggregated searchable text — its tags,
   categories, AI subjects, genre, scene classification, mood,
   time-of-day and weather estimates.

   To add a new collection, append a definition here. No schema
   change, no migration, no code change anywhere else.
   ============================================================ */

export interface CollectionDef {
  slug: string;
  title: string;
  /** Short editorial line shown under the row title in Discovery view. */
  subtitle?: string;
  /** Substrings matched against a photo's aggregated tags/categories/subjects. */
  terms?: string[];
  /** Matched against photo_ai.genre and photo_ai.scene_classification. */
  genres?: string[];
  /** Matched against photo_ai.mood. */
  moods?: string[];
  /** Matched against photo_ai.time_of_day_estimate. */
  timeOfDay?: string[];
  /** Matched against photo_ai.weather_estimate. */
  weather?: string[];
  /** Row is hidden entirely below this many photos (avoids lonely rows). */
  minPhotos?: number;
  /** Lower sorts earlier in the Discovery feed. */
  order?: number;
}

// Ordered roughly by how a visitor would want to encounter them:
// signature subjects first, then places, then treatments/moods.
export const COLLECTIONS: CollectionDef[] = [
  {
    slug: 'wildlife',
    title: 'Wildlife Adventures',
    subtitle: 'Creatures met on their own terms',
    terms: ['wildlife', 'animal', 'mammal', 'predator', 'tiger', 'leopard', 'deer', 'elephant', 'monkey', 'safari'],
    genres: ['wildlife'],
    order: 10
  },
  {
    slug: 'birds',
    title: 'Birds',
    subtitle: 'Feathers, flight and patience',
    terms: ['bird', 'avian', 'heron', 'egret', 'eagle', 'owl', 'kingfisher', 'peacock', 'parrot', 'crane', 'flamingo'],
    order: 20
  },
  {
    slug: 'nature',
    title: 'Nature Escapes',
    subtitle: 'The world without us in it',
    terms: ['nature', 'natural', 'wilderness', 'outdoor', 'flora', 'fauna'],
    genres: ['nature'],
    order: 30
  },
  {
    slug: 'landscapes',
    title: 'Landscapes',
    subtitle: 'Long looks at wide places',
    terms: ['landscape', 'vista', 'panorama', 'horizon', 'valley', 'field', 'countryside'],
    genres: ['landscape'],
    order: 40
  },
  {
    slug: 'mountains',
    title: 'Mountains',
    subtitle: 'Altitude and weather',
    terms: ['mountain', 'peak', 'summit', 'ridge', 'hill', 'alpine', 'cliff', 'himalaya'],
    order: 50
  },
  {
    slug: 'forests',
    title: 'Forest Stories',
    subtitle: 'Green light, close air',
    terms: ['forest', 'woods', 'woodland', 'jungle', 'tree', 'canopy', 'grove', 'bamboo'],
    order: 60
  },
  {
    slug: 'beaches',
    title: 'Ocean Blues',
    subtitle: 'Where the land gives up',
    terms: ['beach', 'ocean', 'sea', 'coast', 'shore', 'wave', 'sand', 'tide', 'harbour', 'harbor', 'lagoon'],
    order: 70
  },
  {
    slug: 'water',
    title: 'Water & Reflections',
    subtitle: 'Mirrors that move',
    terms: ['water', 'river', 'lake', 'reflection', 'waterfall', 'stream', 'pond', 'rain-soaked'],
    order: 80
  },
  {
    slug: 'flowers',
    title: 'Flowers & Botanicals',
    subtitle: 'Short-lived, closely watched',
    terms: ['flower', 'floral', 'blossom', 'petal', 'bloom', 'orchid', 'lotus', 'rose', 'botanical'],
    order: 90
  },
  {
    slug: 'architecture',
    title: 'Architecture',
    subtitle: 'Lines people decided on',
    terms: ['architecture', 'building', 'facade', 'temple', 'monument', 'church', 'mosque', 'tower', 'bridge', 'ruins', 'heritage'],
    genres: ['architecture'],
    order: 100
  },
  {
    slug: 'street',
    title: 'Street Photography',
    subtitle: 'Unrehearsed, unrepeatable',
    terms: ['street', 'candid', 'urban life', 'market', 'bazaar', 'pedestrian', 'alley'],
    genres: ['street'],
    order: 110
  },
  {
    slug: 'portraits',
    title: 'Portrait Collection',
    subtitle: 'Five minutes of real conversation',
    terms: ['portrait', 'person', 'people', 'face', 'human', 'child', 'elder', 'worker'],
    genres: ['portrait'],
    order: 120
  },
  {
    slug: 'urban-nights',
    title: 'Urban Nights',
    subtitle: 'The city with its lights on',
    terms: ['night', 'nightscape', 'neon', 'city light', 'streetlight', 'dusk city', 'skyline'],
    timeOfDay: ['night', 'midnight', 'evening'],
    order: 130
  },
  {
    slug: 'golden-hour',
    title: 'Golden Hour',
    subtitle: 'The hour everything forgives',
    terms: ['golden hour', 'sunset', 'sunrise', 'dawn', 'dusk', 'backlit', 'warm light'],
    timeOfDay: ['golden hour', 'sunset', 'sunrise', 'dawn', 'dusk'],
    order: 140
  },
  {
    slug: 'rainy-days',
    title: 'Rainy Days',
    subtitle: 'Weather as a collaborator',
    terms: ['rain', 'rainy', 'monsoon', 'storm', 'wet', 'puddle', 'umbrella', 'fog', 'mist', 'overcast'],
    weather: ['rain', 'rainy', 'storm', 'overcast', 'fog', 'mist', 'cloudy'],
    order: 150
  },
  {
    slug: 'travel',
    title: 'Travel Diaries',
    subtitle: 'Places that took a journey',
    terms: ['travel', 'journey', 'destination', 'tourism', 'wander', 'road trip', 'expedition'],
    genres: ['travel'],
    order: 160
  },
  {
    slug: 'food',
    title: 'Food',
    subtitle: 'Made, served, photographed',
    terms: ['food', 'meal', 'dish', 'cuisine', 'kitchen', 'cooking', 'street food', 'coffee', 'tea'],
    genres: ['food'],
    order: 170
  },
  {
    slug: 'macro',
    title: 'Macro',
    subtitle: 'Closer than the eye goes',
    terms: ['macro', 'close-up', 'closeup', 'detail', 'texture', 'insect', 'dew'],
    genres: ['macro'],
    order: 180
  },
  {
    slug: 'monochrome',
    title: 'Black & White',
    subtitle: 'Form without the distraction of colour',
    terms: ['black and white', 'black & white', 'monochrome', 'greyscale', 'grayscale', 'b&w'],
    moods: ['monochrome'],
    order: 190
  },
  {
    slug: 'minimalism',
    title: 'Minimalism',
    subtitle: 'Mostly empty, deliberately',
    terms: ['minimal', 'minimalism', 'simple', 'negative space', 'sparse', 'clean lines'],
    moods: ['minimal', 'quiet', 'serene'],
    order: 200
  },
  {
    slug: 'cinematic',
    title: 'Cinematic',
    subtitle: 'Frames that look like stills from something longer',
    terms: ['cinematic', 'dramatic', 'moody', 'film still'],
    moods: ['cinematic', 'dramatic', 'moody'],
    order: 210
  },
  {
    slug: 'vehicles',
    title: 'Machines & Motion',
    subtitle: 'Things built to move',
    terms: ['vehicle', 'car', 'train', 'boat', 'bicycle', 'motorcycle', 'bus', 'ship', 'aircraft', 'rickshaw'],
    order: 220
  }
];

export const COLLECTION_BY_SLUG = new Map(COLLECTIONS.map(c => [c.slug, c]));

/** Every substring a photo's text is tested against for a given definition. */
export function matchersFor(def: CollectionDef): string[] {
  return [...(def.terms ?? []), ...(def.genres ?? []), ...(def.moods ?? []), ...(def.timeOfDay ?? []), ...(def.weather ?? [])].map(s =>
    s.toLowerCase()
  );
}
