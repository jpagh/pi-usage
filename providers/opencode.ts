import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import {
  clampPercent,
  envValue,
  errorMessage,
  finiteNumber,
  homePath,
  httpErrorMessage,
  nonEmptyString,
  parseReset,
  piProviderApiKey,
  readJsonIfPresent,
  record,
  request,
  type ProviderDefinition,
  type ProviderResult,
  type UsageWindow,
} from "../shared.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** Mirrors OpenCode: `OPENCODE_DATA_DIR`, then `$XDG_DATA_HOME/opencode`, then the default. */
export function dataDirectory(): string {
  const override = envValue("OPENCODE_DATA_DIR");
  if (override) return override;
  const xdg = envValue("XDG_DATA_HOME");
  return xdg ? join(xdg, "opencode") : homePath(".local", "share", "opencode");
}

async function resolveApiKey(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const auth = await readJsonIfPresent(join(dataDirectory(), "auth.json"));
  const key = nonEmptyString(record(auth?.["opencode-go"])?.key);
  return key ?? (await piProviderApiKey(ctx, "opencode-go"));
}

function window(
  label: string,
  value: Record<string, unknown> | undefined,
): UsageWindow | undefined {
  const usedPercent = finiteNumber(value?.percent);
  if (usedPercent === undefined) return undefined;
  return {
    label,
    usedPercent: clampPercent(usedPercent),
    resetsAt: parseReset(value?.resetsAt),
  };
}

export const opencodeProvider: ProviderDefinition = {
  name: "OpenCode Go",
  fetch: async (ctx): Promise<ProviderResult> => {
    let apiKey: string | undefined;
    try {
      apiKey = await resolveApiKey(ctx);
    } catch (error) {
      return {
        status: "error",
        message: `couldn't read OpenCode's auth.json: ${errorMessage(error)}`,
      };
    }
    if (!apiKey) {
      return { status: "absent", message: "not logged in to OpenCode Go" };
    }

    try {
      const { status, body } = await request(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      });

      if (status === 401) {
        return {
          status: "error",
          message: "OpenCode Go key was rejected — log in again",
        };
      }
      // A valid key on a Zen-only account: nothing is metered, so there is nothing to show.
      if (status === 403) {
        return { status: "absent", message: "no Go subscription on this key" };
      }
      if (status < 200 || status >= 300) {
        return { status: "error", message: httpErrorMessage(status) };
      }

      const usage = record(record(body)?.usage);
      const windows = [
        window("Session", record(usage?.rolling)),
        window("Week", record(usage?.weekly)),
        window("Month", record(usage?.monthly)),
      ].filter((value): value is UsageWindow => value !== undefined);
      return { status: "ok", plan: "Go", windows };
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  },
};
