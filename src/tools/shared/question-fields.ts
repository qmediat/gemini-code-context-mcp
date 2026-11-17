/**
 * The input fields `ask` and `ask_agentic` share — the question and the workspace it is about: one schema, one text
 * (`ask` hands its input to `ask_agentic` when a workspace is too large for it).
 */

import { z } from 'zod';

/** The question, as both tools take it. */
export const PROMPT_FIELD = z.string().min(1).describe('The question or analysis request.');

/** The workspace the question is about, as both tools take it. */
export const WORKSPACE_FIELD = z
  .string()
  .optional()
  .describe('Absolute or cwd-relative path to the workspace. Defaults to process.cwd().');
