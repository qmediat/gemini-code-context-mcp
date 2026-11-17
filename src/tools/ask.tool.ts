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
import { workspaceRefusal } from './shared/workspace-refusal.js';

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
 * call — and closed on every path. Every throw of a step reaches the one failure path. The `ask_agentic` fallback's
 * promise is returned unawaited from inside the `try`: the `finally` runs while the fallback runs, and a rejection of
 * the fallback reaches the caller as it came, never the call's failure path.
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
    if ('end' in resolved) return resolved.end;
    const attached = await attachAsk(resolved.next);
    if ('end' in attached) return attached.end;
    const scanned = await scanAsk(attached.next);
    if ('end' in scanned) return scanned.end;
    const counted = await guardAsk(scanned.next);
    if ('handOff' in counted) return counted.handOff;
    if ('end' in counted) return counted.end;
    const sized = sizeAsk(counted.next);
    if ('end' in sized) return sized.end;
    return await answerAsk(sized.next);
  } catch (err) {
    return failedResult(settleFailedEager(eager, ctx, err));
  } finally {
    closeEagerCall(eager);
  }
}
