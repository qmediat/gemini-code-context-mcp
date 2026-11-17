/**
 * One `ask` call as it grows: each stage adds what its step produced — nothing optional — and a step's outcome says
 * whether the call goes on, ends with a result, or hands off to the `ask_agentic` fallback.
 */

import type { ResolvedModel } from '../../types.js';
import type { TextToolResult, ToolContext } from '../registry.js';
import type { EagerCall, ModelReached } from '../shared/eager-call.js';
import type { ServiceTierName } from '../shared/service-tier.js';
import type { PreparedAttachments } from './attachments.js';
import type { AskInput } from './input.js';

/** The call as the entry opened it. */
export interface AskCall {
  readonly input: AskInput;
  readonly ctx: ToolContext;
  /** The alias or id as asked. */
  readonly model: string;
  readonly eager: EagerCall<ModelReached>;
}

/** The model and the tier resolved. */
export interface AskResolved extends AskCall {
  readonly resolved: ResolvedModel;
  readonly serviceTier: ServiceTierName;
}

/** The attachments inspected, read and counted. */
export interface AskAttached extends AskResolved {
  readonly attachments: PreparedAttachments;
}

/**
 * A step's outcome: the next stage; the result that ends the call (a refusal); or the fallback, still pending, which
 * the entry returns unawaited — its `finally` runs while the fallback runs, and a rejection of the fallback reaches
 * the caller as it came, never the call's failure path.
 */
export type StepOutcome<T> =
  | { readonly next: T }
  | { readonly end: TextToolResult }
  | { readonly handOff: Promise<TextToolResult> };
