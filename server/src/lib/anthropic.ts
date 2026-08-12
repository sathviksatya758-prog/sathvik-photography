import Anthropic from '@anthropic-ai/sdk';
import { env, caps } from '../config/env';

// A placeholder key keeps construction from throwing when no key is set; the
// client is never actually called in that case (callers check `caps.anthropic`
// or `hasAnthropic` first and fall back to non-AI behaviour).
export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? 'not-configured' });
export const MODEL = env.ANTHROPIC_MODEL;
export const hasAnthropic = caps.anthropic;

export function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

export function parseJsonReply<T = unknown>(text: string): T {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON object found in model reply');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}
