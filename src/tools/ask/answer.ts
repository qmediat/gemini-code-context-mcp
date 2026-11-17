/** `ask`'s answer: the context, the decode, the settlement and the result, once the call is sized and reserved. */

import type { TextToolResult } from '../registry.js';
import {
  decodeEagerCall,
  prepareCallContext,
  settleDecoded,
  warnTruncatedScan,
} from '../shared/eager-answer.js';
import type { AskSized } from './call.js';
import { SYSTEM_INSTRUCTION_Q_AND_A } from './instruction.js';
import { askRequest } from './request.js';
import { answerResult, outputCapResult } from './results.js';
import { generatingLine } from './thinking.js';

/**
 * Prepare the context (a cache only with files and without `noCache`), decode the answer on it, and book it once.
 * The stop at the output cap is returned before the truncated-scan warning; the answer after it.
 */
export async function answerAsk(call: AskSized): Promise<TextToolResult> {
  const { input, ctx, eager, scan } = call;
  const context = await prepareCallContext(eager, ctx, {
    scan,
    resolved: call.resolved,
    systemInstruction: SYSTEM_INSTRUCTION_Q_AND_A,
    allowCaching: !input.noCache && scan.files.length > 0,
    requestedMode: input.cachingMode ?? ctx.config.cachingMode,
  });
  eager.emitter.emit(generatingLine(call.thinking));
  const decoded = await decodeEagerCall(eager, ctx, call, askRequest(call), context);
  const settled = settleDecoded(eager, ctx, decoded, call, context.caching);
  if (settled.settled.outputCapStop !== null) return outputCapResult(settled.settled.outputCapStop);
  warnTruncatedScan(eager, ctx, scan);
  return answerResult(call, decoded, settled);
}
