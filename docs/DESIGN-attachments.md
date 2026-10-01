# Design — `ask` attachments (images and PDFs sent inline with the question)

Status: implemented in 1.20.0. The first attempt (PR #91) was closed after its review ledger declared two findings
stuck; this note exists so that the implementation argues from a written model instead of patching, and so that a
reviewer can check the code against the model.

## What it is

`ask({ attachments: ["shot.png", "spec.pdf"] })` sends up to 8 local image or PDF files as `inlineData` parts before the
question in the user turn, with or without a Context Cache. They belong to one question; the workspace cache never
contains them. The `latest-vision` alias gets an input to see.

## Data model (types, not prose)

```ts
type AttachmentMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';
interface Attachment {            // what inspection established
  readonly path: string;          // canonical path inside the workspace
  readonly dev: number;           // identity of the inspected file: the read accepts only this inode
  readonly ino: number;
  readonly mimeType: AttachmentMimeType;
  readonly bytes: number;
}
interface ReadAttachments { parts: Part[]; bytes: number }   // the inline parts, read once, bounded
// tokens: NOT a field of either — Gemini's countTokens answers for the assembled parts (see "Token count")
```

Caps (this server's, under every figure Google publishes): 8 files, 10 MB per file, 14 MB raw in total
(≈ 18.7 MB once base64-encoded, under the 20 MB-including-text figure for images). Google's 20 MB limit on one
inline request (files, prompt and system instruction together) is checked after the scan with the encoded attachment
bytes plus the workspace and prompt bytes, whatever the caching mode (an explicit cache may not be built and the call
then runs inline): over it, `REQUEST_TOO_LARGE` before any reservation. Accepted types by extension,
confirmed by the first bytes (PNG / JPEG / WebP / PDF magic) once read: a mismatch is refused by name.

## Threat model — what is defended, what is not

Defended:
- a path the client names outside the workspace, through `..`, an absolute path or a symlink (leaf or parent):
  `resolveInsideWorkspace` (the `ask_agentic` jail: realpath, containment, the secret denylist — basenames,
  extensions and directories such as `.ssh/`) at inspection;
- a symlink leaf as named: `lstat` before resolution; and at read `O_NOFOLLOW`;
- a file that is not the inspected one at read (deleted, replaced, grown): the read opens the inspected canonical path
  and accepts only the inspected `(dev, ino)` behind the descriptor, measures through the descriptor and reads
  `size + 1` bytes in 1 MB chunks (stops on the call's timeout) — no second walk of the path, so there is nothing to
  toggle around a re-resolution;
- a file whose bytes are not its declared type: the magic check after the read (Gemini 3 answers 400
  `INVALID_ARGUMENT` to such a part; a Flash-Lite model counts it — the refusal is uniform and local);
- a bad file costing anything: inspection, read and count happen before the size preflight, the budget reservation and
  the TPM reservation; every refusal is `ATTACHMENT_INVALID` (`retryable: false`), never `UNKNOWN`.

Out of scope, stated: a writer inside the workspace during the call. The server already uploads every workspace file
through a scan followed by a read with no such defence; attachments get the same trust in the workspace and no more.
Residual: inode reuse after a deletion within the call — theoretical, not defended.

## Token count — measured, not estimated

The size preflight, the budget reservation and the TPM throttle need the attachments' tokens. They are obtained from
Gemini's `countTokens` on the assembled parts — one free call carrying only the parts, right after the read, so the
workspace preflight keeps its own cache key `(filesHash, prompt, model)` and its heuristic tier. Measured on
2026-10-01 with the project's key: a 1×1 PNG counts 1090 tokens on `gemini-3-flash-preview` and 259 on
`gemini-2.5-flash-lite`; a one-page PDF 561 and 259 — no local figure is right for every model, which is why the
first attempt's "upper bound" (24 tiles × 258 per image, `/Count` pages × 258 per PDF) is gone. When the count cannot
be obtained (the API fails, the total is malformed), the call is refused with `ATTACHMENT_TOKENS_UNCOUNTED`
(`retryable: true`) — no local estimate is presented as a count. A cancellation during the count keeps its identity
and maps to `TIMEOUT`. The ledger settles what Gemini billed.

## Module map

- `src/attachments.ts` — `inspectAttachments(paths, workspaceRoot)`, `readAttachments(attachments, signal)`,
  `countAttachmentTokens(client, model, parts, signal)`, the constants, `AttachmentError`,
  `AttachmentTokensUncountedError`. Functions ≤ 40 lines.
- `src/tools/ask.tool.ts` — the `attachments` parameter; `prepareAttachments` (inspect → read → count) right after the
  model and the tier are resolved, before the scan; the count in the preflight comparison, the budget estimate
  (`extraInputTokens`) and the throttle reservation; the parts in the user turn (`[...parts, { text: prompt }]`, the
  bare prompt string only on a cache hit without attachments); `structuredContent.attachments` + `attachmentTokens`.
- `src/utils/cost-estimator.ts` — `extraInputTokens` on the pre-call estimate.
- `src/gemini/model-taxonomy.ts` — Flash-Lite models count as vision-capable (Google lists image and PDF input;
  `countTokens` on 2.5 Flash-Lite accepted both on 2026-10-01).
- docs: README, `docs/configuration.md`, `docs/models.md`, CHANGELOG.

## Error policy

| Case | Result |
|---|---|
| model without vision | `ATTACHMENTS_UNSUPPORTED`, `retryable: false`, before any call |
| path outside the workspace, symlink, secret, bad type or magic, size, unreadable, swapped at read | `ATTACHMENT_INVALID`, `retryable: false`, before any reservation |
| countTokens unavailable or malformed for the parts | `ATTACHMENT_TOKENS_UNCOUNTED`, `retryable: true`, before any reservation |
| encoded attachments + workspace + prompt over Google's 20 MB inline request limit | `REQUEST_TOO_LARGE`, `retryable: false`, before any reservation |
| `onWorkspaceTooLarge: fallback-to-agentic` with attachments | `WORKSPACE_TOO_LARGE` with the reason (the agentic tool carries no parts) |

Every one of these carries `serviceTier` (the call reached model resolution — the 1.19.0 contract).

## Test plan (`test/unit/ask-attachments.test.ts`; each check red on the pre-change code)

1. the inline part precedes the question in the last user turn; the cached prompt becomes `[userTurn]`; without
   attachments a cache hit still sends the bare string and `countTokens` is not called;
2. a model without vision is refused before any call;
3. outside path, symlink leaf, symlink parent, a file in a secret directory, unsupported type, over-cap file, wrong
   magic, missing file: refused by name before any count or reservation (`countTokens`, `reserveBudget` and
   `throttle.reserve` never called); too many files refused; a pair that pushes the inline request over 20 MB is
   `REQUEST_TOO_LARGE` before any reservation;
4. a file swapped for a symlink, replaced by another inode, deleted or grown after inspection is refused at read; a
   file deleted after the read still goes out;
5. the parts are what `countTokens` is asked about; the count is in the throttle reservation, the budget estimate and
   the preflight comparison; a failed or malformed count refuses the call before any reservation; an abort during the
   count keeps its identity;
6. the fallback path refuses attachments with a reason.

## Performance budget

One extra `countTokens` call per `ask` with attachments (free, hundreds of ms); ≤ 14 MB read once; base64 once.
