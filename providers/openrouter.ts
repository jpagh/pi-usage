import { formatDollars } from "../format.ts";
import {
  clampPercent,
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
 * `total_usage` is lifetime spend, so the meter is spend against top-ups and the balance is what is
 * left. An account that has never topped up reports zero credits — it still gets a balance row, since
 * a measured $0.00 is information, not missing data.
 */
export function creditWindows(body: unknown): UsageWindow[] {
  const data = record(record(body)?.data);
  const usage = finiteNumber(data?.total_usage);
  if (usage === undefined) return [];

  const spent = Math.max(0, usage);
  const credits = Math.max(0, finiteNumber(data?.total_credits) ?? 0);
  const windows: UsageWindow[] = [];

  if (credits > 0) {
    windows.push({
      label: "Credits",
      usedPercent: clampPercent((spent / credits) * 100),
      trailer: `${formatDollars(spent)} of ${formatDollars(credits)}`,
    });
  }
  windows.push({
    label: "Balance",
    trailer: `${formatDollars(Math.max(0, credits - spent))} left`,
  });
  return windows;
}

/** The per-key spend cap, when this key has one. `limit_remaining` is what is left of it. */
export function keyWindows(body: unknown): {
  plan?: string;
  windows: UsageWindow[];
} {
  const data = record(record(body)?.data);
  const plan =
    typeof data?.is_free_tier === "boolean"
      ? data.is_free_tier
        ? "Free tier"
        : "Pay as you go"
      : undefined;

  const limit = finiteNumber(data?.limit);
  if (limit === undefined || limit <= 0) return { plan, windows: [] };

  const remaining = Math.max(0, finiteNumber(data?.limit_remaining) ?? 0);
  const used = Math.max(0, limit - remaining);
  return {
    plan,
    windows: [
      {
        label: "Key limit",
        usedPercent: clampPercent((used / limit) * 100),
        trailer: `${formatDollars(used)} of ${formatDollars(limit)}`,
      },
    ],
  };
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

      if (rejected(credits) || (rejected(key) && !ok(credits))) {
        return { status: "error", message: "OpenRouter key was rejected" };
      }
      if (!ok(credits) && !ok(key)) {
        return {
          status: "error",
          message: httpErrorMessage(credits?.status ?? key?.status ?? 0),
        };
      }

      const fromKey = ok(key) ? keyWindows(key?.body) : { windows: [] };
      return {
        status: "ok",
        plan: fromKey.plan,
        windows: [
          ...(ok(credits) ? creditWindows(credits?.body) : []),
          ...fromKey.windows,
        ],
      };
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  },
};
