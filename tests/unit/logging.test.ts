import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleDriveUploadError } from "../../src/errors.js";
import { MemorySink, RotatingFileSink, createLogger, formatFields } from "../../src/logging/logger.js";
import { registerSecret, scrubText } from "../../src/logging/redact.js";
import { tempDir } from "../helpers/harness.js";

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe("structured logging", () => {
  it("formats lines as timestamp, level, message and logfmt fields", () => {
    const sink = new MemorySink();
    const logger = createLogger({ level: "info", console: false, extraSinks: [sink] });
    logger.info("Uploaded document", { title: "Project Notes", drive_file_id: "abc" });
    logger.debug("hidden");
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO  Uploaded document title="Project Notes" drive_file_id=abc$/);
  });

  it("adds error codes and bound context", () => {
    const sink = new MemorySink();
    const logger = createLogger({ level: "debug", console: false, extraSinks: [sink] }).child({ run: 7 });
    logger.error("failed", { error: new GoogleDriveUploadError("boom") });
    expect(sink.lines[0]).toContain("run=7 error=boom code=DRIVE_UPLOAD");
  });

  it("never logs secret fields or token-shaped values", () => {
    registerSecret("my-client-secret-value");
    const text = formatFields({
      refresh_token: "1//0gABCDEFGHIJKLMNOPQRSTUVWXYZ",
      password: "hunter2",
      client_secret: "x",
      message: "Bearer ya29.a0AfH6SMBxyz and my-client-secret-value and GOCSPX-abcdef",
      token_store: "keyring",
    });
    expect(text).not.toContain("ya29");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("1//0g");
    expect(text).not.toContain("my-client-secret-value");
    expect(text).not.toContain("GOCSPX-abcdef");
    expect(text).toContain("token_store=keyring");
    expect(scrubText("https://x/cb?code=4/0AbCd&state=1")).toBe("https://x/cb?code=***&state=1");
    expect(scrubText('{"refresh_token": "1//zzzzzzzzzzzzzzzzzzzzzzzz"}')).not.toContain("1//z");
  });

  it("rotates the log file when it exceeds the size limit", () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const path = join(t.dir, "logs", "sync.log");
    const sink = new RotatingFileSink(path, 400, 2);
    for (let i = 0; i < 40; i++) sink.write("info", "2026-01-01 00:00:00", `message number ${i} with some padding`, "");
    expect(statSync(path).size).toBeLessThanOrEqual(400);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("message number 39");
  });
});
