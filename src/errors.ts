/**
 * Error hierarchy. Every error raised by the application derives from AppError so
 * callers can branch on `code`, decide whether to retry (`retryable`) and show the
 * user an actionable `hint` without string-matching messages.
 */

export interface AppErrorOptions {
  cause?: unknown;
  hint?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class ConfigurationError extends AppError {
  readonly code = "CONFIGURATION";
}

export class ScraperNotFoundError extends AppError {
  readonly code = "SCRAPER_NOT_FOUND";
}

export class ScraperExecutionError extends AppError {
  readonly code = "SCRAPER_EXECUTION";
}

export class ScraperTimeoutError extends AppError {
  readonly code = "SCRAPER_TIMEOUT";
}

/** The scraper ran but its output could not be understood. */
export class ScraperOutputError extends AppError {
  readonly code = "SCRAPER_OUTPUT";
}

export class MarkdownConversionError extends AppError {
  readonly code = "MARKDOWN_CONVERSION";
}

export class DocxGenerationError extends AppError {
  readonly code = "DOCX_GENERATION";
}

export class GoogleDriveAuthenticationError extends AppError {
  readonly code = "DRIVE_AUTH";
}

export class GoogleDriveUploadError extends AppError {
  readonly code = "DRIVE_UPLOAD";
}

/** Any other Drive API failure that is not an upload (listing, trashing, folders...). */
export class GoogleDriveError extends AppError {
  readonly code = "DRIVE";
}

export class StateFileError extends AppError {
  readonly code = "STATE_FILE";
}

export class LockError extends AppError {
  readonly code = "LOCKED";
}

export class NetworkError extends AppError {
  readonly code = "NETWORK";
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { retryable: true, ...options });
  }
}

export class RateLimitError extends AppError {
  readonly code = "RATE_LIMIT";
  /** Server-suggested wait before retrying, if the response provided one. */
  readonly retryAfterMs?: number;
  constructor(message: string, options: AppErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, { retryable: true, ...options });
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Process exit codes. Documented in the README; keep them stable for Task Scheduler users. */
export const ExitCode = {
  Success: 0,
  /** Sync finished but at least one note failed. */
  PartialFailure: 1,
  /** Unexpected / unclassified fatal error. */
  Fatal: 2,
  Configuration: 3,
  Authentication: 4,
  /** Another sync currently holds the lock. */
  Locked: 5,
  Scraper: 6,
} as const;

export function exitCodeFor(error: unknown): number {
  if (error instanceof ConfigurationError) return ExitCode.Configuration;
  if (error instanceof GoogleDriveAuthenticationError) return ExitCode.Authentication;
  if (error instanceof LockError) return ExitCode.Locked;
  if (
    error instanceof ScraperExecutionError ||
    error instanceof ScraperTimeoutError ||
    error instanceof ScraperNotFoundError ||
    error instanceof ScraperOutputError
  ) {
    return ExitCode.Scraper;
  }
  return ExitCode.Fatal;
}
