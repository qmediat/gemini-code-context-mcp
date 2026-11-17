/**
 * Content-aware no-progress detection for the `ask_agentic` loop: a call signature repeated
 * `NO_PROGRESS_CALL_THRESHOLD` times with no new file read between the repeats ends the loop.
 */

import type { ToolCall } from './dispatch.js';

/** If the SAME call signature (name + args) appears this many times, we
 * conclude the model is stuck in a loop and surface a partial answer.
 *
 * Bumped 3 → 5 in v1.14.4 after empirical replay (2026-04-30) showed
 * Gemini 3 Pro under `thinkingLevel: HIGH` legitimately re-emits the same
 * `grep` / `read_file` 3× as "double-checks" within its thought process —
 * not a stuck loop. Threshold-3 was tuned for 2.5 Pro and tripped before
 * `maxIterations`, killing the rescue path. Threshold-5 covers the empirical
 * double-check pattern with margin; `maxIterations` (default 20) and
 * `maxTotalInputTokens` (default 1M) remain the upper-bound safety nets. */
export const NO_PROGRESS_CALL_THRESHOLD = 5;

/** Call-signature → state, for content-aware no-progress detection.
 *
 * v1.16.0 (P2 Phase B): replaces the v1.14.4 simple counter with a
 * content-aware version. Pre-Phase-B `signatureCounts: Map<string,
 * number>` tracked repeat occurrences of the same signature and
 * tripped after N repeats even if the model had made progress
 * elsewhere since an earlier occurrence. That was empirically wrong
 * on 2026-04-30 — Gemini 3 Pro under HIGH thinking re-runs the same
 * `grep` while ALSO reading new files, which IS progress, but the
 * simple counter still tripped.
 *
 * Phase B tracks `lastFilesReadSize` per signature: same signature
 * counts toward the threshold ONLY if no `read_file` against an
 * unseen path happened between repeats. If `filesReadSet` grew
 * since the previous identical signature, count resets to 1
 * (current call) — the model is exploring, not stuck.
 *
 * Why `read_file` specifically and not all tool calls? `list_directory`
 * / `find_files` / `grep` are exploration without commitment. They
 * tell us where to look but don't capture content into the
 * conversation. `read_file` is the progress signal — it means
 * "I found something worth examining" and grows the conversation
 * the rescue path will replay.
 *
 * Threshold (NO_PROGRESS_CALL_THRESHOLD = 5) unchanged from v1.14.4
 * — Phase B refines the SIGNAL, not the cap. Hard upper bound
 * remains `maxIterations` × `maxTotalInputTokens`. */
export type SignatureCounts = Map<string, { count: number; lastFilesReadSize: number }>;

/** The signature that tripped the detector and how many times it was repeated. */
export interface NoProgress {
  signature: string;
  count: number;
}

/**
 * No-progress detection (v1.16.0 P2 Phase B — content-aware): bails when any
 * single call signature has been issued `NO_PROGRESS_CALL_THRESHOLD` times
 * without any new `filesReadSet` growth between repeats. If `filesReadSet`
 * grew, the model is exploring (productive) — reset that signature's count
 * to 1.
 *
 * `filesReadSizeAtIterEnd` is captured ONCE per iter (after tool execution)
 * so all signatures within the same iter see the same "size at end of this
 * iter" snapshot. Without the snapshot, a single iter that issues
 * `read_file` AND `grep` AND `read_file` would have a different
 * `filesReadSet.size` per signature depending on tool-execution order —
 * non-deterministic + wrong (the snapshot represents iter-level progress,
 * not within-iter).
 *
 * AA1 fix (v1.16.0 PR-Round-1, 3-of-3 cross-corroborated TP HIGH): ALSO
 * dedupe signatures WITHIN an iter before counting. The counter
 * conceptually measures iters-spent-stuck, not raw emission count. If the
 * model glitches and emits the same `grep` 5× in one parallel batch, that's
 * pathological output for ONE iter — should count as +1 toward the
 * threshold, not +5. Pre-AA1 the counter compounded 1→2→3→4→5 in a single
 * iter, instantly tripping AGENTIC_NO_PROGRESS even though zero stuck-iters
 * had elapsed.
 *
 * Tool-surface assumption (AA2 ACCEPTED-DEFERRED): `read_file` is the sole
 * progress oracle because ask_agentic's tool surface is exclusively
 * read-only (`read_file`, `grep`, `list_directory`, `find_files` — no
 * write_file, no terminal exec). When a future PR adds workspace-mutating
 * tools, this oracle MUST be expanded to track any state-changing tool call
 * (e.g., a combined "workspace state version" counter) — otherwise a model
 * iterating on edits + command execution would false-positive
 * AGENTIC_NO_PROGRESS.
 *
 * Returns the first signature that reaches the threshold (the signatures
 * after it in this iteration are not counted), or `null`.
 */
export function detectNoProgress(
  signatures: ToolCall[],
  signatureCounts: SignatureCounts,
  filesReadSizeAtIterEnd: number,
): NoProgress | null {
  const uniqueSigsThisIter = new Set<string>();
  for (const { name, args } of signatures) {
    uniqueSigsThisIter.add(`${name}(${stableJson(args)})`);
  }
  for (const sig of uniqueSigsThisIter) {
    const prev = signatureCounts.get(sig);
    // Reset count when files grew between identical signatures —
    // model is making progress, not stuck. Otherwise increment.
    const count =
      prev && filesReadSizeAtIterEnd > prev.lastFilesReadSize ? 1 : (prev?.count ?? 0) + 1;
    signatureCounts.set(sig, { count, lastFilesReadSize: filesReadSizeAtIterEnd });
    if (count >= NO_PROGRESS_CALL_THRESHOLD) return { signature: sig, count };
  }
  return null;
}

/** Maximum recursion depth for `stableJson`. Function-call args in
 * practice are flat `{path, startLine, endLine}` objects, so 10 levels
 * is generous. Guards against stack overflow if a prompt-injected cache
 * managed to smuggle a nested structure into the model's tool-call args. */
const STABLE_JSON_MAX_DEPTH = 10;

/** Stable-key JSON for comparing function-call signatures across
 * iterations. Sorted keys so `{a:1,b:2}` and `{b:2,a:1}` hash identical.
 *
 * Hardening (PR #24 review by Grok): depth-limited + protected against
 * circular references. The outer `JSON.stringify` would throw on a cycle,
 * which we catch; but we also walk with our own depth counter because a
 * deeply nested (non-cyclic) args tree can still blow the stack on the
 * default V8 async-aware trampoline. On overflow or stringify error we
 * fall back to a truncated `String(value)` so the no-progress detector
 * still has SOME key rather than crashing the loop. */
function stableJson(value: unknown, depth = 0): string {
  if (depth > STABLE_JSON_MAX_DEPTH) return '"[depth-truncated]"';
  if (value === null || typeof value !== 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return `"[unstringifiable:${typeof value}]"`;
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v, depth + 1)).join(',')}]`;
  }
  try {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k], depth + 1)}`,
      )
      .join(',')}}`;
  } catch {
    return `"[unstringifiable-object]"`;
  }
}
