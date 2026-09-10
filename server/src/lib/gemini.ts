import { env, caps } from '../config/env';

export const GEMINI_MODEL = env.GEMINI_MODEL;
export const hasGemini = caps.gemini;

// @google/genai ships ESM-only ("type": "module") while this server is
// CommonJS — even a type-only import of its exported types trips
// TypeScript's Node16 module resolution here (TS1479/TS1541/TS1542), since
// it still counts as an import *declaration* of an ESM module from a CJS
// file. Rather than fight that, this declares the minimal shape this file
// actually calls (Anthropic's own client is fully typed via its SDK import,
// which works fine there since that package is CJS) and loads the real
// client via a genuine dynamic `import()` at call time — precisely how CJS
// is meant to consume ESM. Created once, cached; a placeholder key when
// unset keeps construction from throwing (callers check `hasGemini` first).
interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiGenerateContentParams {
  model: string;
  config?: {
    systemInstruction?: string;
    maxOutputTokens?: number;
  };
  contents: GeminiContent[];
}
export interface GeminiClient {
  models: {
    generateContent(params: GeminiGenerateContentParams): Promise<{ text?: string }>;
  };
}

let clientPromise: Promise<GeminiClient> | null = null;
export function getGemini(): Promise<GeminiClient> {
  if (!clientPromise) {
    clientPromise = import('@google/genai').then(
      ({ GoogleGenAI }) => new GoogleGenAI({ apiKey: env.GEMINI_API_KEY ?? 'not-configured' }) as unknown as GeminiClient
    );
  }
  return clientPromise;
}
