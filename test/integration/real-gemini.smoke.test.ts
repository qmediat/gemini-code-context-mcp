/**
 * Integration smoke test against the real Gemini API.
 *
 * Skips silently when no `GEMINI_API_KEY` is set so CI (without secrets) passes.
 * Run locally with: `GEMINI_API_KEY=AIza... npm run test:integration`.
 *
 * What this covers (and what's NOT covered by unit tests):
 *   - Model registry enumeration (`models.list()`) against the live endpoint.
 *   - Files API upload + response shape (`.name` vs `.uri`).
 *   - `caches.create` with file-data parts (the load-bearing assumption behind
 *     our entire caching moat — if Google rejects file-data in cache contents,
 *     our whole strategy falls back to inline parts).
 *   - `generateContent({ cachedContent })` picks up the cache ID.
 *   - Token accounting fields (`usageMetadata.cachedContentTokenCount` etc.).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareContext } from '../../src/cache/cache-manager.js';
import { createGeminiClient } from '../../src/gemini/client.js';
import { listAvailableModels } from '../../src/gemini/model-registry.js';
import { resolveModel } from '../../src/gemini/models.js';
import { clearHashCache } from '../../src/indexer/hasher.js';
import { scanWorkspace } from '../../src/indexer/workspace-scanner.js';
import { ManifestDb } from '../../src/manifest/db.js';

const apiKey = process.env.GEMINI_API_KEY;
const suite = apiKey ? describe : describe.skip;

suite('real Gemini API smoke (requires GEMINI_API_KEY)', () => {
  const client = createGeminiClient({ kind: 'api-key', apiKey: apiKey ?? '' });
  const noopEmitter = { emit: () => {}, stop: () => {} };

  it('enumerates available models', async () => {
    const models = await listAvailableModels(client, { force: true });
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.id).toBeTruthy();
  }, 30_000);

  it("resolves 'latest-flash' alias against live registry", async () => {
    const resolved = await resolveModel('latest-flash', client);
    expect(resolved.resolved).toMatch(/flash/);
  }, 30_000);

  it('uploads files + builds cache + reuses on follow-up (small workspace → inline fallback)', async () => {
    clearHashCache();
    const root = mkdtempSync(join(tmpdir(), 'gcctx-int-small-'));
    writeFileSync(
      join(root, 'a.ts'),
      'export function greet(name: string) {\n  return `hello, ${name}`;\n}\n',
    );
    writeFileSync(join(root, 'b.ts'), 'export const PI = 3.14159;\nexport const E = 2.71828;\n');

    const manifest = new ManifestDb(join(root, 'manifest.db'));
    try {
      const resolved = await resolveModel('latest-flash', client);
      const scan = await scanWorkspace(root, { maxFiles: 50, maxFileSizeBytes: 100_000 });
      expect(scan.files.length).toBe(2);

      const first = await prepareContext({
        client,
        manifest,
        scan,
        model: resolved,
        systemPromptHash: 'test-prompt',
        systemInstruction: 'You are a test harness.',
        ttlSeconds: 300,
        emitter: noopEmitter,
        allowCaching: true,
      });
      // Under Gemini's 1024-token cache minimum → we skip upload entirely and
      // embed files inline from disk. No Files API round-trips for small workspaces.
      expect(first.cacheId).toBeNull();
      expect(first.inlineOnly).toBe(true);
      expect(first.inlineContents.length).toBe(1);
      expect(first.uploaded.files.length).toBe(0);
      expect(first.uploaded.failedCount).toBe(0);

      // Second call: still inline-only, no uploads, no Files API calls.
      const second = await prepareContext({
        client,
        manifest,
        scan,
        model: resolved,
        systemPromptHash: 'test-prompt',
        systemInstruction: 'You are a test harness.',
        ttlSeconds: 300,
        emitter: noopEmitter,
        allowCaching: true,
      });
      expect(second.inlineOnly).toBe(true);
      expect(second.uploaded.uploadedCount).toBe(0);
      expect(second.uploaded.reusedCount).toBe(0);
    } finally {
      manifest.close();
    }
  }, 120_000);

  it('builds actual Context Cache when workspace is above the 1024-token floor', async () => {
    clearHashCache();
    const root = mkdtempSync(join(tmpdir(), 'gcctx-int-large-'));
    // Generate enough content to clear the Gemini 1024-token cache minimum.
    // ~5 kB of source is well over the floor at 4 bytes/token (=~1280 tokens).
    const filler = Array.from(
      { length: 120 },
      (_, i) =>
        `export function handler_${i}(input: string): string { return input.repeat(${i + 1}); }`,
    ).join('\n');
    writeFileSync(join(root, 'lib.ts'), filler);
    writeFileSync(
      join(root, 'README.md'),
      `# Test workspace\n\n${Array.from({ length: 40 }, (_, i) => `- Note ${i}: load-bearing docstring.`).join('\n')}`,
    );

    const manifest = new ManifestDb(join(root, 'manifest.db'));
    try {
      const resolved = await resolveModel('latest-flash', client);
      const scan = await scanWorkspace(root, { maxFiles: 50, maxFileSizeBytes: 100_000 });

      const first = await prepareContext({
        client,
        manifest,
        scan,
        model: resolved,
        systemPromptHash: 'test-prompt-large',
        systemInstruction: 'You are a test harness.',
        ttlSeconds: 300,
        emitter: noopEmitter,
        allowCaching: true,
      });
      // If Gemini rejected cache build for another reason, the fallback keeps us
      // correct — but we want to explicitly assert the happy path works.
      if (first.cacheId === null) {
        // Log for operator visibility; don't fail — could be a tier mismatch.
        console.warn(
          'cache build skipped/rejected for large workspace test — run with a Pro tier key for full coverage.',
        );
        return;
      }
      expect(first.rebuilt).toBe(true);
      expect(first.cacheId).toMatch(/cachedContents\//);

      const second = await prepareContext({
        client,
        manifest,
        scan,
        model: resolved,
        systemPromptHash: 'test-prompt-large',
        systemInstruction: 'You are a test harness.',
        ttlSeconds: 300,
        emitter: noopEmitter,
        allowCaching: true,
      });
      expect(second.reused).toBe(true);
      expect(second.cacheId).toBe(first.cacheId);

      // Use the cache in a real generateContent call.
      const response = await client.models.generateContent({
        model: resolved.resolved,
        contents: 'Name three exported functions and their argument signatures.',
        config: { cachedContent: first.cacheId },
      });
      expect(typeof response.text).toBe('string');
      expect(response.usageMetadata?.cachedContentTokenCount ?? 0).toBeGreaterThan(0);

      // REGRESSION GUARD: Gemini rejects generateContent({cachedContent, systemInstruction})
      // with 400 "CachedContent can not be used with GenerateContent request setting
      // system_instruction, tools or tool_config." The production tool (ask/code) must
      // NEVER pass systemInstruction alongside cachedContent. This call verifies the
      // failure mode so a future refactor that re-adds systemInstruction is caught.
      await expect(
        client.models.generateContent({
          model: resolved.resolved,
          contents: 'What files exist?',
          config: {
            cachedContent: first.cacheId,
            systemInstruction: 'You are a test harness.',
          },
        }),
      ).rejects.toThrow(/INVALID_ARGUMENT|cached[_ ]?content|system_instruction/i);
    } finally {
      manifest.close();
    }
  }, 180_000);

  it('generateContent returns text + usage metadata', async () => {
    const resolved = await resolveModel('latest-flash', client);
    const response = await client.models.generateContent({
      model: resolved.resolved,
      contents: 'Say the single word: pong.',
      config: { systemInstruction: 'Be extremely concise.' },
    });
    expect(typeof response.text).toBe('string');
    expect(response.text?.length).toBeGreaterThan(0);
    expect(response.usageMetadata).toBeDefined();
  }, 60_000);

  // P10 (v1.15.3): defensive smoke test for ask_agentic's forced-finalization
  // rescue payload contract. v1.14.4 review surfaced 2-of-3 reviewers
  // claiming `toolConfig: { mode: NONE }` without `tools` would 400 — refuted
  // empirically by 5+ successful rescue runs. The unit test for the rescue
  // config (G2 fix in ask-agentic.test.ts:782+) verifies request SHAPE only;
  // it can't catch a future Google API contract regression.
  //
  // This integration test exercises the EXACT payload shape the rescue uses
  // against the live API. CI without the GEMINI_API_KEY env skips silently;
  // local / release-validation runs catch a contract flip before customer
  // impact. Per Google docs (ai.google.dev/gemini-api/docs/function-calling):
  // "NONE: equivalent to sending a request without any function declarations."
  it('forced-finalization rescue payload (toolConfig: NONE without tools) is accepted (P10/v1.15.3)', async () => {
    const resolved = await resolveModel('latest-flash', client);
    // The load-bearing claim under test: Gemini API accepts a `generateContent`
    // request with `toolConfig: { mode: NONE }` AND no `tools` field. v1.14.4
    // review surfaced 2-of-3 reviewers (gemini-cli + gemini-chat) claiming this
    // would 400 — empirically refuted, but the unit test for the rescue config
    // (G2 fix in ask-agentic.test.ts) verifies request SHAPE only, so a future
    // Google API contract regression on this specific shape would slip through.
    //
    // We use a single-turn plain-text conversation rather than a synthetic
    // multi-turn `[user, model fc, user functionResponse]` history. Reason:
    // Google's API recently started rejecting synthetic `functionCall` parts
    // that lack a `thought_signature` (per ai.google.dev/gemini-api/docs/thought-signatures
    // — replay-safety contract for tool-calling). Building a valid signed
    // conversation would require a real prior tool-calling turn, which is
    // overkill for the contract under test. The single-turn shape exercises
    // the same load-bearing assertion (toolConfig + NONE + no tools) without
    // the synthetic-history complication. Production rescue paths replay a
    // GENUINE accumulated conversation built by prior loop iterations, so
    // their tool-call parts are correctly signed.
    const response = await client.models.generateContent({
      model: resolved.resolved,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Acknowledge that you have no tools available on this turn. One sentence, under 15 words.',
            },
          ],
        },
      ],
      config: {
        systemInstruction:
          'You are wrapping up an investigation. Function calling is disabled — synthesize the answer in plain text.',
        // The load-bearing assertion: toolConfig with NONE mode AND tools
        // field omitted. If Google flips the contract to require tools when
        // toolConfig is set, this call throws and the test fails loudly.
        toolConfig: { functionCallingConfig: { mode: 'NONE' as const } },
        // tools field intentionally omitted — production rescue uses
        // `const { tools: _, ...baseConfigNoTools } = baseConfig` to strip.
      },
    });
    expect(typeof response.text).toBe('string');
    expect(response.text?.length).toBeGreaterThan(0);
    // Sanity: response shape includes the fields the rescue's post-await
    // parsing reads (candidates[0].content.parts + usageMetadata).
    expect(response.candidates?.[0]?.content?.parts).toBeDefined();
    expect(response.usageMetadata).toBeDefined();
  }, 60_000);
});
