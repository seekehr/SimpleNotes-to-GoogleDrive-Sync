import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, redactConfig } from "../../src/config/load.js";
import { ConfigurationError } from "../../src/errors.js";
import { formatDuration } from "../../src/util/duration.js";
import { tempDir } from "../helpers/harness.js";

let cleanup: () => void = () => {};
afterEach(() => cleanup());

function home(yaml?: string) {
  const t = tempDir();
  cleanup = t.cleanup;
  if (yaml !== undefined) {
    mkdirSync(join(t.dir, "config"));
    writeFileSync(join(t.dir, "config", "config.yaml"), yaml);
  }
  return t.dir;
}

describe("loadConfig", () => {
  it("uses safe defaults without a config file", () => {
    const dir = home();
    const config = loadConfig({ env: { SNSYNC_HOME: dir } });
    expect(config.meta.configFileFound).toBe(false);
    expect(config.sync.deleted_notes).toBe("keep");
    expect(config.simplenote.scraper_command).toBe("simplenotesscraper");
    expect(config.google_drive.scope).toBe("drive.file");
  });

  it("resolves relative paths against the application home, not the cwd", () => {
    const dir = home();
    const config = loadConfig({ env: { SNSYNC_HOME: dir } });
    expect(config.state.file).toBe(join(dir, "data", "state.json"));
    expect(config.simplenote.output_dir).toBe(join(dir, "data", "scraper", "output"));
  });

  it("applies priority: CLI > environment > file > defaults", () => {
    const dir = home("sync:\n  max_concurrent_uploads: 5\n  deleted_notes: archive\nlogging:\n  level: warn\n");
    const env = { SNSYNC_HOME: dir, SNSYNC_MAX_CONCURRENT_UPLOADS: "2", SNSYNC_LOG_LEVEL: "error" };
    const fileOnly = loadConfig({ env: { SNSYNC_HOME: dir } });
    expect(fileOnly.sync.max_concurrent_uploads).toBe(5);
    const withEnv = loadConfig({ env });
    expect(withEnv.sync.max_concurrent_uploads).toBe(2);
    expect(withEnv.logging.level).toBe("error");
    expect(withEnv.sync.deleted_notes).toBe("archive");
    expect(withEnv.meta.envOverrides).toEqual(expect.arrayContaining(["SNSYNC_MAX_CONCURRENT_UPLOADS", "SNSYNC_LOG_LEVEL"]));
    const withCli = loadConfig({ env, cliOverrides: { logging: { level: "debug" } } });
    expect(withCli.logging.level).toBe("debug");
  });

  it("supports the documented SNSYNC_* variables", () => {
    const dir = home();
    const config = loadConfig({
      env: {
        SNSYNC_HOME: dir,
        SNSYNC_GOOGLE_FOLDER_ID: "folder123",
        SNSYNC_SCRAPER_ENV_DIR: "D:\\scraper",
        SNSYNC_KEEP_LOCAL_DOCX: "false",
      },
    });
    expect(config.google_drive.folder_id).toBe("folder123");
    expect(config.simplenote.env_dir).toBe("D:\\scraper");
    expect(config.output.keep_local_docx).toBe(false);
  });

  it("reports invalid values with their path", () => {
    const dir = home("sync:\n  deleted_notes: shred\n  max_concurrent_uploads: 0\n");
    expect(() => loadConfig({ env: { SNSYNC_HOME: dir } })).toThrowError(/sync\.deleted_notes[\s\S]*sync\.max_concurrent_uploads/);
  });

  it("rejects unknown keys so typos are caught", () => {
    const dir = home("sync:\n  deleted_note: keep\n");
    expect(() => loadConfig({ env: { SNSYNC_HOME: dir } })).toThrowError(/deleted_note/);
  });

  it("rejects malformed YAML and bad environment values clearly", () => {
    const dir = home("sync: [unclosed");
    expect(() => loadConfig({ env: { SNSYNC_HOME: dir } })).toThrow(ConfigurationError);
    const dir2 = home();
    expect(() => loadConfig({ env: { SNSYNC_HOME: dir2, SNSYNC_MAX_CONCURRENT_UPLOADS: "many" } })).toThrowError(/SNSYNC_MAX_CONCURRENT_UPLOADS/);
  });

  it("requires an explicitly named config file to exist", () => {
    const dir = home();
    expect(() => loadConfig({ env: { SNSYNC_HOME: dir }, configPath: join(dir, "missing.yaml") })).toThrowError(/not found/);
  });

  it("redacts secret-looking values", () => {
    expect(redactConfig({ a: { client_secret: "s3cr3t", token_store: "auto", refresh_token: "1//abc" } })).toEqual({
      a: { client_secret: "***redacted***", token_store: "auto", refresh_token: "***redacted***" },
    });
  });
});

describe("formatDuration", () => {
  it("formats durations for humans", () => {
    expect(formatDuration(8700)).toBe("8.70s");
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(450)).toBe("450ms");
  });
});
