import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockError, StateFileError } from "../../src/errors.js";
import { MemorySink, createLogger } from "../../src/logging/logger.js";
import { acquireLock, inspectLock } from "../../src/state/lock.js";
import { StateRepository } from "../../src/state/stateRepository.js";
import { emptyState } from "../../src/state/types.js";
import { writeFileAtomic } from "../../src/util/fs.js";
import { tempDir } from "../helpers/harness.js";

let cleanup: () => void = () => {};
afterEach(() => cleanup());

function setup() {
  const t = tempDir();
  cleanup = t.cleanup;
  const sink = new MemorySink();
  const repo = new StateRepository(join(t.dir, "state.json"), createLogger({ level: "debug", console: false, extraSinks: [sink] }));
  return { dir: t.dir, repo, sink };
}

const sampleState = () => {
  const state = emptyState();
  state.notes["note-1"] = {
    title: "Project Notes",
    filename: "Project Notes.docx",
    contentHash: "abc123",
    renderFingerprint: "fp",
    tags: [],
    remoteFileId: "1XYZ",
    lastSynced: "2026-10-10T03:00:00Z",
    status: "synced",
  };
  return state;
};

describe("StateRepository", () => {
  it("starts empty when no state exists", async () => {
    const { repo } = setup();
    const { state, source } = await repo.load();
    expect(source).toBe("new");
    expect(state.notes).toEqual({});
  });

  it("round-trips state through disk", async () => {
    const { repo } = setup();
    await repo.save(sampleState());
    const { state, source } = await repo.load();
    expect(source).toBe("file");
    expect(state.notes["note-1"]).toMatchObject({ contentHash: "abc123", remoteFileId: "1XYZ", filename: "Project Notes.docx" });
  });

  it("writes atomically and leaves no temp files behind", async () => {
    const { repo, dir } = setup();
    await Promise.all([repo.save(sampleState()), repo.save(emptyState()), repo.save(sampleState())]);
    expect(readdirSync(dir).filter((f) => f.includes("tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(repo.path, "utf8")).notes["note-1"]).toBeDefined();
  });

  it("recovers from a corrupt state file using the backup and quarantines the corrupt file", async () => {
    const { repo, dir, sink } = setup();
    await repo.save(sampleState());
    await repo.load(); // creates the .bak
    writeFileSync(repo.path, '{"version":1,"notes":{"trunc');
    const { state, source } = await repo.load();
    expect(source).toBe("backup");
    expect(state.notes["note-1"]?.remoteFileId).toBe("1XYZ");
    expect(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
    expect(sink.lines.join("\n")).toContain("State file is corrupt");
  });

  it("starts empty (relying on Drive re-linking) when both file and backup are unusable", async () => {
    const { repo } = setup();
    writeFileSync(repo.path, "not json at all");
    writeFileSync(repo.backupPath, "{ also broken");
    const { state, source } = await repo.load();
    expect(source).toBe("recovered-empty");
    expect(state.notes).toEqual({});
  });

  it("rejects structurally invalid state as corrupt", async () => {
    const { repo } = setup();
    writeFileSync(repo.path, JSON.stringify({ version: 1, notes: { x: { filename: 5 } } }));
    const { source } = await repo.load();
    expect(source).toBe("recovered-empty");
  });

  it("refuses to touch state written by a newer version", async () => {
    const { repo } = setup();
    writeFileSync(repo.path, JSON.stringify({ version: 99, notes: {} }));
    await expect(repo.load()).rejects.toBeInstanceOf(StateFileError);
    expect(existsSync(repo.path)).toBe(true);
  });

  it("peek() never modifies files", async () => {
    const { repo, dir } = setup();
    writeFileSync(repo.path, "corrupt");
    await expect(repo.peek()).rejects.toBeInstanceOf(StateFileError);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

describe("writeFileAtomic", () => {
  it("replaces the target in one step", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const target = join(t.dir, "nested", "file.txt");
    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two");
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(readdirSync(join(t.dir, "nested"))).toEqual(["file.txt"]);
  });
});

describe("sync lock", () => {
  it("prevents a second concurrent holder", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const path = join(t.dir, "sync.lock");
    const lock = await acquireLock(path);
    await expect(acquireLock(path)).rejects.toBeInstanceOf(LockError);
    expect((await inspectLock(path))?.alive).toBe(true);
    await lock.release();
    expect(existsSync(path)).toBe(false);
    const again = await acquireLock(path);
    await again.release();
  });

  it("takes over a lock left by a dead process", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const path = join(t.dir, "sync.lock");
    const { hostname } = await import("node:os");
    writeFileSync(path, JSON.stringify({ pid: 999999, hostname: hostname(), startedAt: new Date().toISOString(), token: "x" }));
    const lock = await acquireLock(path);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("takes over a lock older than the stale threshold", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const path = join(t.dir, "sync.lock");
    const { hostname } = await import("node:os");
    writeFileSync(path, JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: "2000-01-01T00:00:00Z", token: "x" }));
    const lock = await acquireLock(path);
    await lock.release();
  });
});
