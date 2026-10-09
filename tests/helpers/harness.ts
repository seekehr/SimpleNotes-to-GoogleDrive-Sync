import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigOverrides, type ResolvedConfig, loadConfig } from "../../src/config/load.js";
import { DocxRenderer } from "../../src/docx/converter.js";
import { GoogleDriveStore } from "../../src/drive/googleDriveStore.js";
import { MemorySink, createLogger } from "../../src/logging/logger.js";
import type { Note } from "../../src/notes/note.js";
import type { FetchResult, NoteLoadFailure, NoteSource } from "../../src/notes/source.js";
import { StateRepository } from "../../src/state/stateRepository.js";
import { SyncEngine } from "../../src/sync/engine.js";
import { FakeDrive } from "./fakeDrive.js";

export function tempDir(prefix = "notesync-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(home: string, overrides: ConfigOverrides = {}): ResolvedConfig {
  return loadConfig({
    env: { SNSYNC_HOME: home },
    cliOverrides: {
      logging: { console: false, file: "", level: "debug" },
      retry: { attempts: 3, initial_delay_seconds: 0.001, max_delay_seconds: 0.002 },
      ...overrides,
    },
  });
}

export function note(id: string, content: string, extra: Partial<Note> = {}): Note {
  const firstLine = content.split("\n").find((l) => l.trim()) ?? "Untitled";
  return {
    id,
    title: firstLine.replace(/^#+\s*/, ""),
    content,
    tags: [],
    systemTags: ["markdown"],
    isMarkdown: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    revision: "1",
    ...extra,
  };
}

export class FakeSource implements NoteSource {
  notes: Note[] = [];
  failures: NoteLoadFailure[] = [];
  complete = true;
  calls = 0;
  fail?: Error;

  async fetchNotes(): Promise<FetchResult> {
    this.calls++;
    if (this.fail) throw this.fail;
    return { notes: [...this.notes], failures: [...this.failures], complete: this.complete, warnings: [], durationMs: 1 };
  }
}

export interface Harness {
  config: ResolvedConfig;
  drive: FakeDrive;
  source: FakeSource;
  engine: SyncEngine;
  state: StateRepository;
  logs: MemorySink;
  dir: string;
  cleanup: () => void;
  sync: (opts?: { dryRun?: boolean; force?: boolean }) => ReturnType<SyncEngine["run"]>;
  folderId: () => string;
  /** Rebuild the engine (e.g. after changing config), keeping drive + data dir. */
  rebuild: (overrides?: ConfigOverrides) => void;
}

export function createHarness(overrides: ConfigOverrides = {}): Harness {
  const { dir, cleanup } = tempDir();
  const drive = new FakeDrive();
  const source = new FakeSource();
  const logs = new MemorySink();
  const h = { dir, cleanup, drive, source, logs } as Harness;

  h.rebuild = (more: ConfigOverrides = {}) => {
    const merged: ConfigOverrides = { ...overrides };
    for (const [k, v] of Object.entries(more)) merged[k] = { ...(merged[k] ?? {}), ...v };
    h.config = testConfig(dir, merged);
    const logger = createLogger({ level: "debug", console: false, extraSinks: [logs] });
    h.state = new StateRepository(h.config.state.file, logger);
    const store = new GoogleDriveStore({
      settings: h.config.google_drive,
      retry: { attempts: 5, initialDelayMs: 1, maxDelayMs: 2 },
      logger,
      api: drive.api(),
    });
    h.engine = new SyncEngine({
      config: h.config,
      source,
      renderer: new DocxRenderer(h.config.document),
      remote: async () => store,
      stateRepository: h.state,
      logger,
    });
  };
  h.rebuild();
  h.sync = (opts = {}) => h.engine.run({ dryRun: Boolean(opts.dryRun), force: Boolean(opts.force) });
  h.folderId = () => drive.folderByName("Simplenote")?.id ?? "";
  return h;
}
