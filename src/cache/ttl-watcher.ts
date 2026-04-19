/**
 * Background TTL refresher for "hot" workspaces.
 *
 * Gemini Context Caches default to 1h TTL and can be extended via `caches.update`
 * with a new `ttl` value. We only refresh caches that were used in the last
 * 10 minutes — cold workspaces are allowed to expire.
 */

import type { GoogleGenAI } from '@google/genai';
import type { ManifestDb } from '../manifest/db.js';
import { logger } from '../utils/logger.js';

const TICK_MS = 5 * 60 * 1000; // 5 minutes
const HOT_WINDOW_MS = 10 * 60 * 1000; // used in last 10 minutes
const REFRESH_IF_EXPIRES_WITHIN_MS = 15 * 60 * 1000;

interface HotEntry {
  workspaceRoot: string;
  cacheId: string;
  lastUsed: number;
  ttlSeconds: number;
}

export class TtlWatcher {
  private readonly hot = new Map<string, HotEntry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: GoogleGenAI,
    private readonly manifest: ManifestDb,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    // Don't hold the event loop open just for the watcher.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.hot.clear();
  }

  markHot(workspaceRoot: string, cacheId: string, ttlSeconds: number): void {
    this.hot.set(workspaceRoot, {
      workspaceRoot,
      cacheId,
      lastUsed: Date.now(),
      ttlSeconds,
    });
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.hot) {
      if (now - entry.lastUsed > HOT_WINDOW_MS) {
        this.hot.delete(key);
        continue;
      }
      const ws = this.manifest.getWorkspace(entry.workspaceRoot);
      if (!ws?.cacheId || ws.cacheId !== entry.cacheId) {
        this.hot.delete(key);
        continue;
      }
      if (ws.cacheExpiresAt !== null && ws.cacheExpiresAt - now > REFRESH_IF_EXPIRES_WITHIN_MS) {
        continue; // plenty of time left
      }
      try {
        await this.client.caches.update({
          name: entry.cacheId,
          config: { ttl: `${entry.ttlSeconds}s` },
        });
        const newExpires = now + entry.ttlSeconds * 1000;
        this.manifest.upsertWorkspace({ ...ws, cacheExpiresAt: newExpires, updatedAt: now });
        logger.debug(`refreshed TTL for ${entry.cacheId}`);
      } catch (err) {
        logger.debug(`ttl refresh failed for ${entry.cacheId}: ${String(err)}`);
      }
    }
  }
}
