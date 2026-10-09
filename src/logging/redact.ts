/**
 * Secret scrubbing for anything that reaches a log sink. Three layers:
 *  1. field names that look secret are masked outright,
 *  2. exact values registered at runtime (e.g. the OAuth client secret) are masked,
 *  3. well-known Google credential shapes are masked wherever they appear.
 */

const SECRET_FIELD = /(secret|password|passwd|token|authorization|api_?key|credential|cookie)/i;
/** Field names that contain "token" but are not secret. */
const SAFE_FIELDS = new Set(["token_store", "tokenStore", "token_file", "tokenFile", "tokenSource"]);

const PATTERNS: RegExp[] = [
  /ya29\.[0-9A-Za-z_\-.]+/g, // Google OAuth access tokens
  /1\/\/[0-9A-Za-z_\-]{20,}/g, // Google OAuth refresh tokens
  /GOCSPX-[0-9A-Za-z_\-]+/g, // Google OAuth client secrets
  /(Bearer\s+)[^\s"']+/gi,
  /((?:[?&]code|refresh_token|access_token|client_secret)=)[^&\s"']+/gi,
  /("(?:refresh_token|access_token|client_secret|id_token)"\s*:\s*")[^"]+/gi,
];

const MASK = "***";
const registered = new Set<string>();

/** Registers a concrete secret value so it is masked even inside free-form text. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) registered.add(value);
}

export function scrubText(text: string): string {
  let out = text;
  for (const secret of registered) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (_match, prefix?: string) =>
      typeof prefix === "string" && prefix.length > 0 ? `${prefix}${MASK}` : MASK,
    );
  }
  return out;
}

export function isSecretField(name: string): boolean {
  return !SAFE_FIELDS.has(name) && SECRET_FIELD.test(name);
}
