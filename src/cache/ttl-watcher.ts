/**
 * Background TTL refresher for "hot" workspaces.
 *
 * Gemini Context Caches default to 1h TTL and can be extended via `caches.update`
 * with a new `ttl` value. We only refresh caches that were used in the last
 * 10 minutes — cold workspaces are allowed to expire.
 */

import type { CachedContent, GoogleGenAI } from '@google/genai';
import { abortable, throwIfAborted } from '../gemini/retry.js';
import type { ManifestDb } from '../manifest/db.js';
import { logger, safeForLog } from '../utils/logger.js';

const TICK_MS = 5 * 60 * 1000; // 5 minutes
const HOT_WINDOW_MS = 10 * 60 * 1000; // used in last 10 minutes
const REFRESH_IF_EXPIRES_WITHIN_MS = 15 * 60 * 1000;

interface HotEntry {
  workspaceRoot: string;
  cacheId: string;
  lastUsed: number;
  ttlSeconds: number;
}

/** Match 404 / NOT_FOUND patterns in Gemini error strings. Conservative by design. */
function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|NOT_FOUND|not[_ ]?found|not-found|does not exist/i.test(msg);
}

export class TtlWatcher {
  private readonly hot = new Map<string, HotEntry>();
  private timer: NodeJS.Timeout | null = null;
  /** Re-entrancy guard: a slow `caches.update` round-trip must not overlap the next tick. */
  private tickInProgress = false;
  /** The refresh running for each cache name: the tick and every keep-alive of that cache join it. */
  private readonly refreshing = new Map<string, Promise<void>>();

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
    this.hotEntry(workspaceRoot, cacheId, ttlSeconds);
  }

  /**
   * A request is about to be sent on the cache: mark it hot and, when it expires within the refresh window
   * (15 minutes), extend it now instead of at the next tick — so a decode of many requests, each opened through here,
   * never sends one on a cache that expires before the request ends (a request of a decode lasts minutes). The
   * keep-alive is best-effort: a failed refresh, or a manifest that cannot be read or written, is logged and leaves
   * the request to meet the cache as it is.
   *
   * `signal` is the calling request's: an aborted signal starts no refresh, and the wait ends with its abort reason the
   * moment it fires — the only rejection of this method, so a slow or hanging refresh never holds a call past its
   * timeout. The refresh itself carries no caller's signal: it is shared by every keep-alive of the cache and by the
   * tick, so it runs to its end for the others when the call that started it leaves.
   */
  async keepAlive(
    workspaceRoot: string,
    cacheId: string,
    ttlSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const entry = this.hotEntry(workspaceRoot, cacheId, ttlSeconds);
    await abortable(this.refresh(entry, Date.now()), signal);
  }

  private hotEntry(workspaceRoot: string, cacheId: string, ttlSeconds: number): HotEntry {
    const entry: HotEntry = { workspaceRoot, cacheId, lastUsed: Date.now(), ttlSeconds };
    this.hot.set(workspaceRoot, entry);
    return entry;
  }

  private async tick(): Promise<void> {
    // Prevent overlap: if the previous tick is still running (slow Gemini
    // round-trips, throttle), skip this firing entirely rather than issuing
    // concurrent `caches.update` calls on the same names.
    if (this.tickInProgress) {
      logger.debug('ttl tick already in progress, skipping this firing');
      return;
    }
    this.tickInProgress = true;
    try {
      const now = Date.now();
      for (const entry of [...this.hot.values()]) {
        if (now - entry.lastUsed > HOT_WINDOW_MS) {
          this.hot.delete(entry.workspaceRoot);
          continue;
        }
        await this.refresh(entry, now);
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * The one refresh of the entry's cache: the running one when there is one, else a new one. It never rejects — a
   * failure of the refresh or of the manifest is logged here, for the tick and the keep-alive alike.
   */
  private refresh(entry: HotEntry, now: number): Promise<void> {
    const running = this.refreshing.get(entry.cacheId);
    if (running !== undefined) return running;
    const started = this.refreshIfDue(entry, now)
      .catch((err: unknown) => {
        logger.warn(`ttl refresh failed for ${safeForLog(entry.cacheId)}: ${safeForLog(err)}`);
      })
      .finally(() => this.refreshing.delete(entry.cacheId));
    this.refreshing.set(entry.cacheId, started);
    return started;
  }

  /** Extends the entry's cache when it expires within the refresh window; drops an entry whose cache is gone. */
  private async refreshIfDue(entry: HotEntry, now: number): Promise<void> {
    const ws = this.manifest.getWorkspace(entry.workspaceRoot);
    if (!ws?.cacheId || ws.cacheId !== entry.cacheId) {
      this.hot.delete(entry.workspaceRoot);
      return;
    }
    if (ws.cacheExpiresAt !== null && ws.cacheExpiresAt - now > REFRESH_IF_EXPIRES_WITHIN_MS) {
      return; // plenty of time left
    }
    let answered: CachedContent;
    try {
      answered = await this.client.caches.update({
        name: entry.cacheId,
        config: { ttl: `${entry.ttlSeconds}s` },
      });
    } catch (err) {
      this.updateFailed(entry, err);
      return;
    }
    this.storeExpiry(entry, expiryOf(answered, entry.ttlSeconds));
    logger.debug(`refreshed TTL for ${safeForLog(entry.cacheId)}`);
  }

  /**
   * The expiry the API answered goes to the manifest row as it is NOW — read again after the round-trip, so a row
   * rewritten meanwhile keeps its other fields, and a row that moved to another cache is left alone.
   */
  private storeExpiry(entry: HotEntry, expiresAt: number): void {
    const current = this.manifest.getWorkspace(entry.workspaceRoot);
    if (current?.cacheId !== entry.cacheId) return;
    this.manifest.upsertWorkspace({ ...current, cacheExpiresAt: expiresAt, updatedAt: Date.now() });
  }

  private updateFailed(entry: HotEntry, err: unknown): void {
    // Evict the entry when Gemini reports the cache is gone (deleted
    // externally, admin quota action, etc). Without this, we'd retry
    // the update every TICK_MS forever and log-spam the 404.
    if (!isNotFoundError(err)) {
      logger.debug(`ttl refresh failed for ${safeForLog(entry.cacheId)}: ${safeForLog(err)}`);
      return;
    }
    logger.debug(
      `ttl refresh for ${entry.cacheId} returned not-found; dropping hot entry and nulling manifest cacheId`,
    );
    this.hot.delete(entry.workspaceRoot);
    const current = this.manifest.getWorkspace(entry.workspaceRoot);
    if (current?.cacheId !== entry.cacheId) return;
    this.manifest.upsertWorkspace({
      ...current,
      cacheId: null,
      cacheExpiresAt: null,
      updatedAt: Date.now(),
    });
  }
}

/** The expiry `caches.update` answered; the requested TTL from now when the answer carries none. */
function expiryOf(answered: CachedContent, ttlSeconds: number): number {
  const parsed = answered.expireTime === undefined ? Number.NaN : Date.parse(answered.expireTime);
  return Number.isFinite(parsed) ? parsed : Date.now() + ttlSeconds * 1000;
}
