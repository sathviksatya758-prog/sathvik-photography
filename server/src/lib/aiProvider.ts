// Single seam the rest of the app calls through for any AI vision/chat work,
// so a photo-caption/describe/critique/chat call doesn't care which provider
// is actually configured. Gemini is preferred when both GEMINI_API_KEY and
// ANTHROPIC_API_KEY are set; Anthropic remains a fallback so nothing breaks
// for anyone who already had that configured before Gemini support existed.
import { caps } from '../config/env';
import { anthropic, MODEL as ANTHROPIC_MODEL, extractText as extractAnthropicText } from './anthropic';
import { getGemini, GEMINI_MODEL } from './gemini';

export const hasVisionAi = caps.gemini || caps.anthropic;
export const activeVisionProvider: 'gemini' | 'anthropic' | 'none' = caps.gemini
  ? 'gemini'
  : caps.anthropic
    ? 'anthropic'
    : 'none';

export interface VisionReplyInput {
  imageBase64: string;
  mimeType: string;
  systemPrompt: string;
  userText: string;
  maxTokens: number;
}

// One image + one text prompt in, plain text reply out. Callers that need
// structured data (photo enrichment, critique) parse JSON out of the text
// themselves via parseJsonReply — kept provider-agnostic here since both
// Gemini and Claude are simply asked to "reply with one JSON object".
export async function visionReply(input: VisionReplyInput): Promise<string> {
  if (caps.gemini) {
    const client = await getGemini();
    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      config: { systemInstruction: input.systemPrompt, maxOutputTokens: input.maxTokens },
      contents: [
        {
          role: 'user',
          parts: [{ text: input.userText }, { inlineData: { mimeType: input.mimeType, data: input.imageBase64 } }]
        }
      ]
    });
    return (response.text ?? '').trim();
  }

  const msg = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: input.maxTokens,
    system: input.systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: input.mimeType as 'image/jpeg', data: input.imageBase64 } },
          { type: 'text', text: input.userText }
        ]
      }
    ]
  });
  return extractAnthropicText(msg.content);
}

export interface ChatReplyInput {
  systemPrompt: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  userText: string;
  maxTokens: number;
}

// Text-only turn (the RAG chat assistant) — no image involved, just
// conversation history plus the retrieved-context-augmented question.
export async function chatReply(input: ChatReplyInput): Promise<string> {
  if (caps.gemini) {
    // Gemini's roles are 'user'/'model', not 'user'/'assistant'.
    const client = await getGemini();
    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      config: { systemInstruction: input.systemPrompt, maxOutputTokens: input.maxTokens },
      contents: [
        ...input.history.map(h => ({
          role: h.role === 'assistant' ? ('model' as const) : ('user' as const),
          parts: [{ text: h.content }]
        })),
        { role: 'user' as const, parts: [{ text: input.userText }] }
      ]
    });
    return (response.text ?? '').trim();
  }

  const msg = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: input.maxTokens,
    system: input.systemPrompt,
    messages: [...input.history, { role: 'user' as const, content: input.userText }]
  });
  return extractAnthropicText(msg.content);
}
