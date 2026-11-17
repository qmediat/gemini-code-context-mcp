/** `ask`'s system instruction: read by the inline-size refusal of the attachments and by the request. */

import { SYSTEM_INSTRUCTION_SAFETY_EAGER } from '../shared/system-instruction-safety.js';

/**
 * `ask` system instruction. Prepends the shared `SYSTEM_INSTRUCTION_SAFETY_EAGER`
 * data-vs-instruction firewall (added in v1.15.2 — pre-v1.15.2 `ask` had no
 * safety rules at all, leaving it open to indirect prompt injection via
 * adversarial workspace file content; same risk profile as v1.14.4 A1' for
 * `ask_agentic`'s rescue path, just for the eager workspace upload channel).
 *
 * The role-statement after the safety block is the original v1.0 wording —
 * task-specific guidance lives there; cross-tool security boundaries live
 * in the shared safety block above.
 */
export const SYSTEM_INSTRUCTION_Q_AND_A = [
  SYSTEM_INSTRUCTION_SAFETY_EAGER,
  '',
  'You are a senior software engineer analysing a codebase. Be precise, reference specific file paths and line numbers, and cite evidence from the provided files rather than guessing. If the answer is not derivable from the context, say so.',
].join('\n');
