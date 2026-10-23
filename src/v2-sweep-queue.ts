const SWEEP_QUEUE_KEY = Symbol.for("opencode-sweeper.v2.sweep-queue");

type SweepQueueState = {
  tail: Promise<void>;
  id: string;
};

// One queue per JS realm. Symbol.for + globalThis keeps separate module copies
// (cache-busted imports, duplicate artifacts) on the same queue.
const queueHost = globalThis as typeof globalThis & {
  [key: symbol]: SweepQueueState | undefined;
};
// biome-ignore lint/suspicious/noAssignInExpressions: synchronous realm-wide initialization is the point
const sharedQueue: SweepQueueState = (queueHost[SWEEP_QUEUE_KEY] ??= {
  tail: Promise.resolve(),
  id: crypto.randomUUID(),
});

export const sweepQueueID = sharedQueue.id;

function waitForPrevious(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("sweep aborted"));

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("sweep aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    // sharedQueue.tail only ever resolves, so no rejection handler is needed.
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Run one full sweep at a time across every location in this JS realm.
 * Wait cancellation only abandons this waiter; once the callback starts, its
 * original signal owns cancellation and the gate stays held until it settles.
 */
export async function runSweepExclusive<T>(
  callback: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();

  const previous = sharedQueue.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  sharedQueue.tail = previous.then(() => gate);

  try {
    await waitForPrevious(previous, signal);
    signal.throwIfAborted();
    return await callback();
  } finally {
    release();
  }
}
