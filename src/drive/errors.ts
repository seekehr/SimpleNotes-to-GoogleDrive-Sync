import {
  AppError,
  GoogleDriveAuthenticationError,
  GoogleDriveError,
  GoogleDriveUploadError,
  NetworkError,
  RateLimitError,
  errorMessage,
} from "../errors.js";

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);

interface ErrorShape {
  code?: string | number;
  status?: number;
  name?: string;
  message?: string;
  cause?: unknown;
  response?: {
    status?: number;
    headers?: Record<string, string> | { get?(name: string): string | null };
    data?: unknown;
  };
}

function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()];
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function statusOf(error: ErrorShape): number | undefined {
  const status = error.response?.status ?? error.status ?? (typeof error.code === "number" ? error.code : undefined);
  return typeof status === "number" ? status : undefined;
}

function apiReason(error: ErrorShape): string | undefined {
  const data = error.response?.data as { error?: { errors?: { reason?: string }[] } | string } | undefined;
  if (typeof data?.error === "string") return data.error; // OAuth errors: { error: "invalid_grant" }
  return data?.error?.errors?.[0]?.reason;
}

function networkCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 4) return undefined;
  const e = error as ErrorShape;
  if (typeof e.code === "string" && TRANSIENT_NETWORK_CODES.has(e.code)) return e.code;
  if (e.name === "AbortError" || e.name === "TimeoutError") return e.name;
  if (/socket hang up|network timeout|fetch failed/i.test(e.message ?? "")) return "NETWORK";
  return networkCode(e.cause, depth + 1);
}

export function isNotFound(error: unknown): boolean {
  if (error instanceof GoogleDriveError || error instanceof GoogleDriveUploadError) return error.details?.status === 404;
  return statusOf((error ?? {}) as ErrorShape) === 404;
}

/**
 * Maps a Google API (gaxios) failure onto the application's error classes and marks
 * which ones are worth retrying: 429/5xx, rate-limit 403s and transient network
 * failures are; bad credentials, permissions and validation errors are not.
 */
export function classifyDriveError(error: unknown, operation: string, kind: "upload" | "other" = "other"): AppError {
  if (error instanceof AppError) return error; // Already classified.
  const e = (error ?? {}) as ErrorShape;
  const status = statusOf(e);
  const reason = apiReason(e);
  const message = `${operation} failed: ${errorMessage(error)}`;
  const details = { status, reason, operation };

  if (reason === "invalid_grant" || reason === "invalid_client" || reason === "unauthorized_client" || /invalid_grant/.test(e.message ?? "")) {
    return new GoogleDriveAuthenticationError(`Google authorization is no longer valid (${reason ?? "invalid_grant"})`, {
      cause: error,
      details,
      hint: 'Run "notesync auth" to sign in again. Tokens of OAuth apps in "Testing" status expire after 7 days.',
    });
  }
  if (status === 401) {
    return new GoogleDriveAuthenticationError(`Google rejected the credentials during ${operation}`, {
      cause: error,
      details,
      hint: 'Run "notesync auth" to sign in again.',
    });
  }
  if (status === 429 || (status === 403 && reason && RATE_LIMIT_REASONS.has(reason))) {
    return new RateLimitError(`Google Drive rate limit hit during ${operation}`, {
      cause: error,
      details,
      retryAfterMs: parseRetryAfter(header(e.response?.headers, "retry-after")),
    });
  }
  if (status !== undefined && RETRYABLE_STATUS.has(status)) {
    const Ctor = kind === "upload" ? GoogleDriveUploadError : GoogleDriveError;
    return new Ctor(`${message} (HTTP ${status})`, { cause: error, details, retryable: true });
  }
  if (status === undefined) {
    const code = networkCode(error);
    if (code) return new NetworkError(`${operation} failed: network error (${code})`, { cause: error, details });
  }
  let hint: string | undefined;
  if (status === 403 && reason === "insufficientPermissions") {
    hint = 'The token lacks Drive permission. Run "notesync auth" again (check google_drive.scope).';
  } else if (status === 403 && reason === "storageQuotaExceeded") {
    hint = "Your Google Drive storage is full.";
  }
  const Ctor = kind === "upload" ? GoogleDriveUploadError : GoogleDriveError;
  return new Ctor(status ? `${message} (HTTP ${status}${reason ? `, ${reason}` : ""})` : message, {
    cause: error,
    details,
    hint,
  });
}
