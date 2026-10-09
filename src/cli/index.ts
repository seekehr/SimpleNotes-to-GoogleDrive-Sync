#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { stringify as toYaml } from "yaml";
import { createApp, createDriveStore, loggerFromConfig } from "../app.js";
import { type ConfigOverrides, type ResolvedConfig, loadConfig, redactConfig } from "../config/load.js";
import { LOG_LEVELS, type LogLevel } from "../config/schema.js";
import { loadClientCredentials, runInteractiveAuth, tokenStoreFor } from "../drive/auth.js";
import { ConfigurationError, ExitCode, LockError, exitCodeFor } from "../errors.js";
import type { Logger } from "../logging/logger.js";
import { Scheduler } from "../scheduler/scheduler.js";
import type { SyncReport } from "../sync/types.js";
import { formatDuration, parseDuration } from "../util/duration.js";
import { runDoctor } from "./commands/doctor.js";
import { runStatus } from "./commands/status.js";
import { formatError, formatReport, print } from "./output.js";

interface GlobalOptions {
  config?: string;
  logLevel?: LogLevel;
  verbose?: boolean;
  quiet?: boolean;
}

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

function bootstrap(globals: GlobalOptions, overrides: ConfigOverrides = {}): { config: ResolvedConfig; logger: Logger } {
  const cli: ConfigOverrides = { ...overrides };
  const level = globals.verbose ? "debug" : globals.logLevel;
  if (level) cli.logging = { ...(cli.logging ?? {}), level };
  if (globals.quiet) cli.logging = { ...(cli.logging ?? {}), console: false };
  const config = loadConfig({ configPath: globals.config, cliOverrides: cli, loadDotEnv: true });
  return { config, logger: loggerFromConfig(config) };
}

/** Lets a final burst of output flush, then exits even if a stray socket keeps the loop alive. */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}

function fail(error: unknown, logger?: Logger): void {
  logger?.error("Command failed", { error });
  process.stderr.write(`\n${formatError(error)}\n`);
  finish(exitCodeFor(error));
}

