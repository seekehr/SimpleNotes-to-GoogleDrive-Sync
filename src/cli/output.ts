import { AppError } from "../errors.js";
import type { SyncReport } from "../sync/types.js";
import { formatDuration } from "../util/duration.js";

/** Human-facing output goes to stdout; logs go to stderr and the log file. */
export const print = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const row = (label: string, value: string | number, width = 24): string => {
  const text = String(value);
  return `${label}:${" ".repeat(Math.max(1, width - label.length - text.length))}${text}`;
};

const quoted = (title: string) => `"${title.length > 70 ? `${title.slice(0, 69)}…` : title}"`;

export function formatReport(report: SyncReport, verbose: boolean): string {
  const lines: string[] = [];
  const c = report.counts;
  lines.push(report.dryRun ? "Dry run complete — no changes were made" : report.aborted ? "Synchronization interrupted" : "Synchronization complete");
  if (report.folder) lines.push(`Destination: ${report.folder}`);
  lines.push("");
  lines.push(row("Notes discovered", c.discovered));
  if (c.filtered) lines.push(row("Skipped by filter", c.filtered));
  lines.push(row("New", c.new));
  lines.push(row("Updated", c.updated));
  if (c.renamed) lines.push(row(`Renamed`, c.renamed));
  lines.push(row("Unchanged", c.unchanged));
  lines.push(row(`Deleted remotely`, report.dryRun ? report.deletions.filter((d) => d.policy !== "keep").length : c.deleted));
  if (report.deletionsSkipped) lines.push(row("Deletions held back", report.deletionsSkipped));
  if (c.duplicates) lines.push(row("Duplicates found", c.duplicates));
  lines.push(row("Failed", c.failed));
  lines.push("");
  lines.push(`Duration: ${formatDuration(report.durationMs)}`);

  const changes = report.notes.filter((n) => n.status !== "failed" && n.status !== "skipped" && n.action !== "unchanged");
  if (report.dryRun || verbose) {
    const shown = verbose ? report.notes.filter((n) => n.status !== "failed") : changes;
    if (shown.length || report.deletions.length) {
      lines.push("");
      lines.push(report.dryRun ? "Planned operations:" : "Operations:");
      for (const n of shown) {
        const symbol = { create: "+", update: "~", rename: ">", unchanged: "=" }[n.action];
        const detail =
          n.action === "rename" || (n.previousFilename && n.action !== "create")
            ? `${n.previousFilename ?? ""} → ${n.filename}`
            : n.filename;
        const reasons = n.reasons.length ? ` (${n.reasons.join(", ")})` : "";
        lines.push(`  ${symbol} ${n.action.padEnd(9)} ${detail}${reasons}`);
        for (const warning of n.warnings ?? []) lines.push(`      ! ${warning}`);
      }
      for (const d of report.deletions) {
        const action = { keep: "keep", delete: "DELETE permanently", move_to_trash: "move to trash", archive: "archive" }[d.policy];
        lines.push(`  - ${action.padEnd(9)} ${d.filename} (deleted in Simplenote)${d.status === "failed" ? " — FAILED" : ""}`);
      }
    }
  }

  const failed = report.notes.filter((n) => n.status === "failed" || n.status === "skipped");
  const failedDeletions = report.deletions.filter((d) => d.status === "failed");
  if (failed.length || failedDeletions.length) {
    lines.push("");
    lines.push("Failed:");
    for (const n of failed) {
      lines.push(`- ${quoted(n.title)}`);
      lines.push(`  ${n.error?.message ?? "unknown error"}`);
      if (n.error?.hint) lines.push(`  Hint: ${n.error.hint}`);
    }
    for (const d of failedDeletions) {
      lines.push(`- ${quoted(d.title)} (deletion: ${d.policy})`);
      lines.push(`  ${d.error?.message ?? "unknown error"}`);
    }
  }

  if (report.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

export function formatError(error: unknown): string {
  if (error instanceof AppError) {
    const lines = [`Error: ${error.message}`];
    const status = error.details?.status;
    if (typeof status === "string" && status.trim()) lines.push("", "Scraper output:", status);
    const stderr = error.details?.stderr;
    if (typeof stderr === "string" && stderr.trim()) lines.push("", "Scraper stderr:", stderr);
    if (error.hint) lines.push("", `Hint: ${error.hint}`);
    return lines.join("\n");
  }
  if (error instanceof Error) return `Unexpected error: ${error.stack ?? error.message}`;
  return `Unexpected error: ${String(error)}`;
}
