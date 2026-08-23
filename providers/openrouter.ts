import { formatDollars } from "../format.ts";
import {
  envValue,
  errorMessage,
  finiteNumber,
  httpErrorMessage,
  piProviderApiKey,
  record,
  request,
  type HttpResult,
  type ProviderDefinition,
  type ProviderResult,
  type UsageWindow,
} from "../shared.ts";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const KEY_URL = "https://openrouter.ai/api/v1/key";

/**
 * Prepaid credits rather than a plan: `total_credits` is everything ever added to the account and
 * `total_usage` is lifetime spend, so subtract it from top-ups to show the only figure that matters:
 * how much prepaid credit remains available.
 */
export function creditWindows(body: unknown): UsageWindow[] {
  const data = record(record(body)?.data);
  const usage = finiteNumber(data?.total_usage);
  if (usage === undefined) return [];

  const spent = Math.max(0, usage);
  const credits = Math.max(0, finiteNumber(data?.total_credits) ?? 0);
  return [
    {
      label: "Credits",
      trailer: `${formatDollars(Math.max(0, credits - spent))} available`,
    },
  ];
}

/** The key endpoint still tells us whether this is a free or pay-as-you-go account. */
function keyPlan(body: unknown): string | undefined {
  const data = record(record(body)?.data);
  if (typeof data?.is_free_tier !== "boolean") return undefined;
  return data.is_free_tier ? "Free tier" : "Pay as you go";
}

function rejected(response: HttpResult | undefined): boolean {
  return response?.status === 401 || response?.status === 403;
}

function ok(response: HttpResult | undefined): boolean {
  return (
    response !== undefined && response.status >= 200 && response.status < 300
  );
}

export const openrouterProvider: ProviderDefinition = {
  name: "OpenRouter",
  fetch: async (ctx): Promise<ProviderResult> => {
    const apiKey =
      envValue("OPENROUTER_API_KEY") ??
      (await piProviderApiKey(ctx, "openrouter"));
    if (!apiKey) {
      return {
        status: "absent",
        message: "no OPENROUTER_API_KEY and not connected in Pi",
      };
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };

    try {
      // Either endpoint can be gated for a given key type, so a failure on one still leaves the
      // other's rows usable.
      const [credits, key] = await Promise.all([
        request(CREDITS_URL, { headers }).catch(() => undefined),
        request(KEY_URL, { headers }).catch(() => undefined),
      ]);

      if (rejected(credits)) {
        return { status: "error", message: "OpenRouter key was rejected" };
      }
      if (!ok(credits)) {
        return {
          status: "error",
          message: httpErrorMessage(credits?.status ?? 0),
        };
      }

      return {
        status: "ok",
        plan: ok(key) ? keyPlan(key?.body) : undefined,
        windows: creditWindows(credits?.body),
      };
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  },
};
