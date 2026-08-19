import {
  clampPercent,
  envValue,
  errorMessage,
  finiteNumber,
  httpErrorMessage,
  nonEmptyString,
  parseReset,
  piProviderApiKey,
  record,
  request,
  type HttpResult,
  type ProviderDefinition,
  type ProviderResult,
  type UsageWindow,
} from "../shared.ts";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** Z.ai encodes a quota window as a `(unit, number)` pair; unknown units are ignored. */
function windowDuration(entry: Record<string, unknown>): number | undefined {
  const unitMs: Record<number, number> = {
    3: HOUR_MS,
    4: DAY_MS,
    5: 30 * DAY_MS,
    6: 7 * DAY_MS,
  };
  const unit = finiteNumber(entry.unit);
  const count = finiteNumber(entry.number);
  if (unit === undefined || count === undefined || count <= 0) return undefined;
  const base = unitMs[unit];
  return base === undefined ? undefined : base * count;
}

/** Z.ai answers 200 with an in-body code, so auth and plan state have to be read from the payload. */
function bodyCode(body: unknown): number | undefined {
  return finiteNumber(record(body)?.code);
}

function planName(response: HttpResult): string | undefined {
  const list = record(response.body)?.data;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    const name = nonEmptyString(record(entry)?.productName);
    if (name) return name;
  }
  return undefined;
}

export function mapQuota(body: unknown): UsageWindow[] {
  const root = record(body);
  const container = record(root?.data) ?? root;
  const limits = container?.limits;
  if (!Array.isArray(limits)) return [];

  const windows: UsageWindow[] = [];
  for (const raw of limits) {
    const entry = record(raw);
    if (!entry) continue;
    const type = entry.type ?? entry.name;
    if (type !== "CREDIT_LIMIT" && type !== "TOKENS_LIMIT") continue;

    const usedPercent = finiteNumber(entry.percentage);
    const duration = windowDuration(entry);
    if (usedPercent === undefined || duration === undefined) continue;

    const label = duration < DAY_MS ? "Session" : "Week";
    if (windows.some((window) => window.label === label)) continue;
    windows.push({
      label,
      usedPercent: clampPercent(usedPercent),
      resetsAt: parseReset(entry.nextResetTime),
    });
  }
  return windows;
}

export const zaiProvider: ProviderDefinition = {
  name: "Z.ai",
  fetch: async (ctx): Promise<ProviderResult> => {
    const apiKey =
      envValue("ZAI_API_KEY", "GLM_API_KEY") ??
      (await piProviderApiKey(ctx, "zai"));
    if (!apiKey) {
      return { status: "absent", message: "no ZAI_API_KEY and not connected in Pi" };
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };

    try {
      const quota = await request(QUOTA_URL, { headers });
      if (quota.status === 401 || bodyCode(quota.body) === 401) {
        return { status: "error", message: "Z.ai API key was rejected" };
      }
      if (quota.status < 200 || quota.status >= 300) {
        return { status: "error", message: httpErrorMessage(quota.status) };
      }
      // A valid key without a coding plan: the API answers 200 with success:false.
      if (record(quota.body)?.success === false) {
        const message = nonEmptyString(record(quota.body)?.msg) ?? "";
        return message.toLowerCase().includes("coding plan")
          ? { status: "absent", message: "no active GLM Coding Plan" }
          : { status: "error", message: message || "usage unavailable" };
      }

      const windows = mapQuota(quota.body);
      const subscription = await request(SUBSCRIPTION_URL, { headers }).catch(
        () => undefined,
      );
      return {
        status: "ok",
        plan: subscription && planName(subscription),
        windows,
      };
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  },
};
