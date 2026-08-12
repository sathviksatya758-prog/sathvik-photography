import { env } from '../config/env';

const EMBED_DIMS = 1536;

export async function embed(input: string | string[]): Promise<number[][]> {
  const texts = Array.isArray(input) ? input : [input];
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: env.EMBED_MODEL, input: texts, dimensions: EMBED_DIMS })
  });
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map(d => d.embedding);
}

// pgvector's text input format for a vector literal: '[0.1,0.2,...]'
export const toVectorLiteral = (v: number[]): string => `[${v.join(',')}]`;
