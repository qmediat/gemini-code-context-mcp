/**
 * The refusal of a workspace path the validation rejects: the first step of every tool that validates its workspace
 * (`ask`, `code`, `ask_agentic`, `reindex`), one text for all of them.
 */

import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../../indexer/workspace-validation.js';
import { type TextToolResult, errorResult } from '../registry.js';

/** The tools that validate their workspace before anything else. */
export type WorkspaceTool = 'ask' | 'code' | 'ask_agentic' | 'reindex';

/**
 * The refusal of a workspace path the validation rejects (`<tool>: <message>`, no fields), else `null`. Called inside
 * the tool's `try`: any other error of the validation reaches the tool's failure path.
 */
export function workspaceRefusal(
  tool: WorkspaceTool,
  workspaceRoot: string,
): TextToolResult | null {
  try {
    validateWorkspacePath(workspaceRoot);
  } catch (err) {
    if (err instanceof WorkspaceValidationError) {
      return errorResult(`${tool}: ${err.message}`);
    }
    throw err;
  }
  return null;
}
