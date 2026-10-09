import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config/schema.js";
import {
  AppError,
  ScraperExecutionError,
  ScraperNotFoundError,
  ScraperOutputError,
  ScraperTimeoutError,
  errorMessage,
} from "../errors.js";
import type { Logger } from "../logging/logger.js";
import { scrubText } from "../logging/redact.js";
import type { Note } from "../notes/note.js";
import type { FetchResult, NoteLoadFailure, NoteSource } from "../notes/source.js";
import { formatDuration } from "../util/duration.js";
import { ensureDir, isDirectory, pathExists } from "../util/fs.js";
import { InspectParseError, TruncatedItems, TruncatedString, parseInspectValue } from "./inspectParser.js";
import { type ScrapedRecord, scraperFileName, toNote, toScrapedRecord } from "./normalize.js";
import { type ProcessResult, type RunProcessOptions, SpawnFailure, resolveExecutable, runProcess } from "./process.js";

export type ScraperSettings = AppConfig["simplenote"];

export interface ScraperDeps {
  runProcess: (options: RunProcessOptions) => Promise<ProcessResult>;
  resolveExecutable: (command: string) => Promise<string | undefined>;
}

const defaultDeps: ScraperDeps = { runProcess, resolveExecutable: (c) => resolveExecutable(c) };

/** Marker line printed by SimpleNotesScraper before the note listing. */
const NOTES_MARKER = /^NOTES:\r?$/m;

const tail = (text: string, max: number): string => {
  const trimmed = text.trim();
  return scrubText(trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed);
};

/** Status lines printed before the listing (connected / RECV / closed) — never note content. */
function statusLines(stdout: string): string {
  const marker = stdout.search(NOTES_MARKER);
  const head = marker >= 0 ? stdout.slice(0, marker) : stdout;
  return tail(
    head
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.startsWith("authenticated as"))
      .join("\n"),
    800,
  );
}

export interface ParsedListing {
  records: ScrapedRecord[];
  /** Number of notes cut off by util.inspect's array limit (0 = listing complete). */
  missingCount: number;
  warnings: string[];
}

