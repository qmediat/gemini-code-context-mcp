/**
 * `ask`'s request on a prepared context: with a cached context, or with the files inline on a context without one.
 * The decode calls it for every request, the stale-cache retry on the rebuilt context too.
 */

import type { Content, GenerateContentConfig } from '@google/genai';
import type { PreparedContext } from '../../cache/cache-manager.js';
import type { ContextRequest } from '../shared/context-decode.js';
import { serviceTierConfig } from '../shared/service-tier.js';
import type { AskSized } from './call.js';
import { SYSTEM_INSTRUCTION_Q_AND_A } from './instruction.js';
import { thinkingConfigOf } from './thinking.js';

/**
 * The request builder of one call. Gemini rejects `generateContent({cachedContent, systemInstruction})` with 400
 * ("CachedContent can not be used with GenerateContent request setting system_instruction, tools or tool_config"):
 * the system instruction is baked into the cache when it is built (`cache-manager.ts`, `cacheConfig.systemInstruction`),
 * so a request on a cached context omits it. `maxOutputTokens` goes on the wire only when the cap has a wire value (the
 * caller's `maxOutputTokens`, the operator's force-max, or a cap the input window cut); otherwise Gemini applies the
 * model's own default. The user turn carries the attachments first and the question last, with a cache too.
 */
export function askRequest(call: AskSized): (prep: PreparedContext) => ContextRequest {
  const { input, attachments } = call;
  const cap = call.bounded.cap;
  const thinkingConfig = thinkingConfigOf(call.thinking);
  const tierField = serviceTierConfig(call.serviceTier);
  const config = (cacheId: string | null): GenerateContentConfig => {
    const maxOutputField = cap.wire !== undefined ? { maxOutputTokens: cap.wire } : {};
    return cacheId
      ? { cachedContent: cacheId, thinkingConfig, ...maxOutputField, ...tierField }
      : {
          systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
          thinkingConfig,
          ...maxOutputField,
          ...tierField,
        };
  };
  const userTurn: Content = { role: 'user', parts: [...attachments.parts, { text: input.prompt }] };
  const contents = (prep: PreparedContext): string | Content[] => {
    if (prep.cacheId) return attachments.parts.length === 0 ? input.prompt : [userTurn];
    return [...prep.inlineContents, userTurn];
  };
  return (prep) => ({ contents: contents(prep), config: config(prep.cacheId) });
}
