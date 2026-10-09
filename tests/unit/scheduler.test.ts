import { describe, expect, it } from "vitest";
import { MemorySink, createLogger } from "../../src/logging/logger.js";
import { Scheduler } from "../../src/scheduler/scheduler.js";

describe("Scheduler", () => {
  it("never runs jobs concurrently even when a run outlasts the interval", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const sink = new MemorySink();
    const scheduler = new Scheduler(
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        runs++;
        await new Promise((r) => setTimeout(r, 30)); // longer than the 10ms interval
        active--;
        if (runs === 4) void scheduler.stop();
      },
      { intervalMs: 10, runOnStartup: true, logger: createLogger({ level: "debug", console: false, extraSinks: [sink] }) },
    );
    await scheduler.start();
    expect(runs).toBe(4);
    expect(maxActive).toBe(1);
    expect(sink.lines.some((l) => l.includes("took longer than the interval"))).toBe(true);
  });

  it("waits for the interval between short runs and survives job failures", async () => {
    const waits: number[] = [];
    let runs = 0;
    let time = 0;
    const scheduler = new Scheduler(
      async () => {
        runs++;
        time += 100;
        if (runs === 1) throw new Error("transient");
        if (runs === 3) void scheduler.stop();
      },
      {
        intervalMs: 1000,
        runOnStartup: true,
        logger: createLogger({ level: "silent", console: false }),
        now: () => time,
        sleep: async (ms) => {
          waits.push(ms);
          time += ms;
        },
      },
    );
    await scheduler.start();
    expect(runs).toBe(3);
    expect(waits).toEqual([900, 900]);
  });

  it("waits one interval first when run_on_startup is off", async () => {
    const waits: number[] = [];
    const scheduler = new Scheduler(async () => void scheduler.stop(), {
      intervalMs: 500,
      runOnStartup: false,
      logger: createLogger({ level: "silent", console: false }),
      sleep: async (ms) => void waits.push(ms),
    });
    await scheduler.start();
    expect(waits[0]).toBe(500);
  });
});