/** Extracts and validates the `NOTES:` listing from the scraper's stdout. */
export function parseScraperListing(stdout: string): ParsedListing {
  const marker = stdout.search(NOTES_MARKER);
  if (marker < 0) {
    throw new ScraperExecutionError("SimpleNotesScraper finished without printing a NOTES listing", {
      // Most often a dropped websocket; worth another attempt.
      retryable: true,
      hint: "Usually an authentication or network problem. Check TOKEN/GMAIL in the scraper's .env and run the scraper manually.",
      details: { status: statusLines(stdout) },
    });
  }
  const start = stdout.indexOf("[", marker);
  if (start < 0) throw new ScraperOutputError("NOTES listing is missing its opening '['");

  let value: unknown;
  try {
    value = parseInspectValue(stdout, start).value;
  } catch (error) {
    const where = error instanceof InspectParseError ? ` (offset ${error.position})` : "";
    throw new ScraperOutputError(`Could not parse the scraper's NOTES listing${where}: ${errorMessage(error)}`, {
      cause: error,
      hint: "The SimpleNotesScraper output format may have changed.",
    });
  }
  if (!Array.isArray(value)) throw new ScraperOutputError("NOTES listing is not an array");

  const records: ScrapedRecord[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let missingCount = 0;
  value.forEach((entry, index) => {
    if (entry instanceof TruncatedItems) {
      missingCount += entry.remaining;
      return;
    }
    const record = toScrapedRecord(entry, index);
    if (seen.has(record.id)) {
      warnings.push(`Duplicate note id ${record.id} in scraper listing; keeping the first entry`);
      return;
    }
    seen.add(record.id);
    records.push(record);
  });
  return { records, missingCount, warnings };
}

/**
 * Adapter around the `simplenotesscraper` CLI.
 *
 * Observed contract of the scraper (see README "SimpleNotesScraper integration"):
 *  - deletes and recreates `<cwd>/output`, then writes `<sanitized title>.txt` per note;
 *  - prints a `NOTES:` listing via console.dir with id/version/tags/dates/content;
 *    console.dir truncates strings longer than 10,000 characters and arrays longer than 100;
 *  - exits 0 even when the websocket fails, so success is judged by the listing itself.
 *
 * Content comes from the listing when complete, else from the .txt file, which is
 * verified against the truncated prefix and length so a title collision can never
 * attach one note's text to another.
 */
export class SimpleNotesScraperSource implements NoteSource {
  private readonly deps: ScraperDeps;

  constructor(
    private readonly settings: ScraperSettings,
    private readonly logger: Logger,
    deps: Partial<ScraperDeps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Validates executable and directories. Returns the resolved executable path. */
  async preflight(): Promise<string> {
    const { env_dir, scraper_command } = this.settings;
    if (!(await isDirectory(env_dir))) {
      throw new ScraperExecutionError(`Scraper environment directory does not exist: ${env_dir}`, {
        hint: "Set simplenote.env_dir (or SNSYNC_SCRAPER_ENV_DIR) to the folder containing the scraper's .env file.",
      });
    }
    if (!(await pathExists(join(env_dir, ".env")))) {
      this.logger.warn("Scraper environment directory has no .env file; the scraper will rely on process environment", {
        env_dir,
      });
    }
    const executable = await this.deps.resolveExecutable(scraper_command);
    if (!executable) {
      throw new ScraperNotFoundError(`SimpleNotesScraper executable not found: "${scraper_command}"`, {
        hint:
          'Run "npm link" inside the SimpleNotesScraper project so "simplenotesscraper" is on PATH, ' +
          "or set simplenote.scraper_command to the full path of the executable.",
      });
    }
    return executable;
  }

  async run(): Promise<{ result: ProcessResult; executable: string }> {
    const executable = await this.preflight();
    const { work_dir, env_dir, scraper_args, timeout_seconds } = this.settings;
    await ensureDir(work_dir);
    const args = ["--env-dir", env_dir, ...scraper_args];
    this.logger.debug("Running SimpleNotesScraper", { executable, cwd: work_dir, timeout_seconds });

    let result: ProcessResult;
    try {
      result = await this.deps.runProcess({ command: executable, args, cwd: work_dir, timeoutMs: timeout_seconds * 1000 });
    } catch (error) {
      if (error instanceof SpawnFailure && error.errno === "ENOENT") {
        throw new ScraperNotFoundError(`Could not start SimpleNotesScraper (${executable}): ${error.message}`, { cause: error });
      }
      throw new ScraperExecutionError(`Could not run SimpleNotesScraper: ${errorMessage(error)}`, { cause: error });
    }

    if (result.timedOut) {
      throw new ScraperTimeoutError(`SimpleNotesScraper did not finish within ${timeout_seconds}s and was stopped`, {
        retryable: true,
        hint: "Increase simplenote.timeout_seconds, or check network access to Simplenote.",
        details: { stderr: tail(result.stderr, 1000), status: statusLines(result.stdout) },
      });
    }
    if (result.exitCode !== 0) {
      throw new ScraperExecutionError(
        `SimpleNotesScraper exited with code ${result.exitCode ?? `signal ${result.signal}`}: ${tail(result.stderr, 600) || "(no stderr)"}`,
        { details: { status: statusLines(result.stdout) } },
      );
    }
    for (const line of result.stderr.split(/\r?\n/)) {
      if (line.trim()) this.logger.debug("scraper stderr", { line: scrubText(line.trim()).slice(0, 300) });
    }
    return { result, executable };
  }

  async fetchNotes(): Promise<FetchResult> {
    const { result } = await this.run();
    const listing = parseScraperListing(result.stdout);
    if (/ws error/i.test(result.stderr)) {
      listing.warnings.push(`Scraper reported a websocket error: ${tail(result.stderr, 300)}`);
    }
    if (listing.missingCount > 0) {
      listing.warnings.push(
        `Scraper listing was truncated: ${listing.missingCount} note(s) not visible this run. ` +
          "Deletions are skipped. See README (\"More than 100 notes\") for the one-line scraper fix.",
      );
    }

    const notes: Note[] = [];
    const failures: NoteLoadFailure[] = [];
    for (const record of listing.records) {
      try {
        notes.push(toNote(record, await this.resolveContent(record)));
      } catch (error) {
        const appError =
          error instanceof AppError ? error : new ScraperOutputError(errorMessage(error), { cause: error });
        const title = typeof record.scraperTitle === "string" ? record.scraperTitle : record.scraperTitle.prefix;
        failures.push({ id: record.id, title: title.slice(0, 120), error: appError });
      }
    }

    this.logger.info("SimpleNotesScraper completed", {
      notes: notes.length + failures.length,
      duration: formatDuration(result.durationMs),
    });
    for (const warning of listing.warnings) this.logger.warn(warning);

    return {
      notes,
      failures,
      complete: listing.missingCount === 0,
      warnings: listing.warnings,
      durationMs: result.durationMs,
    };
  }

  /** Full note text: from the listing, or from the scraper's .txt when the listing truncated it. */
  private async resolveContent(record: ScrapedRecord): Promise<string> {
    if (typeof record.content === "string") return record.content;

    const truncated = record.content;
    if (record.scraperTitle instanceof TruncatedString) {
      throw new ScraperOutputError("Note title and content are both truncated in the scraper listing; cannot locate its file");
    }
    const file = join(this.settings.output_dir, `${scraperFileName(record.scraperTitle)}.txt`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new ScraperOutputError(`Long note's output file is missing (${file})`, { cause: error });
    }
    if (!text.startsWith(truncated.prefix) || text.length !== truncated.fullLength) {
      throw new ScraperOutputError(
        "Long note's output file does not match the listing — another note with the same title probably overwrote it",
        { hint: "Give the notes distinct first lines in Simplenote; the scraper names files by title." },
      );
    }
    return text;
  }
}
