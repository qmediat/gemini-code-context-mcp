/** `ask`'s sizing: the cap that runs, the thinking under it, and the daily-budget reservation of the worst case. */

import { capThatRuns } from '../../gemini/long-decode.js';
import { reserveCallBudget } from '../shared/eager-steps.js';
import { thinkingReserve } from '../shared/thinking.js';
import type { AskCounted, AskSized, StepOutcome } from './call.js';
import { budgetRejectResult } from './results.js';
import { askThinking, thinkingBudgetField } from './thinking.js';

/**
 * Size the call: the output cap bounded by the model's input window (a cut is said on the progress channel and the
 * log), the thinking normalised under it, then the reservation — the thinking it counts from the cap that runs. Over
 * the daily budget the call ends with nothing reserved; reserved, the call's trail holds the id.
 */
export function sizeAsk(call: AskCounted): StepOutcome<AskSized> {
  const { input, eager } = call;
  const bounded = capThatRuns({
    tool: 'ask',
    cap: call.outputCap,
    promptTokens: call.count?.preflight.effectiveTokens,
    inputTokenLimit: call.resolved.inputTokenLimit,
    emit: (message) => eager.emitter.emit(message),
  });
  const thinking = askThinking(input, bounded.cap);
  const sized: AskSized = { ...call, bounded, thinking };
  const reservation = reserveCallBudget(eager, call.ctx, sized, {
    promptChars: input.prompt.length,
    extraInputTokens: call.attachments.tokens,
    thinkingTokens: thinkingReserve(
      input.thinkingLevel,
      thinkingBudgetField(thinking),
      bounded.cap,
    ),
  });
  if (reservation.kind === 'rejected') {
    return { end: budgetRejectResult(sized, reservation.message) };
  }
  return { next: sized };
}
