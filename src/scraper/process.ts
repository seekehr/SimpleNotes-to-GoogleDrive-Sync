import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import crossSpawn from "cross-spawn";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Abort if either stream exceeds this many bytes (protects memory on runaway output). */
  maxOutputBytes?: number;
}

export class SpawnFailure extends Error {
  constructor(
    message: string,
    readonly errno?: string,
  ) {
    super(message);
  }
}

export class OutputLimitExceeded extends Error {}

const isWindows = process.platform === "win32";

async function isFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    if (!isWindows) await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds an executable the way the shell would: absolute/relative paths are checked
 * directly, bare names are searched on PATH honouring PATHEXT on Windows (so
 * "simplenotesscraper" finds the npm-generated simplenotesscraper.cmd shim).
 */
export async function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const extensions = isWindows
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())]
    : [""];
  const candidatesFor = (base: string) =>
    // On Windows an extension-less file (e.g. the npm bash shim) cannot be executed directly.
    isWindows && extname(base) === "" ? extensions.slice(1).map((ext) => base + ext) : extensions.map((ext) => base + ext);

  const hasPath = isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (hasPath) {
    for (const candidate of candidatesFor(resolve(command))) if (await isFile(candidate)) return candidate;
    return undefined;
  }
  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const candidate of candidatesFor(join(dir.replace(/^"|"$/g, ""), command))) {
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Kills the process and its children. On Windows a .cmd shim spawns node as a grandchild. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (isWindows) {
    try {
      nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } catch {
      // Best effort.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs a command to completion, capturing stdout/stderr. Uses cross-spawn so .cmd
 * shims and arguments containing spaces are quoted correctly on Windows without
 * going through an interactive shell.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const maxBytes = options.maxOutputBytes ?? 256 * 1024 * 1024;
  const started = performance.now();

  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = crossSpawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: !isWindows,
      });
    } catch (error) {
      reject(new SpawnFailure((error as Error).message, (error as NodeJS.ErrnoException).code));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        overflow = true;
        killTree(child.pid);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new SpawnFailure(error.message, error.code));
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (overflow) {
        reject(new OutputLimitExceeded(`Process output exceeded ${maxBytes} bytes`));
        return;
      }
      // Decode once at the end so multi-byte UTF-8 characters split across chunks survive.
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
        durationMs: performance.now() - started,
        timedOut,
      });
    });
  });
}
