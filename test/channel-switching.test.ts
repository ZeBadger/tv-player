/**
 * Integration-style tests for channel switching / playback session cleanup.
 *
 * server.mjs does not export its internals, so this file tests the session pool
 * behaviour by replicating the relevant logic in-process.  Any refactor of the
 * session pool in server.mjs should be reflected here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Replicated session pool logic (mirrors server.mjs) ──────────────────────

const TUNER_RELEASE_DELAY_MS = 0; // speed up for tests

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeSessionPool(maxConcurrentStreams: number) {
  const activePlaybackSessions = new Map<number, { stop: (forced: boolean) => void }>();
  let playbackSessionId = 0;
  let playbackGate = Promise.resolve();

  const withPlaybackGate = async <T>(task: () => Promise<T>): Promise<T> => {
    const previousGate = playbackGate;
    let releaseGate!: () => void;
    playbackGate = new Promise((resolve) => { releaseGate = resolve; });
    await previousGate;
    try {
      return await task();
    } finally {
      releaseGate();
    }
  };

  const releaseAllActivePlaybackLocked = async () => {
    if (activePlaybackSessions.size === 0) return false;
    const sessions = [...activePlaybackSessions.values()];
    activePlaybackSessions.clear();
    for (const session of sessions) session.stop(true);
    await wait(TUNER_RELEASE_DELAY_MS);
    return true;
  };

  const acquirePlaybackSession = async (
    stop: (forced: boolean) => void,
  ): Promise<{ ok: boolean; id?: number; release?: () => void; statusCode?: number; message?: string }> => {
    return withPlaybackGate(async () => {
      if (maxConcurrentStreams === 1) {
        await releaseAllActivePlaybackLocked();
      } else if (activePlaybackSessions.size >= maxConcurrentStreams) {
        return { ok: false, statusCode: 503, message: 'Max concurrent streams reached' };
      }

      const id = ++playbackSessionId;
      activePlaybackSessions.set(id, { stop });

      const release = () => {
        activePlaybackSessions.delete(id);
      };

      return { ok: true, id, release };
    });
  };

  return { activePlaybackSessions, acquirePlaybackSession };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('session pool with MAX_CONCURRENT_STREAMS=1 (default)', () => {
  let pool: ReturnType<typeof makeSessionPool>;

  beforeEach(() => {
    pool = makeSessionPool(1);
  });

  it('acquires the first session successfully', async () => {
    const stop = vi.fn();
    const result = await pool.acquirePlaybackSession(stop);
    expect(result.ok).toBe(true);
    expect(pool.activePlaybackSessions.size).toBe(1);
  });

  it('stops the previous session when a new stream is requested', async () => {
    const stop1 = vi.fn();
    const stop2 = vi.fn();

    const slot1 = await pool.acquirePlaybackSession(stop1);
    expect(slot1.ok).toBe(true);

    // Second stream request should evict the first.
    const slot2 = await pool.acquirePlaybackSession(stop2);
    expect(slot2.ok).toBe(true);

    expect(stop1).toHaveBeenCalledWith(true);    // forced takeover
    expect(stop2).not.toHaveBeenCalled();        // second is still active
    expect(pool.activePlaybackSessions.size).toBe(1);
  });

  it('calls the stop callback with forced=true on takeover', async () => {
    const stop1 = vi.fn();
    await pool.acquirePlaybackSession(stop1);

    const stop2 = vi.fn();
    await pool.acquirePlaybackSession(stop2);

    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stop1).toHaveBeenCalledWith(true);
  });

  it('allows a new session after the previous one is released naturally', async () => {
    const stop1 = vi.fn();
    const slot1 = await pool.acquirePlaybackSession(stop1);
    expect(slot1.ok).toBe(true);

    slot1.release!();
    expect(pool.activePlaybackSessions.size).toBe(0);

    const stop2 = vi.fn();
    const slot2 = await pool.acquirePlaybackSession(stop2);
    expect(slot2.ok).toBe(true);
    expect(stop1).not.toHaveBeenCalled(); // natural release, not forced
  });
});

describe('session pool with MAX_CONCURRENT_STREAMS=2', () => {
  let pool: ReturnType<typeof makeSessionPool>;

  beforeEach(() => {
    pool = makeSessionPool(2);
  });

  it('allows up to the configured number of concurrent sessions', async () => {
    const slot1 = await pool.acquirePlaybackSession(vi.fn());
    const slot2 = await pool.acquirePlaybackSession(vi.fn());
    expect(slot1.ok).toBe(true);
    expect(slot2.ok).toBe(true);
    expect(pool.activePlaybackSessions.size).toBe(2);
  });

  it('rejects a third session when the pool is full', async () => {
    await pool.acquirePlaybackSession(vi.fn());
    await pool.acquirePlaybackSession(vi.fn());

    const stop3 = vi.fn();
    const result = await pool.acquirePlaybackSession(stop3);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(stop3).not.toHaveBeenCalled();
    expect(pool.activePlaybackSessions.size).toBe(2); // unchanged
  });

  it('accepts a new session after one slot is freed', async () => {
    const slot1 = await pool.acquirePlaybackSession(vi.fn());
    await pool.acquirePlaybackSession(vi.fn());

    slot1.release!();

    const slot3 = await pool.acquirePlaybackSession(vi.fn());
    expect(slot3.ok).toBe(true);
    expect(pool.activePlaybackSessions.size).toBe(2);
  });
});
