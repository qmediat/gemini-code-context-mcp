/**
 * One `ask` call as it grows: each stage adds what its step produced — nothing optional. A step's outcome
 * (`StepOutcome`, `../shared/eager-call.ts`) says whether the call goes on or ends with a result.
 */

import type { Part } from '@google/genai';
import type { Attachment } from '../../attachments.js';
import type { BoundedOutputCap, OutputCap } from '../../gemini/long-decode.js';
import type { ScanResult } from '../../indexer/workspace-scanner.js';
import type { ResolvedModel } from '../../types.js';
import type { ToolContext } from '../registry.js';
import type { EagerCall, ModelReached } from '../shared/eager-call.js';
import type { InputEstimate, PreflightCount } from '../shared/eager-steps.js';
import type { ServiceTierName } from '../shared/service-tier.js';
import type { AskInput } from './input.js';
import type { AskThinking } from './thinking.js';

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

/** The attachments of one call, inspected, read and counted by Gemini. */
export interface PreparedAttachments {
  readonly attached: Attachment[];
  readonly parts: Part[];
  /** Raw bytes read. */
  readonly bytes: number;
  /** What Gemini counted for the parts. */
  readonly tokens: number;
}

/** The attachments inspected, read and counted. */
export interface AskAttached extends AskResolved {
  readonly attachments: PreparedAttachments;
}

/** The workspace scanned, the output cap asked for, the input estimated; no refusal over them. */
export interface AskScanned extends AskAttached {
  readonly scan: ScanResult;
  readonly outputCap: OutputCap;
  readonly estimate: InputEstimate;
}

/** The input counted and held against the model's window. */
export interface AskCounted extends AskScanned {
  /** `null`: the model advertises no input limit; the guard did not run. */
  readonly count: PreflightCount | null;
}

/**
 * The cap that runs — after the input window's cut — and the thinking under it: the call as the budget reservation,
 * the decode and the settlement read it (`SizedCall`), and as the request and the answer read it.
 */
export interface AskSized extends AskCounted {
  readonly bounded: BoundedOutputCap;
  readonly thinking: AskThinking;
}
