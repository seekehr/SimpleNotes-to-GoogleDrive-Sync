import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigurationError, errorMessage } from "../errors.js";
import { type AppConfig, configSchema } from "./schema.js";

export interface ResolvedConfig extends AppConfig {
  meta: {
    /** Base directory relative paths are resolved against. */
    home: string;
    configPath: string;
    configFileFound: boolean;
    /** Names of SNSYNC_* variables that changed the configuration. */
    envOverrides: string[];
  };
}

/** A partial, nested override object, e.g. `{ sync: { deleted_notes: "keep" } }`. */
export type ConfigOverrides = { [section: string]: Record<string, unknown> };

type EnvKind = "string" | "number" | "boolean" | "list";

/** Environment variables that override config values. Documented in .env.example and the README. */
export const ENV_OVERRIDES: ReadonlyArray<{ name: string; path: [string, string]; kind: EnvKind }> = [
  { name: "SNSYNC_SCRAPER_COMMAND", path: ["simplenote", "scraper_command"], kind: "string" },
  { name: "SNSYNC_SCRAPER_ENV_DIR", path: ["simplenote", "env_dir"], kind: "string" },
  { name: "SNSYNC_SCRAPER_TIMEOUT_SECONDS", path: ["simplenote", "timeout_seconds"], kind: "number" },
  { name: "SNSYNC_SCRAPER_WORK_DIR", path: ["simplenote", "work_dir"], kind: "string" },
  { name: "SNSYNC_GOOGLE_FOLDER_ID", path: ["google_drive", "folder_id"], kind: "string" },
  { name: "SNSYNC_GOOGLE_FOLDER_PATH", path: ["google_drive", "folder_path"], kind: "string" },
  { name: "SNSYNC_GOOGLE_CREDENTIALS_FILE", path: ["google_drive", "credentials_file"], kind: "string" },
  { name: "SNSYNC_TOKEN_STORE", path: ["google_drive", "token_store"], kind: "string" },
  { name: "SNSYNC_DELETED_NOTES", path: ["sync", "deleted_notes"], kind: "string" },
  { name: "SNSYNC_MAX_CONCURRENT_UPLOADS", path: ["sync", "max_concurrent_uploads"], kind: "number" },
  { name: "SNSYNC_KEEP_LOCAL_DOCX", path: ["output", "keep_local_docx"], kind: "boolean" },
  { name: "SNSYNC_LOG_LEVEL", path: ["logging", "level"], kind: "string" },
  { name: "SNSYNC_LOG_FILE", path: ["logging", "file"], kind: "string" },
  { name: "SNSYNC_INCLUDE_METADATA", path: ["document", "include_metadata"], kind: "boolean" },
];

/** Config values that are filesystem paths and get resolved against `meta.home`. */
const PATH_FIELDS: ReadonlyArray<[keyof AppConfig, string]> = [
  ["simplenote", "work_dir"],
  ["simplenote", "output_dir"],
  ["simplenote", "env_dir"],
  ["output", "temp_directory"],
  ["output", "generated_directory"],
  ["state", "file"],
  ["state", "lock_file"],
  ["google_drive", "credentials_file"],
  ["google_drive", "token_file"],
  ["logging", "file"],
];

/**
 * The application root: SNSYNC_HOME, or the package directory (the folder holding
 * package.json). Using the install location rather than process.cwd() means
 * relative paths keep working no matter which directory notesync is started from.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SNSYNC_HOME) return resolve(env.SNSYNC_HOME);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function parseEnvValue(name: string, raw: string, kind: EnvKind): unknown {
  switch (kind) {
    case "string":
      return raw;
    case "number": {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) {
        throw new ConfigurationError(`Environment variable ${name} must be a number (got "${raw}")`);
      }
      return value;
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) return true;
      if (["0", "false", "no", "off"].includes(v)) return false;
      throw new ConfigurationError(`Environment variable ${name} must be true/false (got "${raw}")`);
    }
    case "list":
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

export function envOverrides(env: NodeJS.ProcessEnv): { overrides: ConfigOverrides; applied: string[] } {
  const overrides: ConfigOverrides = {};
  const applied: string[] = [];
  for (const { name, path, kind } of ENV_OVERRIDES) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const [section, key] = path;
    (overrides[section] ??= {})[key] = parseEnvValue(name, raw, kind);
    applied.push(name);
  }
  return { overrides, applied };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigurationError(`Cannot read config file ${path}: ${errorMessage(error)}`, { cause: error });
  }
  try {
    const data = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
    if (data === null || data === undefined) return {};
    if (!isPlainObject(data)) throw new Error("top level must be a mapping of sections");
    return data;
  } catch (error) {
    throw new ConfigurationError(`Config file ${path} is not valid: ${errorMessage(error)}`, { cause: error });
  }
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}

export interface LoadConfigOptions {
  /** Explicit --config path. When given, the file must exist. */
  configPath?: string;
  /** CLI-level overrides; highest priority. */
  cliOverrides?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
  /** Load `<home>/.env` into the environment first (does not override existing vars). */
  loadDotEnv?: boolean;
}

/**
 * Builds the effective configuration. Priority, highest first:
 *   CLI arguments → SNSYNC_* environment variables → config file → defaults
 */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const home = resolveHome(env);

  if (options.loadDotEnv && env === process.env) {
    const dotEnv = join(home, ".env");
    if (existsSync(dotEnv)) {
      try {
        process.loadEnvFile(dotEnv);
      } catch (error) {
        throw new ConfigurationError(`Cannot parse ${dotEnv}: ${errorMessage(error)}`, { cause: error });
      }
    }
  }

  const explicitPath = options.configPath ?? env.SNSYNC_CONFIG;
  const configPath = explicitPath ? resolve(explicitPath) : join(home, "config", "config.yaml");
  const configFileFound = existsSync(configPath);
  if (explicitPath && !configFileFound) {
    throw new ConfigurationError(`Config file not found: ${configPath}`, {
      hint: "Copy config/config.example.yaml to config/config.yaml, or fix --config / SNSYNC_CONFIG.",
    });
  }

  const fileData = configFileFound ? readConfigFile(configPath) : {};
  const { overrides: envData, applied } = envOverrides(env);
  const merged = deepMerge(deepMerge(fileData, envData), options.cliOverrides ?? {});

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid configuration (${configFileFound ? configPath : "defaults"}):\n${formatZodError(parsed.error)}`,
      { hint: "See config/config.example.yaml for every option and its allowed values." },
    );
  }
  const config = parsed.data;

  if (config.simplenote.output_dir.trim() === "") {
    config.simplenote.output_dir = join(config.simplenote.work_dir, "output");
  }
  for (const [section, key] of PATH_FIELDS) {
    const holder = config[section] as Record<string, unknown>;
    const value = holder[key];
    if (typeof value === "string" && value !== "" && !isAbsolute(value)) holder[key] = resolve(home, value);
  }

  if (config.retry.initial_delay_seconds > config.retry.max_delay_seconds) {
    throw new ConfigurationError("retry.initial_delay_seconds must not exceed retry.max_delay_seconds");
  }

  return { ...config, meta: { home, configPath, configFileFound, envOverrides: applied } };
}

const SECRET_KEY = /(secret|password|passwd|refresh_token|access_token|api_key|apikey|authorization|^token$)/i;

/** Deep copy with secret-looking values replaced. Used by `notesync config`. */
export function redactConfig(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key) && value !== "" && value !== undefined) return "***redacted***";
  if (Array.isArray(value)) return value.map((v) => redactConfig(v));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactConfig(v, k)]));
  }
  return value;
}
