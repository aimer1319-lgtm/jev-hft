// Repeats a task politely: one run at a time, slightly randomized spacing, and longer waits
// after failures. Shared by every source that has to ask "anything new?" on a timer.

/** Errors may say how long the server asked us to wait, or that retrying soon is pointless. */
export type PollError = Error & { retryAfterMs?: number; fatal?: boolean };

export type PollerOptions = {
  /** Wait after a successful run. A function, because a source may speed up or slow down. */
  intervalMs: () => number;
  run: () => Promise<void>;
  onError: (error: PollError, waitMs: number) => void;
  /** Longest wait after repeated failures (default 5 minutes). */
  maxBackoffMs?: number;
  /** Wait after a `fatal` error such as a rejected key (default 10 minutes). */
  fatalWaitMs?: number;
};

export type Poller = { close(): void };

/** How long to wait after the `failures`-th failure in a row. */
export function backoffMs(intervalMs: number, failures: number, error: PollError, maxBackoffMs = 5 * 60_000, fatalWaitMs = 10 * 60_000) {
  if (error.fatal) return fatalWaitMs;
  return Math.max(Math.min(intervalMs * 2 ** failures, maxBackoffMs), error.retryAfterMs ?? 0);
}

export function poller(opts: PollerOptions): Poller {
  let failures = 0;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  // +-10% so many feeds started together do not stay in lockstep.
  const schedule = (ms: number) => {
    if (!closed) timer = setTimeout(tick, ms * (0.9 + 0.2 * Math.random()));
  };

  async function tick() {
    try {
      await opts.run();
      failures = 0;
      schedule(opts.intervalMs());
    } catch (error) {
      failures++;
      const wait = backoffMs(opts.intervalMs(), failures, error as PollError, opts.maxBackoffMs, opts.fatalWaitMs);
      opts.onError(error as PollError, wait);
      schedule(wait);
    }
  }

  void tick();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
