/**
 * An `ask` / `code` call whose usage row cannot be written (no daily budget, so the row is an insert): the paid answer
 * is returned and the lost write is logged, once.
 */

import { expect, vi } from 'vitest';
import type { ManifestDb } from '../../src/manifest/db.js';
import type { TextToolResult } from '../../src/tools/registry.js';
import { logger } from '../../src/utils/logger.js';

/** Make `manifest.insertUsageMetric` fail, run `call`, and check the answer `answer` came back with one logged line. */
export async function expectAnswerDespiteUnwrittenUsageRow(
  tool: 'ask' | 'code',
  manifest: ManifestDb,
  call: () => Promise<TextToolResult>,
  answer: string,
): Promise<void> {
  const insertUsageMetric = vi.mocked(manifest.insertUsageMetric);
  insertUsageMetric.mockImplementation(() => {
    throw new Error('SQLITE_BUSY');
  });
  const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  try {
    const result = await call();

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(answer);
    expect(insertUsageMetric).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls.map(([line]) => line)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${tool}: insertUsageMetric failed; no usage row was written, the billed \\d+ micros were not written\\. Error: .*SQLITE_BUSY`,
        ),
      ),
    ]);
  } finally {
    logged.mockRestore();
  }
}
