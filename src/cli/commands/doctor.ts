import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { createApp, retryPolicy } from "../../app.js";
import type { ResolvedConfig } from "../../config/load.js";
import { DocxRenderer } from "../../docx/converter.js";
import { createAuthorizedClient, loadClientCredentials, verifyClient } from "../../drive/auth.js";
import { GoogleDriveStore } from "../../drive/googleDriveStore.js";
import { errorMessage } from "../../errors.js";
import type { Logger } from "../../logging/logger.js";
import { resolveExecutable, runProcess } from "../../scraper/process.js";
import { checkWritableDir, isDirectory, pathExists } from "../../util/fs.js";
import { print } from "../output.js";

type Status = "OK" | "WARN" | "FAIL" | "SKIP";

interface CheckResult {
  name: string;
  status: Status;
  detail?: string;
}

const SAMPLE = "# Doctor check\n\n**bold** *italic* ~~strike~~ `code`\n\n- [x] task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

export async function runDoctor(config: ResolvedConfig, logger: Logger, options: { full: boolean }): Promise<number> {
  const results: CheckResult[] = [];
  const record = (name: string, status: Status, detail?: string) => {
    results.push({ name, status, detail });
    const pad = " ".repeat(Math.max(1, 26 - name.length));
    print(`${name}${pad}${status}${detail ? `  ${detail}` : ""}`);
  };
  const s = config.simplenote;

  record(
    "Configuration",
    "OK",
    config.meta.configFileFound ? config.meta.configPath : `no config file at ${config.meta.configPath}; using defaults`,
  );

  const executable = await resolveExecutable(s.scraper_command);
  record("SimpleNotesScraper", executable ? "OK" : "FAIL", executable ?? `"${s.scraper_command}" not found on PATH (run "npm link" in the scraper project)`);

  if (!(await isDirectory(s.env_dir))) record("Scraper environment", "FAIL", `${s.env_dir} does not exist`);
  else if (!(await pathExists(`${s.env_dir}/.env`))) record("Scraper environment", "WARN", `${s.env_dir} has no .env file`);
  else record("Scraper environment", "OK", s.env_dir);

  if (!executable) {
    record("Scraper execution", "SKIP", "executable not found");
  } else if (options.full) {
    try {
      const app = createApp(config, logger);
      const result = await app.source.fetchNotes();
      record(
        "Scraper execution",
        result.failures.length ? "WARN" : "OK",
        `${result.notes.length + result.failures.length} notes in ${(result.durationMs / 1000).toFixed(1)}s` +
          (result.failures.length ? `, ${result.failures.length} unreadable` : ""),
      );
    } catch (error) {
      record("Scraper execution", "FAIL", errorMessage(error));
    }
  } else {
    try {
      // --help exits before the scraper touches its output folder, so any cwd is safe.
      const result = await runProcess({ command: executable, args: ["--help"], cwd: tmpdir(), timeoutMs: 30_000 });
      const ok = result.exitCode === 0 && /usage/i.test(result.stdout);
      record("Scraper execution", ok ? "OK" : "FAIL", ok ? "responds to --help (use --full for a real export)" : `exit code ${result.exitCode}`);
    } catch (error) {
      record("Scraper execution", "FAIL", errorMessage(error));
    }
  }

  const workProblem = await checkWritableDir(s.work_dir);
  record("Scraper output folder", workProblem ? "FAIL" : "OK", workProblem ?? s.output_dir);

  try {
    const { data } = await new DocxRenderer(config.document).render({
      id: "doctor",
      title: "Doctor check",
      content: SAMPLE,
      tags: [],
      systemTags: ["markdown"],
      isMarkdown: true,
    });
    const isZip = data.subarray(0, 2).toString("latin1") === "PK";
    record("DOCX converter", isZip ? "OK" : "FAIL", isZip ? `${data.length} byte sample document` : "output is not a DOCX package");
  } catch (error) {
    record("DOCX converter", "FAIL", errorMessage(error));
  }

  for (const [name, dir] of [
    ["Output directories", config.output.generated_directory],
    ["Temp directory", config.output.temp_directory],
    ["State directory", dirname(config.state.file)],
  ] as const) {
    const problem = await checkWritableDir(dir);
    record(name, problem ? "FAIL" : "OK", problem ?? dir);
  }
  try {
    const app = createApp(config, logger);
    const state = await app.stateRepository.peek();
    record("State file", "OK", state ? `${Object.keys(state.notes).length} notes tracked` : "not created yet (first sync)");
  } catch (error) {
    record("State file", "FAIL", errorMessage(error));
  }

  let credentialsOk = false;
  try {
    await loadClientCredentials(config.google_drive.credentials_file);
    credentialsOk = true;
    record("Google credentials", "OK", config.google_drive.credentials_file);
  } catch (error) {
    record("Google credentials", "FAIL", errorMessage(error));
  }

  let store: GoogleDriveStore | undefined;
  if (!credentialsOk) {
    record("Google authentication", "SKIP", "no OAuth client file");
  } else {
    try {
      const { client, store: tokenStore } = await createAuthorizedClient(config.google_drive, logger);
      await verifyClient(client);
      record("Google authentication", "OK", `token in ${tokenStore.description}`);
      store = new GoogleDriveStore({ settings: config.google_drive, retry: { ...retryPolicy(config), attempts: 2 }, logger, auth: client });
    } catch (error) {
      record("Google authentication", "FAIL", errorMessage(error));
    }
  }

  if (!store) {
    record("Google Drive API", "SKIP", "not authenticated");
    record("Google Drive folder", "SKIP", "not authenticated");
  } else {
    try {
      const account = await store.probe();
      record("Google Drive API", "OK", account);
      try {
        const state = await createApp(config, logger).stateRepository.peek().catch(() => undefined);
        const prepared = await store.prepare(state?.remote ?? {}, { dryRun: true });
        record(
          "Google Drive folder",
          prepared.folderExists ? "OK" : "WARN",
          prepared.folderExists ? prepared.folderDescription : `${prepared.folderDescription} will be created on first sync`,
        );
      } catch (error) {
        record("Google Drive folder", "FAIL", errorMessage(error));
      }
    } catch (error) {
      record("Google Drive API", "FAIL", errorMessage(error));
      record("Google Drive folder", "SKIP", "API unreachable");
    }
  }

  const failures = results.filter((r) => r.status === "FAIL").length;
  const warnings = results.filter((r) => r.status === "WARN").length;
  print("");
  if (failures === 0) print(warnings ? `System ready (${warnings} warning${warnings > 1 ? "s" : ""}).` : "System ready.");
  else print(`${failures} problem${failures > 1 ? "s" : ""} found.`);
  return failures === 0 ? 0 : 1;
}
