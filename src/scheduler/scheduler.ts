import type { Logger } from "../logging/logger.js";
import { formatDuration } from "../util/duration.js";

export interface SchedulerOptions {
  intervalMs: number;
  runOnStartup: boolean;
  logger: Logger;
  /** Injection points for tests. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs a job repeatedly. Runs never overlap: the loop awaits each run before
 * scheduling the next. Ticks are aligned to the run's *start*; if a run takes
 * longer than the interval, the next one starts immediately afterwards (missed
 * ticks are not queued up).
 */
export class Scheduler {
  private readonly controller = new AbortController();
  private loop?: Promise<void>;
  private running = false;

  constructor(
    private readonly job: (signal: AbortSignal) => Promise<void>,
    private readonly options: SchedulerOptions,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): Promise<void> {
    this.loop ??= this.run();
    return this.loop;
  }

  /** Stops scheduling; resolves once an in-progress run has finished. */
  async stop(): Promise<void> {
    this.controller.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { intervalMs, logger } = this.options;
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? abortableSleep;
    const signal = this.controller.signal;

    if (!this.options.runOnStartup) await sleep(intervalMs, signal);
    while (!signal.aborted) {
      const startedAt = now();
      this.running = true;
      try {
        await this.job(signal);
      } catch (error) {
        // The job reports its own failures; the loop must survive them.
        logger.error("Scheduled synchronization failed", { error });
      } finally {
        this.running = false;
      }
      if (signal.aborted) break;

      const elapsed = now() - startedAt;
      const wait = intervalMs - elapsed;
      if (wait <= 0) {
        logger.warn("Synchronization took longer than the interval; starting the next one now", {
          took: formatDuration(elapsed),
          interval: formatDuration(intervalMs),
        });
        continue;
      }
      logger.debug("Next synchronization scheduled", { in: formatDuration(wait) });
      await sleep(wait, signal);
    }
  }
}
