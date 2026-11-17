/** `ask`'s system instruction: read by the inline-size refusal of the attachments and by the request. */

import { SYSTEM_INSTRUCTION_SAFETY_EAGER } from '../shared/system-instruction-safety.js';

/**
 * `ask`'s system instruction: the shared `SYSTEM_INSTRUCTION_SAFETY_EAGER` first — the data-vs-instruction firewall
 * that keeps the workspace files' content from steering the model — then `ask`'s role statement. Cross-tool security
 * rules live in the shared block; what is particular to answering questions lives in the role statement.
 */
export const SYSTEM_INSTRUCTION_Q_AND_A = [
  SYSTEM_INSTRUCTION_SAFETY_EAGER,
  '',
  'You are a senior software engineer analysing a codebase. Be precise, reference specific file paths and line numbers, and cite evidence from the provided files rather than guessing. If the answer is not derivable from the context, say so.',
].join('\n');
