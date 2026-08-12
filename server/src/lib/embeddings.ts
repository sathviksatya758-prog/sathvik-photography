import { createHash } from 'node:crypto';
import { env, caps } from '../config/env';

const EMBED_DIMS = 1536;

// Deterministic, non-AI fallback used when OPENAI_API_KEY isn't configured.
// It hashes the text into a stable unit vector so that (a) pgvector's cosine
// distance is well-defined (never a zero/NaN vector), and (b) identical text
// maps to identical vectors — enough for the pipeline and duplicate check to
// function. It is NOT semantically meaningful: "sunset" and "dusk" won't be
// close. Real semantic search switches on the moment a key is added.
function pseudoEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIMS);
  let norm = 0;
  // Expand a SHA-256 stream to fill all dimensions with stable pseudo-random
  // values derived from the input.
  for (let i = 0; i < EMBED_DIMS; i += 8) {
    const h = createHash('sha256').update(`${text}#${i}`).digest();
    for (let j = 0; j < 8 && i + j < EMBED_DIMS; j++) {
      // Map a byte to [-1, 1].
      const v = (h[j] / 127.5) - 1;
      vec[i + j] = v;
      norm += v * v;
    }
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIMS; i++) vec[i] /= norm;
  return vec;
}

export async function embed(input: string | string[]): Promise<number[][]> {
  const texts = Array.isArray(input) ? input : [input];

  if (!caps.openai) {
    return texts.map(pseudoEmbed);
  }

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY as string}`
    },
    body: JSON.stringify({ model: env.EMBED_MODEL, input: texts, dimensions: EMBED_DIMS })
  });
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map(d => d.embedding);
}

// pgvector's text input format for a vector literal: '[0.1,0.2,...]'
export const toVectorLiteral = (v: number[]): string => `[${v.join(',')}]`;
