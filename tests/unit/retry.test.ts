import { describe, expect, it, vi } from "vitest";
import { ConfigurationError, GoogleDriveError, NetworkError, RateLimitError } from "../../src/errors.js";
import { backoffDelay, withRetry } from "../../src/util/retry.js";

const policy = { attempts: 5, initialDelayMs: 100, maxDelayMs: 1000 };

describe("backoffDelay", () => {
  it("grows exponentially and is capped, with full jitter", () => {
    expect(backoffDelay(1, policy, () => 1)).toBe(100);
    expect(backoffDelay(2, policy, () => 1)).toBe(200);
    expect(backoffDelay(4, policy, () => 1)).toBe(800);
    expect(backoffDelay(10, policy, () => 1)).toBe(1000);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(200);
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
  });
});

describe("withRetry", () => {
  const sleeps: number[] = [];
  const opts = { ...policy, sleep: async (ms: number) => void sleeps.push(ms), random: () => 1 };

  it("retries retryable errors and then succeeds", async () => {
    sleeps.length = 0;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError("reset"))
      .mockRejectedValueOnce(new GoogleDriveError("503", { retryable: true }))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, opts)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("does not retry permanent errors", async () => {
    const fn = vi.fn().mockRejectedValue(new ConfigurationError("bad"));
    await expect(withRetry(fn, opts)).rejects.toBeInstanceOf(ConfigurationError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError("down"));
    await expect(withRetry(fn, { ...opts, attempts: 3 })).rejects.toBeInstanceOf(NetworkError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("honours Retry-After from rate-limit responses", async () => {
    sleeps.length = 0;
    const fn = vi.fn().mockRejectedValueOnce(new RateLimitError("429", { retryAfterMs: 5000 })).mockResolvedValue(1);
    await withRetry(fn, opts);
    expect(sleeps).toEqual([5000]);
  });

  it("does not retry plain unexpected errors", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("bug"));
    await expect(withRetry(fn, opts)).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
