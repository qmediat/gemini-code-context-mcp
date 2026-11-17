/**
 * `ask` tool — Q&A / long-context analysis against a workspace.
 *
 * Sends the scanned workspace with the question. Implicit caching by default
 * (inline content, Gemini's automatic prefix cache); `cachingMode: 'explicit'`
 * uploads the workspace once and builds a persistent Context Cache (measured
 * 2026-04-22 on a 670 k-token workspace: first call ~125 s, repeats ~14 s).
 */

import { resolve } from 'node:path';
import { answerAsk } from './ask/answer.js';
import { attachAsk } from './ask/attachments.js';
import type { StepOutcome } from './ask/call.js';
import { guardAsk } from './ask/guard.js';
import { type AskInput, askInputSchema } from './ask/input.js';
import { failedResult } from './ask/results.js';
import { resolveAsk, scanAsk } from './ask/setup.js';
import { sizeAsk } from './ask/sizing.js';
import type { TextToolResult, ToolContext, ToolDefinition } from './registry.js';
import {
  type ModelReached,
  closeEagerCall,
  openEagerCall,
  settleFailedEager,
} from './shared/eager-call.js';
import { workspaceRefusal } from './shared/eager-steps.js';

export { askInputSchema, type AskInput };

export const askTool: ToolDefinition<AskInput> = {
  name: 'ask',
  title: 'Ask Gemini',
  description:
    'Primary tool for codebase Q&A on workspaces that fit the model input-token limit (~1M tokens for Gemini Pro — covers most repos). Eager: the scanned workspace goes with the question (implicit caching by default; `cachingMode: "explicit"` builds a persistent Context Cache — measured ~8× faster and ~4× cheaper on repeat queries than sending the codebase inline). Falls back to `ask_agentic` automatically when the workspace exceeds the limit (set `onWorkspaceTooLarge: "fallback-to-agentic"`). For repos that genuinely exceed 1M tokens or when only a handful of files matter, call `ask_agentic` directly.',
  schema: askInputSchema,

  async execute(input, ctx) {
    const started = Date.now();
    const workspaceRoot = resolve(input.workspace ?? process.cwd());
    const model = input.model ?? ctx.config.defaultModel;
    return executeAskBody(input, ctx, workspaceRoot, model, started);
  },
};

/**
 * One `ask` call: opened before its first await, its steps run in order — each goes on with the next stage or ends the
 * call — and closed on every path. Every throw of a step reaches the one failure path; the `ask_agentic` fallback's
 * promise is returned unawaited, so a rejection of it reaches the caller as it came.
 */
async function executeAskBody(
  input: AskInput,
  ctx: ToolContext,
  workspaceRoot: string,
  model: string,
  started: number,
): Promise<TextToolResult> {
  const eager = openEagerCall<ModelReached>(
    {
      tool: 'ask',
      knobs: input,
      requestedTier: input.serviceTier ?? ctx.config.serviceTier,
      workspaceRoot,
      started,
    },
    ctx,
  );
  try {
    const refusal = workspaceRefusal('ask', workspaceRoot);
    if (refusal !== null) return refusal;
    const resolved = await resolveAsk({ input, ctx, model, eager });
    if (!('next' in resolved)) return endOf(resolved);
    const attached = await attachAsk(resolved.next);
    if (!('next' in attached)) return endOf(attached);
    const scanned = await scanAsk(attached.next);
    if (!('next' in scanned)) return endOf(scanned);
    const counted = await guardAsk(scanned.next);
    if (!('next' in counted)) return endOf(counted);
    const sized = sizeAsk(counted.next);
    if (!('next' in sized)) return endOf(sized);
    return await answerAsk(sized.next);
  } catch (err) {
    return failedResult(settleFailedEager(eager, ctx, err));
  } finally {
    closeEagerCall(eager);
  }
}

/**
 * What ends the call before its answer: a refusal, or the `ask_agentic` fallback still pending — returned unawaited
 * from inside the call's `try`, so the `finally` runs while the fallback runs and a rejection of the fallback never
 * reaches the call's failure path.
 */
function endOf(
  outcome: Exclude<StepOutcome<unknown>, { readonly next: unknown }>,
): TextToolResult | Promise<TextToolResult> {
  return 'end' in outcome ? outcome.end : outcome.handOff;
}
