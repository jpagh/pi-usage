import {
  clampPercent,
  decodeJwtPayload,
  errorMessage,
  finiteNumber,
  httpErrorMessage,
  parseReset,
  record,
  request,
  type ProviderDefinition,
  type ProviderResult,
  type UsageWindow,
} from "../shared.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function planLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value
    .replace(/prolite/gi, "pro lite")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resetCreditWindow(body: Record<string, unknown> | undefined): UsageWindow | undefined {
  const credits = record(body?.rate_limit_reset_credits);
  const available = finiteNumber(credits?.available_count);
  if (available === undefined || available <= 0) return undefined;
  const count = Math.floor(available);
  return { label: "Resets", trailer: `${count} banked` };
}

function windowSeconds(value: Record<string, unknown>): number | undefined {
  const seconds = finiteNumber(value.limit_window_seconds);
  if (seconds !== undefined) return seconds;
  const minutes = finiteNumber(value.window_minutes);
  return minutes === undefined ? undefined : minutes * 60;
}

function parseWindow(
  value: Record<string, unknown>,
  label: string,
): UsageWindow | undefined {
  const usedPercent = finiteNumber(value.used_percent);
  if (usedPercent === undefined) return undefined;
  return {
    label,
    usedPercent: clampPercent(usedPercent),
    resetsAt: parseReset(value.reset_at ?? value.resets_at),
  };
}

/**
 * Codex reports two windows whose order is not stable, so classify by declared duration: up to six
 * hours is the session window, a day or more is the weekly one.
 */
export function classifyCodexWindows(
  rateLimit: Record<string, unknown> | undefined,
): UsageWindow[] {
  let session: UsageWindow | undefined;
  let week: UsageWindow | undefined;

  for (const raw of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    const value = record(raw);
    if (!value) continue;
    const duration = windowSeconds(value);
    const isSession =
      duration !== undefined
        ? duration <= 6 * 60 * 60
        : session === undefined;

    if (isSession) {
      session ??= parseWindow(value, "Session");
    } else {
      week ??= parseWindow(value, "Week");
    }
  }

  return [session, week].filter(
    (value): value is UsageWindow => value !== undefined,
  );
}

function accountId(accessToken: string): string | undefined {
  const auth = record(
    decodeJwtPayload(accessToken)?.["https://api.openai.com/auth"],
  );
  return typeof auth?.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id
    : undefined;
}

export function codexProviderFor(
  providerId: string,
  name: string,
): ProviderDefinition {
  return {
    name,
    fetch: async (ctx): Promise<ProviderResult> => {
      const resolved = await ctx.modelRegistry
        .getProviderAuth(providerId)
        .catch(() => undefined);
      const accessToken = resolved?.auth.apiKey;
      if (!resolved || resolved.source !== "OAuth" || !accessToken) {
        return { status: "absent", message: "not connected in Pi" };
      }

      const account = accountId(accessToken);
      if (!account) {
        return { status: "error", message: "could not identify the account" };
      }

      try {
        const { status, body } = await request(USAGE_URL, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": account,
            "user-agent": "pi-subscription-usage/1.0",
          },
        });
        if (status === 401 || status === 403) {
          return {
            status: "error",
            message: "Codex token was rejected — sign in again",
          };
        }
        if (status < 200 || status >= 300) {
          return { status: "error", message: httpErrorMessage(status) };
        }

        const usage = record(body);
        const resetCredit = resetCreditWindow(usage);
        return {
          status: "ok",
          plan: planLabel(usage?.plan_type),
          windows: [
            ...classifyCodexWindows(record(usage?.rate_limit)),
            ...(resetCredit ? [resetCredit] : []),
          ],
        };
      } catch (error) {
        return { status: "error", message: errorMessage(error) };
      }
    },
  };
}

export const codexProvider = codexProviderFor("openai-codex", "Codex");

/** A second Codex login (Pi's `openai-codex-work` provider) reports as its own subscription. */
export const codexWorkProvider = codexProviderFor(
  "openai-codex-work",
  "Codex (work)",
);
