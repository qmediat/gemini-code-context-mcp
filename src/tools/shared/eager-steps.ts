/**
 * The steps of an `ask` / `code` call before its context that both tools run the same way. Each returns values or a
 * refusal for its tool to report; every result keeps its tool's own fields and their order.
 */

import {
  WorkspaceValidationError,
  validateWorkspacePath,
} from '../../indexer/workspace-validation.js';
import { type TextToolResult, errorResult } from '../registry.js';
import type { TimedTool } from './abort-timeout.js';

/**
 * The refusal of a workspace path the validation rejects (`<tool>: <message>`, no fields), else `null`. Called inside
 * the call's `try`: any other error of the validation reaches the call's failure path.
 */
export function workspaceRefusal(tool: TimedTool, workspaceRoot: string): TextToolResult | null {
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