/** First Ctrl+C finishes in-flight uploads and saves state; a second one exits immediately. */
function interruptController(logger: Logger): AbortController {
  const controller = new AbortController();
  let count = 0;
  const handler = () => {
    count++;
    if (count === 1) {
      logger.warn("Interrupt received; finishing in-flight operations (press Ctrl+C again to exit now)");
      controller.abort();
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return controller;
}

const reportExitCode = (report: SyncReport): number =>
  report.counts.failed > 0 || report.aborted ? ExitCode.PartialFailure : ExitCode.Success;

const program = new Command("notesync")
  .description("Export Simplenote notes with SimpleNotesScraper, convert them to DOCX and sync them to Google Drive.")
  .version(pkg.version)
  .option("-c, --config <path>", "config file (default: config/config.yaml, or SNSYNC_CONFIG)")
  .addOption(new Option("--log-level <level>", "override logging.level").choices(LOG_LEVELS))
  .option("-v, --verbose", "debug logging and per-note output")
  .option("-q, --quiet", "no log output on the console (log file only)")
  .showHelpAfterError();

program
  .command("sync")
  .description("run a single synchronization")
  .option("--dry-run", "show what would happen without uploading, deleting or changing anything")
  .option("--force", "re-convert and re-upload every note; also bypasses the deletion safety check")
  .action(async (opts: { dryRun?: boolean; force?: boolean }, cmd: Command) => {
    const globals = cmd.optsWithGlobals<GlobalOptions>();
    let logger: Logger | undefined;
    try {
      const ctx = bootstrap(globals);
      logger = ctx.logger;
      const app = createApp(ctx.config, logger);
      const controller = interruptController(logger);
      const report = await app.engine.run({ dryRun: Boolean(opts.dryRun), force: Boolean(opts.force), signal: controller.signal });
      print();
      print(formatReport(report, Boolean(globals.verbose)));
      finish(reportExitCode(report));
    } catch (error) {
      // The engine has already logged the failure; only print it.
      fail(error);
    }
  });

program
  .command("watch")
  .description("synchronize continuously at a fixed interval")
  .option("--interval <duration>", 'interval such as "30s", "5m", "1h" (overrides sync.interval)')
  .option("--no-run-on-startup", "wait one interval before the first sync")
  .action(async (opts: { interval?: string; runOnStartup: boolean }, cmd: Command) => {
    const globals = cmd.optsWithGlobals<GlobalOptions>();
    let logger: Logger | undefined;
    try {
      if (opts.interval !== undefined && parseDuration(opts.interval) === undefined) {
        throw new ConfigurationError(`Invalid --interval "${opts.interval}"; use e.g. 30s, 5m, 1h`);
      }
      const ctx = bootstrap(globals, opts.interval ? { sync: { interval: opts.interval } } : {});
      logger = ctx.logger;
      const log = logger;
      const app = createApp(ctx.config, log);
      const runOnStartup = cmd.getOptionValueSource("runOnStartup") === "cli" ? opts.runOnStartup : ctx.config.sync.run_on_startup;

      const scheduler = new Scheduler(
        async (signal) => {
          try {
            const report = await app.engine.run({ dryRun: false, force: false, signal });
            if (globals.verbose || report.counts.failed > 0) print(`\n${formatReport(report, Boolean(globals.verbose))}\n`);
          } catch (error) {
            if (error instanceof LockError) {
              log.info("Another synchronization is running; skipping this tick", { detail: error.message });
              return;
            }
            log.error("Synchronization failed", { error, hint: (error as { hint?: string }).hint });
          }
        },
        { intervalMs: ctx.config.meta.intervalMs, runOnStartup, logger: log },
      );
      log.info("Watching for changes", { interval: formatDuration(ctx.config.meta.intervalMs) });

      let stopping = false;
      const stop = () => {
        if (stopping) process.exit(130);
        stopping = true;
        log.info("Stopping after the current synchronization (Ctrl+C again to exit now)");
        void scheduler.stop();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await scheduler.start();
      log.info("Watcher stopped");
      finish(ExitCode.Success);
    } catch (error) {
      fail(error, logger);
    }
  });

program
  .command("status")
  .description("show synchronization status")
  .option("--json", "machine-readable output")
  .action(async (opts: { json?: boolean }, cmd: Command) => {
    const globals = cmd.optsWithGlobals<GlobalOptions>();
    try {
      const { config, logger } = bootstrap({ ...globals, quiet: true });
      finish(await runStatus(config, logger, { json: Boolean(opts.json) }));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("doctor")
  .description("check configuration, scraper, DOCX conversion and Google Drive access")
  .option("--full", "run a real scraper export instead of a --help probe")
  .action(async (opts: { full?: boolean }, cmd: Command) => {
    const globals = cmd.optsWithGlobals<GlobalOptions>();
    try {
      // Keep the checklist readable: logs go to the file only unless --verbose.
      const { config, logger } = bootstrap({ ...globals, quiet: !globals.verbose });
      finish(await runDoctor(config, logger, { full: Boolean(opts.full) }));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("auth")
  .description("sign in to Google Drive (OAuth 2.0) and store the token securely")
  .option("--no-browser", "print the sign-in URL instead of opening a browser")
  .option("--logout", "remove the stored Google token")
  .action(async (opts: { browser: boolean; logout?: boolean }, cmd: Command) => {
    const globals = cmd.optsWithGlobals<GlobalOptions>();
    let logger: Logger | undefined;
    try {
      const ctx = bootstrap(globals);
      logger = ctx.logger;
      if (opts.logout) {
        const credentials = await loadClientCredentials(ctx.config.google_drive.credentials_file);
        const store = await tokenStoreFor(ctx.config.google_drive, credentials, logger);
        await store.clear();
        print(`Removed stored Google token from ${store.description}.`);
        finish(ExitCode.Success);
        return;
      }
      const store = await runInteractiveAuth(ctx.config.google_drive, logger, { openBrowser: opts.browser, print });
      const drive = await createDriveStore(ctx.config, logger);
      const account = await drive.probe();
      print(`Signed in as ${account}. Token stored in ${store.description}.`);
      logger.info("Google Drive authentication completed", { token_store: store.description });
      finish(ExitCode.Success);
    } catch (error) {
      fail(error, logger);
    }
  });

program
  .command("config")
  .description("print the resolved configuration (secrets redacted)")
  .option("--json", "print as JSON instead of YAML")
  .action((opts: { json?: boolean }, cmd: Command) => {
    const globals = cmd.optsWithGlobals<GlobalOptions>();
    try {
      const { config } = bootstrap({ ...globals, quiet: true });
      const { meta, ...values } = config;
      const redacted = redactConfig(values);
      print(`# config file: ${meta.configFileFound ? meta.configPath : `${meta.configPath} (not found; defaults used)`}`);
      print(`# base directory: ${meta.home}`);
      print(`# environment overrides: ${meta.envOverrides.length ? meta.envOverrides.join(", ") : "none"}`);
      print(`# effective interval: ${formatDuration(meta.intervalMs)}`);
      print(opts.json ? JSON.stringify(redacted, null, 2) : toYaml(redacted));
      finish(ExitCode.Success);
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync(process.argv).catch((error) => fail(error));
