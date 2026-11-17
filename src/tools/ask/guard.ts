/**
 * `ask`'s workspace guard: the input counted against the model's window and, over it, the refusal or — when the caller
 * asked for it — the `ask_agentic` fallback, handed back still pending.
 */

import { fallBackToAgentic } from '../ask-agentic-fallback.js';
import { type TextToolResult, errorResult } from '../registry.js';
import { type OverWindow, countPreflight, overWindow } from '../shared/eager-steps.js';
import { attachmentMetadata } from './attachments.js';
import type { AskCounted, AskScanned, StepOutcome } from './call.js';

/**
 * Count the call's input and hold it against the model's window. A workspace the window cannot hold is refused
 * (`WORKSPACE_TOO_LARGE`, not retryable): sent, Gemini would answer 400 "exceeds maximum", which a caller cannot tell
 * from a transient error. With `onWorkspaceTooLarge: 'fallback-to-agentic'` — opt-in, the default stays `'error'`,
 * since the fallback's cost and timing differ — the question goes to `ask_agentic` with this call's model, globs,
 * thinking and workspace, its `timeoutMs` as `iterationTimeoutMs` (a per-iteration cap: the total can be N × that) and
 * its `stallMs` (`ask-agentic-fallback.ts`). The fallback's promise is handed back unawaited: `fallBackToAgentic` has
 * run up to its first await (it disposed this call's controller and started the agentic call), and the entry returns
 * the promise from inside its `try`.
 */
export async function guardAsk(call: AskScanned): Promise<StepOutcome<AskCounted>> {
  const { input, ctx, eager } = call;
  const count = await countPreflight(eager, ctx, {
    scan: call.scan,
    prompt: input.prompt,
    resolved: call.resolved,
    mode: input.preflightMode,
    cap: call.outputCap,
    extraTokens: call.attachments.tokens,
  });
  const over = overWindow(count, ctx);
  if (over === null) return { next: { ...call, count } };
  if (input.onWorkspaceTooLarge !== 'fallback-to-agentic')
    return { end: tooLargeResult(call, over) };
  if (call.attachments.attached.length > 0) return { end: attachmentsCannotFollow(call) };
  return {
    handOff: fallBackToAgentic({
      input,
      ctx,
      emitter: eager.emitter,
      serviceTier: call.serviceTier,
      preflight: over.counted,
      threshold: over.threshold,
      timeout: eager.timeout,
    }),
  };
}

/** The fallback sends no inline parts: a call with attachments cannot take it. */
function attachmentsCannotFollow(call: AskScanned): TextToolResult {
  return errorResult(
    'ask: the workspace is too large for the eager path and `attachments` cannot follow the ask_agentic fallback (it sends no inline parts); drop the attachments or narrow the workspace',
    {
      errorCode: 'WORKSPACE_TOO_LARGE',
      retryable: false,
      serviceTier: call.serviceTier,
      ...attachmentMetadata(call.attachments),
    },
  );
}

/** The refusal of a workspace over the window, with the ways out. */
function tooLargeResult(call: AskScanned, over: OverWindow): TextToolResult {
  const { counted, threshold, contextWindow } = over;
  const attachmentsNote =
    call.attachments.attached.length > 0
      ? ' — it carries no attachments: drop them, or narrow the workspace and ask again'
      : '';
  return errorResult(
    `Workspace too large: ~${counted.effectiveTokens.toLocaleString()} input tokens (${counted.method} count) exceeds ${threshold.toLocaleString()} (${over.pctDisplay}% of ${call.resolved.resolved}'s ${contextWindow.toLocaleString()} context window). Best option: use \`mcp__gemini-code-context__ask_agentic\` — same model, but it reads only the files it needs via sandboxed tool calls (no eager repo upload)${attachmentsNote}. Or set \`onWorkspaceTooLarge: 'fallback-to-agentic'\` on \`ask\` to have the server route automatically. Other options: (a) pass \`excludeGlobs\` to filter large/generated files — supports \`*.ext\` patterns, filenames, and directory paths, (b) narrow with \`includeGlobs\`, (c) switch to a larger-context model, or (d) split the workspace into subdirectories.`,
    {
      errorCode: 'WORKSPACE_TOO_LARGE',
      serviceTier: call.serviceTier,
      ...attachmentMetadata(call.attachments),
      retryable: false,
      estimatedInputTokens: counted.effectiveTokens,
      tokenCountMethod: counted.method,
      rawTokenCount: counted.rawTokens,
      tokenCountCacheHit: counted.cacheHit,
      contextWindowTokens: contextWindow,
      thresholdTokens: threshold,
      guardRatio: call.ctx.config.workspaceGuardRatio,
      resolvedModel: call.resolved.resolved,
      filesIndexed: call.scan.files.length,
    },
  );
}
