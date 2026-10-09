import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../errors.js";
import type { LogLevel } from "../config/schema.js";
import { isSecretField, scrubText } from "./redact.js";

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
  isLevelEnabled(level: LogLevel): boolean;
}

export interface LogSink {
  write(level: Exclude<LogLevel, "silent">, timestamp: string, message: string, fields: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Local time "YYYY-MM-DD HH:mm:ss" — what a person reading the log on this machine expects. */
export function formatTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function formatValue(value: unknown): string {
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (value instanceof Error) text = value.message;
  else if (typeof value === "object" && value !== null) text = JSON.stringify(value);
  else text = String(value);
  text = scrubText(text);
  return /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text);
}

/** Renders fields as logfmt (`key=value key2="with space"`), masking secrets. */
export function formatFields(fields: Fields): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (isSecretField(key)) {
      parts.push(`${key}=***`);
      continue;
    }
    if (value instanceof Error) {
      parts.push(`${key}=${formatValue(value.message)}`);
      if (value instanceof AppError) parts.push(`code=${value.code}`);
      continue;
    }
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

class StructuredLogger implements Logger {
  constructor(
    private readonly threshold: number,
    private readonly sinks: LogSink[],
    private readonly bound: Fields = {},
  ) {}

  private log(level: Exclude<LogLevel, "silent">, message: string, fields?: Fields): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const rendered = formatFields({ ...this.bound, ...fields });
    const timestamp = formatTimestamp(new Date());
    const text = scrubText(message);
    for (const sink of this.sinks) {
      try {
        sink.write(level, timestamp, text, rendered);
      } catch {
        // A failing sink (e.g. full disk) must never take the sync down with it.
      }
    }
  }

  debug(message: string, fields?: Fields) { this.log("debug", message, fields); }
  info(message: string, fields?: Fields) { this.log("info", message, fields); }
  warn(message: string, fields?: Fields) { this.log("warn", message, fields); }
  error(message: string, fields?: Fields) { this.log("error", message, fields); }

  child(fields: Fields): Logger {
    return new StructuredLogger(this.threshold, this.sinks, { ...this.bound, ...fields });
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= this.threshold;
  }
}

const line = (level: string, timestamp: string, message: string, fields: string) =>
  `${timestamp} ${level.toUpperCase().padEnd(5)} ${message}${fields ? ` ${fields}` : ""}`;

export class ConsoleSink implements LogSink {
  private readonly color: boolean;
  constructor(private readonly stream: NodeJS.WriteStream = process.stderr) {
    this.color = Boolean(stream.isTTY) && !process.env.NO_COLOR;
  }
  write(level: Exclude<LogLevel, "silent">, timestamp: string, message: string, fields: string): void {
    let text = line(level, timestamp, message, fields);
    if (this.color) {
      const code = { debug: 90, info: 0, warn: 33, error: 31 }[level];
      if (code) text = `\x1b[${code}m${text}\x1b[0m`;
    }
    this.stream.write(`${text}\n`);
  }
}

/**
 * Appends to a log file and rotates by size: sync.log → sync.log.1 → … → sync.log.N.
 * Writes are synchronous so the last lines before a crash are on disk.
 */
export class RotatingFileSink implements LogSink {
  private size: number;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.size = existsSync(path) ? statSync(path).size : 0;
  }

  write(level: Exclude<LogLevel, "silent">, timestamp: string, message: string, fields: string): void {
    const data = `${line(level, timestamp, message, fields)}\n`;
    const bytes = Buffer.byteLength(data);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.path, data, "utf8");
    this.size += bytes;
  }

  private rotate(): void {
    try {
      rmSync(`${this.path}.${this.maxFiles}`, { force: true });
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
      this.size = 0;
    } catch {
      // Another process may hold the file (e.g. a viewer on Windows). Keep appending;
      // rotation is retried on the next write.
      this.size = existsSync(this.path) ? statSync(this.path).size : 0;
    }
  }
}

/** Captures log lines in memory — used by tests and by `doctor` output. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(level: Exclude<LogLevel, "silent">, timestamp: string, message: string, fields: string): void {
    this.lines.push(line(level, timestamp, message, fields));
  }
}

export interface LoggerOptions {
  level: LogLevel;
  console: boolean;
  file?: string;
  maxSizeMb?: number;
  maxFiles?: number;
  extraSinks?: LogSink[];
}

export function createLogger(options: LoggerOptions): Logger {
  const sinks: LogSink[] = [...(options.extraSinks ?? [])];
  if (options.console) sinks.push(new ConsoleSink());
  if (options.file) {
    sinks.push(new RotatingFileSink(options.file, (options.maxSizeMb ?? 5) * 1024 * 1024, options.maxFiles ?? 5));
  }
  return new StructuredLogger(LEVEL_ORDER[options.level], sinks);
}

export const nullLogger: Logger = createLogger({ level: "silent", console: false });
