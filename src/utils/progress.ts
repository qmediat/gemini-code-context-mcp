/**
 * MCP progress notification helper.
 *
 * MCP hosts can cancel or time out long-running tool calls if they don't see
 * activity. We emit `notifications/progress` on a ~25s cadence plus on meaningful
 * milestones (upload started, cache built, generating).
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

const KEEPALIVE_MS = 25_000;

export interface ProgressEmitter {
  /** Emit a progress update. Safe to call without a progressToken. */
  emit(message: string, progress?: number, total?: number): void;
  /** Stop the keepalive interval and release resources. */
  stop(): void;
}

export function createProgressEmitter(
  server: Server,
  progressToken: string | number | undefined,
): ProgressEmitter {
  if (progressToken === undefined) {
    return {
      emit: () => {
        /* no-op — host didn't subscribe to progress */
      },
      stop: () => {},
    };
  }

  let lastMessage = 'working…';
  let lastProgress = 0;
  let lastTotal: number | undefined;

  const send = (message: string, progress: number, total: number | undefined): void => {
    lastMessage = message;
    lastProgress = progress;
    lastTotal = total;
    void server
      .notification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          ...(total !== undefined ? { total } : {}),
          message,
        },
      })
      .catch(() => {
        /* swallow — best-effort notification */
      });
  };

  const keepalive = setInterval(() => {
    send(lastMessage, lastProgress, lastTotal);
  }, KEEPALIVE_MS);

  return {
    emit: (message, progress, total) => send(message, progress ?? lastProgress + 1, total),
    stop: () => clearInterval(keepalive),
  };
}
