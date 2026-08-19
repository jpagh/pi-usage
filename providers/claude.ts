import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import {
  clampPercent,
  envValue,
  errorMessage,
  finiteNumber,
  homePath,
  httpErrorMessage,
  parseReset,
  piStoredCredential,
  readJsonIfPresent,
  readKeychain,
  record,
  request,
  type ProviderDefinition,
  type ProviderResult,
  type UsageWindow,
} from "../shared.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

function window(
  label: string,
  value: Record<string, unknown> | undefined,
): UsageWindow | undefined {
  const usedPercent = finiteNumber(value?.utilization);
  if (usedPercent === undefined) return undefined;
  return {
    label,
    usedPercent: clampPercent(usedPercent),
    resetsAt: parseReset(value?.resets_at),
  };
}

/** The credential file and the macOS keychain both hold the same `claudeAiOauth` payload. */
function oauthAccessToken(
  credentials: Record<string, unknown> | undefined,
): string | undefined {
  const oauth = record(credentials?.claudeAiOauth);
  if (typeof oauth?.accessToken !== "string") return undefined;
  const expiresAt = finiteNumber(oauth.expiresAt);
  if (expiresAt !== undefined && expiresAt <= Date.now()) return undefined;
  return oauth.accessToken;
}

/** The keychain entry is the whole credential document, so a non-object is simply not usable. */
function keychainCredentials(service: string): Record<string, unknown> | undefined {
  const raw = readKeychain(service);
  if (!raw) return undefined;
  try {
    return record(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Pi's own Anthropic OAuth credential first (Pi keeps it refreshed), then Claude Code's. Reads Pi's
 * stored entry rather than `getProviderAuth` so an unexpired API-key credential can't be mistaken
 * for a subscription token — the usage endpoint only accepts the OAuth access token.
 */
async function resolveAccessToken(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const resolved = await ctx.modelRegistry
    .getProviderAuth("anthropic")
    .catch(() => undefined);
  if (resolved?.source === "OAuth" && resolved.auth.apiKey) {
    return resolved.auth.apiKey;
  }

  const configDir = envValue("CLAUDE_CONFIG_DIR") ?? homePath(".claude");
  const fromFile = oauthAccessToken(
    await readJsonIfPresent(join(configDir, ".credentials.json")).catch(
      () => undefined,
    ),
  );
  if (fromFile) return fromFile;

  // On macOS Claude Code stores the credential in the login keychain and writes no file at all.
  return oauthAccessToken(keychainCredentials(KEYCHAIN_SERVICE));
}

export const claudeProvider: ProviderDefinition = {
  name: "Claude Code",
  fetch: async (ctx): Promise<ProviderResult> => {
    let accessToken: string | undefined;
    try {
      accessToken = await resolveAccessToken(ctx);
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }

    if (!accessToken) {
      const stored = await piStoredCredential("anthropic");
      return {
        status: "absent",
        message: stored
          ? "Claude subscription token expired — sign in again"
          : "not connected in Pi or Claude Code",
      };
    }

    try {
      const { status, body } = await request(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "pi-subscription-usage/1.0",
        },
      });
      if (status === 401 || status === 403) {
        return {
          status: "error",
          message: "Claude token was rejected — sign in again",
        };
      }
      if (status < 200 || status >= 300) {
        return { status: "error", message: httpErrorMessage(status) };
      }

      const usage = record(body);
      const windows = [
        window("Session", record(usage?.five_hour)),
        window("Week", record(usage?.seven_day)),
      ].filter((value): value is UsageWindow => value !== undefined);
      return { status: "ok", windows };
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  },
};
