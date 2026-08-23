import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const REQUEST_TIMEOUT_MS = 15_000;

export interface UsageWindow {
  label: string;
  /** Percent used. Omitted by meters with no denominator, such as a prepaid balance. */
  usedPercent?: number;
  /**
   * Trailing column, defaulting to the reset time. Meters that do not reset (credit balances) use it
   * for the figure that matters instead of claiming an unknown reset.
   */
  trailer?: string;
  resetsAt?: number;
}

/** What a provider learned about the local subscription. */
export type ProviderResult =
  /** Credentials found and usage read. `windows` may be empty when the plan reports no meters. */
  | { status: "ok"; plan?: string; windows: UsageWindow[] }
  /** Credentials found but usage could not be read. Always shown. */
  | { status: "error"; message: string }
  /** No credentials, or the account has no metered plan. Hidden unless `/usage all`. */
  | { status: "absent"; message: string };

export interface ProviderDefinition {
  name: string;
  fetch: (ctx: ExtensionCommandContext) => Promise<ProviderResult>;
}

export interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function parseReset(value: unknown): number | undefined {
  // Digit-only strings are epoch stamps, not dates: `new Date("1784958141000")` is invalid.
  if (typeof value === "string" && value.trim() && !/^\d+$/.test(value.trim())) {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  const numeric = finiteNumber(value);
  if (numeric === undefined) return undefined;
  const timestamp = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  return Number.isNaN(new Date(timestamp).getTime()) ? undefined : timestamp;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function request(
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
): Promise<HttpResult> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

export function httpErrorMessage(status: number): string {
  return `request failed (HTTP ${status})`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readTextIfPresent(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Parsed JSON, or `undefined` when the file is missing. Unparseable content throws. */
export async function readJsonIfPresent(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  const text = await readTextIfPresent(path);
  if (text === undefined) return undefined;
  const parsed = record(JSON.parse(text));
  if (!parsed) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | undefined {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return undefined;
  try {
    return record(
      JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

/** JWT `exp` in epoch ms, when the token carries one. */
export function jwtExpiry(token: string): number | undefined {
  const exp = finiteNumber(decodeJwtPayload(token)?.exp);
  return exp === undefined ? undefined : exp * 1_000;
}

export function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = nonEmptyString(process.env[name]);
    if (value) return value;
  }
  return undefined;
}

export function homePath(...segments: string[]): string {
  return join(homedir(), ...segments);
}

/** The generic-password entry `service` holds in the macOS login keychain, if this is a Mac. */
export function readKeychain(service: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return nonEmptyString(
      execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return undefined;
  }
}

/**
 * A credential Pi itself stored for `providerId`. `getProviderAuth` only exposes the value Pi sends
 * to the model API, which is not always what a usage endpoint wants (GitHub Copilot, for instance,
 * needs the GitHub OAuth token that Pi keeps as the credential's refresh token), so providers can
 * read the stored entry directly.
 */
export async function piStoredCredential(
  providerId: string,
): Promise<Record<string, unknown> | undefined> {
  const configDir = envValue("PI_CODING_AGENT_DIR") ?? homePath(".pi", "agent");
  const store = await readJsonIfPresent(join(configDir, "auth.json")).catch(
    () => undefined,
  );
  return record(store?.[providerId]);
}

/** The API key Pi resolved for `providerId`, whether from OAuth, config, or the environment. */
export async function piProviderApiKey(
  ctx: ExtensionCommandContext,
  providerId: string,
): Promise<string | undefined> {
  try {
    const resolved = await ctx.modelRegistry.getProviderAuth(providerId);
    return nonEmptyString(resolved?.auth.apiKey);
  } catch {
    return undefined;
  }
}
