const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses durations such as "30s", "5m", "1h30m" or "1500ms". A bare number is
 * interpreted in `bareUnit` (minutes by default, matching `interval_minutes`).
 * Returns undefined for anything unparseable so callers can produce their own error.
 */
export function parseDuration(input: string | number, bareUnit: keyof typeof UNITS = "m"): number | undefined {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? input * (UNITS[bareUnit] ?? 1) : undefined;
  }
  const text = input.trim().toLowerCase();
  if (text === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return parseDuration(Number(text), bareUnit);

  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|sec|min|hr|s|m|h|d)/g)) {
    total += Number(match[1]) * (UNITS[match[2] as string] ?? 0);
    consumed += match[0].length;
  }
  if (consumed !== text.replace(/\s+/g, "").length && consumed !== text.length) return undefined;
  return total > 0 ? total : undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
}
