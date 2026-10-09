import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import type { AppConfig } from "../config/schema.js";
import { GoogleDriveAuthenticationError, errorMessage } from "../errors.js";
import type { Logger } from "../logging/logger.js";
import { registerSecret } from "../logging/redact.js";
import { pathExists } from "../util/fs.js";
import { type StoredToken, type TokenStore, createTokenStore } from "./tokenStore.js";

export type DriveSettings = AppConfig["google_drive"];

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export const scopeUrl = (scope: DriveSettings["scope"]): string => `https://www.googleapis.com/auth/${scope}`;

const SETUP_HINT =
  "Create an OAuth client of type \"Desktop app\" in Google Cloud Console, download its JSON " +
  "and save it as config/google_credentials.json (see README, \"Google Cloud project setup\").";

/** Reads the OAuth client JSON downloaded from Google Cloud Console ("installed" or "web" client). */
export async function loadClientCredentials(path: string): Promise<ClientCredentials> {
  if (!(await pathExists(path))) {
    throw new GoogleDriveAuthenticationError(`Google OAuth client file not found: ${path}`, { hint: SETUP_HINT });
  }
  let json: Record<string, { client_id?: string; client_secret?: string } | undefined>;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new GoogleDriveAuthenticationError(`Google OAuth client file is not valid JSON: ${errorMessage(error)}`, {
      hint: SETUP_HINT,
    });
  }
  const section = json.installed ?? json.web;
  if (!section?.client_id || !section.client_secret) {
    throw new GoogleDriveAuthenticationError(`${path} does not look like an OAuth client file (missing client_id/client_secret)`, {
      hint: SETUP_HINT,
    });
  }
  registerSecret(section.client_secret);
  return { clientId: section.client_id, clientSecret: section.client_secret };
}

export async function tokenStoreFor(settings: DriveSettings, credentials: ClientCredentials, logger: Logger): Promise<TokenStore> {
  return createTokenStore(settings.token_store, settings.token_file, `client:${credentials.clientId}`, logger);
}

/**
 * Returns an OAuth2 client loaded with the stored refresh token. Access tokens are
 * obtained and refreshed automatically by google-auth-library; if Google issues a
 * new refresh token it is persisted.
 */
export async function createAuthorizedClient(settings: DriveSettings, logger: Logger): Promise<{ client: OAuth2Client; store: TokenStore }> {
  const credentials = await loadClientCredentials(settings.credentials_file);
  const store = await tokenStoreFor(settings, credentials, logger);
  const token = await store.load();
  if (!token || token.client_id !== credentials.clientId) {
    throw new GoogleDriveAuthenticationError("Not signed in to Google Drive", { hint: 'Run "notesync auth" first.' });
  }
  if (token.scope && !token.scope.split(" ").includes(scopeUrl(settings.scope))) {
    throw new GoogleDriveAuthenticationError(
      `Stored Google token was granted for a different scope than google_drive.scope (${settings.scope})`,
      { hint: 'Run "notesync auth" again to grant the configured scope.' },
    );
  }

  const client = new OAuth2Client({ clientId: credentials.clientId, clientSecret: credentials.clientSecret });
  client.setCredentials({ refresh_token: token.refresh_token });
  client.on("tokens", (tokens) => {
    if (tokens.access_token) registerSecret(tokens.access_token);
    if (tokens.refresh_token && tokens.refresh_token !== token.refresh_token) {
      registerSecret(tokens.refresh_token);
      store
        .save({ ...token, refresh_token: tokens.refresh_token, created_at: new Date().toISOString() })
        .catch((error) => logger.warn("Could not persist rotated Google refresh token", { error }));
    }
  });
  return { client, store };
}

/** Forces a token refresh to prove the stored credentials still work. */
export async function verifyClient(client: OAuth2Client): Promise<void> {
  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("no access token returned");
  } catch (error) {
    const message = errorMessage(error);
    throw new GoogleDriveAuthenticationError(`Google token refresh failed: ${message}`, {
      cause: error,
      hint: /invalid_grant/.test(message)
        ? 'The sign-in was revoked or expired. Run "notesync auth". (Apps in "Testing" status get 7-day tokens.)'
        : "Check your internet connection, then try again.",
      retryable: !/invalid_grant|invalid_client|unauthorized_client/.test(message),
    });
  }
}

export interface InteractiveAuthOptions {
  openBrowser: boolean;
  timeoutMs?: number;
  /** Where to print the authorization URL. */
  print: (line: string) => void;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;

/**
 * OAuth 2.0 "installed app" flow with PKCE and a loopback redirect on 127.0.0.1,
 * as recommended by Google for desktop applications. Stores the refresh token.
 */
export async function runInteractiveAuth(settings: DriveSettings, logger: Logger, options: InteractiveAuthOptions): Promise<TokenStore> {
  const credentials = await loadClientCredentials(settings.credentials_file);
  const store = await tokenStoreFor(settings, credentials, logger);
  const state = randomBytes(16).toString("hex");
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const client = new OAuth2Client({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // guarantees a refresh token is returned
    scope: [scopeUrl(settings.scope)],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  try {
    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GoogleDriveAuthenticationError("Timed out waiting for Google sign-in")), timeoutMs);
      server.on("request", (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state) {
          res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in failed", "State mismatch. Please run notesync auth again."));
          return;
        }
        clearTimeout(timer);
        if (error || !code) {
          res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in cancelled", `Google returned: ${error ?? "no code"}.`));
          reject(new GoogleDriveAuthenticationError(`Google sign-in was not completed (${error ?? "no code"})`));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" }).end(page("notesync is connected", "You can close this tab and return to the terminal."));
        resolve(code);
      });
    });

    options.print("Open this URL in your browser to authorize notesync:\n");
    options.print(authUrl);
    options.print("");
    if (options.openBrowser) {
      try {
        const { default: open } = await import("open");
        await open(authUrl);
      } catch {
        options.print("(Could not open a browser automatically; copy the URL above.)");
      }
    }

    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new GoogleDriveAuthenticationError("Google did not return a refresh token", {
        hint: "Remove notesync's access at https://myaccount.google.com/permissions and run notesync auth again.",
      });
    }
    registerSecret(tokens.refresh_token);
    if (tokens.access_token) registerSecret(tokens.access_token);
    const stored: StoredToken = {
      refresh_token: tokens.refresh_token,
      scope: tokens.scope ?? scopeUrl(settings.scope),
      client_id: credentials.clientId,
      created_at: new Date().toISOString(),
    };
    await store.save(stored);
    return store;
  } finally {
    server.close();
  }
}
