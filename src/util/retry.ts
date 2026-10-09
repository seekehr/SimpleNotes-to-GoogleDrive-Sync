import { AppError, RateLimitError } from "../errors.js";

export interface RetryPolicy {
  /** Total attempts including the first one. */
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface RetryOptions extends RetryPolicy {
  /** Decides whether an error is worth retrying. Defaults to `AppError.retryable`. */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: { error: unknown; attempt: number; delayMs: number }) => void;
  /** Injection points for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Upper bound for honouring a server-provided Retry-After, so a bad header cannot stall us for hours. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export const defaultIsRetryable = (error: unknown): boolean =>
  error instanceof AppError && error.retryable;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with "full jitter": the delay before retry n is a uniform
 * random value in [0, min(maxDelay, initialDelay * 2^(n-1))]. Spreads retries out
 * when several uploads hit a rate limit at the same time.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const wait = options.sleep ?? sleep;
  const attempts = Math.max(1, options.attempts);

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      let delayMs = backoffDelay(attempt, options, options.random);
      if (error instanceof RateLimitError && error.retryAfterMs !== undefined) {
        delayMs = Math.max(delayMs, Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS));
      }
      options.onRetry?.({ error, attempt, delayMs });
      await wait(delayMs);
    }
  }
}
