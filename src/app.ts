import type { ResolvedConfig } from "./config/load.js";
import { DocxRenderer } from "./docx/converter.js";
import { createAuthorizedClient } from "./drive/auth.js";
import { GoogleDriveStore } from "./drive/googleDriveStore.js";
import type { RemoteStore } from "./drive/remoteStore.js";
import { type Logger, createLogger } from "./logging/logger.js";
import { SimpleNotesScraperSource } from "./scraper/scraperSource.js";
import { StateRepository } from "./state/stateRepository.js";
import { SyncEngine } from "./sync/engine.js";
import type { RetryPolicy } from "./util/retry.js";

/** Composition root: wires concrete implementations together from configuration. */

export function loggerFromConfig(config: ResolvedConfig): Logger {
  return createLogger({
    level: config.logging.level,
    console: config.logging.console,
    file: config.logging.file || undefined,
    maxSizeMb: config.logging.max_size_mb,
    maxFiles: config.logging.max_files,
  });
}

export function retryPolicy(config: ResolvedConfig): RetryPolicy {
  return {
    attempts: config.retry.attempts,
    initialDelayMs: config.retry.initial_delay_seconds * 1000,
    maxDelayMs: config.retry.max_delay_seconds * 1000,
  };
}

export async function createDriveStore(config: ResolvedConfig, logger: Logger): Promise<GoogleDriveStore> {
  const { client } = await createAuthorizedClient(config.google_drive, logger);
  return new GoogleDriveStore({ settings: config.google_drive, retry: retryPolicy(config), logger, auth: client });
}

export interface App {
  config: ResolvedConfig;
  logger: Logger;
  source: SimpleNotesScraperSource;
  renderer: DocxRenderer;
  stateRepository: StateRepository;
  engine: SyncEngine;
}

export function createApp(config: ResolvedConfig, logger: Logger): App {
  const source = new SimpleNotesScraperSource(config.simplenote, logger);
  const renderer = new DocxRenderer(config.document);
  const stateRepository = new StateRepository(config.state.file, logger);

  // The Drive client is created once and reused across runs in watch mode.
  let store: Promise<RemoteStore> | undefined;
  const remote = () => {
    store ??= createDriveStore(config, logger).catch((error) => {
      store = undefined; // allow a later run to retry (e.g. after `notesync auth`)
      throw error;
    });
    return store;
  };

  const engine = new SyncEngine({ config, source, renderer, remote, stateRepository, logger });
  return { config, logger, source, renderer, stateRepository, engine };
}
