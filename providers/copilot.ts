import {
  clampPercent,
  errorMessage,
  finiteNumber,
  homePath,
  httpErrorMessage,
  nonEmptyString,
  parseReset,
  piStoredCredential,
  readJsonIfPresent,
  readTextIfPresent,
  record,
  request,
  type ProviderDefinition,
  type ProviderResult,
  type UsageWindow,
} from "../shared.ts";

const USAGE_URL = "https://api.github.com/copilot_internal/user";

/**
 * A github.com OAuth token from the Copilot editor config. The file is keyed by host — `github.com`
 * in the older `hosts.json`, `github.com:<appId>` in `apps.json`. Only github.com entries are used:
 * an Enterprise host's token must not be sent to api.github.com.
 */
function editorConfigToken(
  config: Record<string, unknown>,
): string | undefined {
  for (const [host, value] of Object.entries(config)) {
    if (host !== "github.com" && !host.startsWith("github.com:")) continue;
    const token = nonEmptyString(record(value)?.oauth_token);
    if (token) return token;
  }
  return undefined;
}

/** The github.com `oauth_token` from the GitHub CLI's `hosts.yml`, without a YAML dependency. */
export function ghHostsToken(text: string): string | undefined {
  let inGitHubCom = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inGitHubCom = line.trimEnd().replace(/:$/, "").trim() === "github.com";
      continue;
    }
    if (!inGitHubCom) continue;
    const match = /^\s+oauth_token:\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return nonEmptyString(match[1].replace(/^["']|["']$/g, ""));
  }
  return undefined;
}

/**
 * A GitHub OAuth token that Copilot tooling already left on this machine. `/copilot_internal/user`
 * wants the GitHub token, not the short-lived Copilot API token, so Pi's credential contributes its
 * refresh value (which is the GitHub OAuth token) rather than what `getProviderAuth` would hand back.
 */
async function resolveToken(): Promise<string | undefined> {
  for (const file of ["apps.json", "hosts.json"]) {
    const config = await readJsonIfPresent(
      homePath(".config", "github-copilot", file),
    ).catch(() => undefined);
    const token = config && editorConfigToken(config);
    if (token) return token;
  }

  const ghHosts = await readTextIfPresent(
    homePath(".config", "gh", "hosts.yml"),
  ).catch(() => undefined);
  const ghToken = ghHosts && ghHostsToken(ghHosts);
  if (ghToken) return ghToken;

  return nonEmptyString((await piStoredCredential("github-copilot"))?.refresh);
}

function planLabel(value: unknown): string | undefined {
  const plan = nonEmptyString(value);
  if (!plan) return undefined;
  return plan
    .split(/[\s_-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A `quota_snapshots` bucket as a percent-used window, or `undefined` when there is no real meter:
 * an unlimited bucket, GitHub's `-1` sentinel, or a zero entitlement (the placeholder returned for
 * org-managed seats and for credits on free plans) would all render as a misleading "0% used".
 */
function window(
  label: string,
  raw: unknown,
  resetsAt: number | undefined,
): UsageWindow | undefined {
  const snapshot = record(raw);
  if (!snapshot) return undefined;

  const entitlement = finiteNumber(snapshot.entitlement);
  const remaining = finiteNumber(snapshot.remaining);
  if (snapshot.unlimited === true || entitlement === -1 || remaining === -1) {
    return undefined;
  }
  if (entitlement === 0) return undefined;

  const percentRemaining = finiteNumber(snapshot.percent_remaining);
  let usedPercent: number;
  if (percentRemaining !== undefined) {
    usedPercent = 100 - percentRemaining;
  } else if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    usedPercent = 100 - (remaining / entitlement) * 100;
  } else {
    return undefined;
  }

  return { label, usedPercent: clampPercent(usedPercent), resetsAt };
}

/** Legacy free-plan shape: remaining counts against monthly limits, no `quota_snapshots`. */
function legacyWindow(
  label: string,
  remaining: unknown,
  total: unknown,
  resetsAt: number | undefined,
): UsageWindow | undefined {
  const limit = finiteNumber(total);
  const left = finiteNumber(remaining);
  if (limit === undefined || limit <= 0 || left === undefined) return undefined;
  return {
    label,
    usedPercent: clampPercent(100 - (left / limit) * 100),
    resetsAt,
  };
}

export const copilotProvider: ProviderDefinition = {
  name: "GitHub Copilot",
  fetch: async (): Promise<ProviderResult> => {
    const token = await resolveToken();
    if (!token) {
      return {
        status: "absent",
        message: "no GitHub token found (sign in to Copilot, or run gh auth login)",
      };
    }

    try {
      const { status, body } = await request(USAGE_URL, {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "Editor-Version": "vscode/1.96.2",
          "Editor-Plugin-Version": "copilot-chat/0.26.7",
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "X-Github-Api-Version": "2025-04-01",
        },
      });

      if (status === 401 || status === 403) {
        return {
          status: "error",
          message: "GitHub token invalid or expired — run gh auth login",
        };
      }
      if (status < 200 || status >= 300) {
        return { status: "error", message: httpErrorMessage(status) };
      }

      const usage = record(body);
      if (!usage) return { status: "error", message: "unexpected response" };

      const plan = planLabel(usage.copilot_plan);
      const resetsAt =
        parseReset(usage.quota_reset_date) ??
        parseReset(usage.limited_user_reset_date);
      const snapshots = record(usage.quota_snapshots);

      const windows = [
        window("Credits", snapshots?.premium_interactions, resetsAt),
        window("Chat", snapshots?.chat, resetsAt),
        window("Completions", snapshots?.completions, resetsAt),
      ].filter((value): value is UsageWindow => value !== undefined);

      if (windows.length === 0) {
        const limited = record(usage.limited_user_quotas);
        const monthly = record(usage.monthly_quotas);
        windows.push(
          ...[
            legacyWindow("Chat", limited?.chat, monthly?.chat, resetsAt),
            legacyWindow(
              "Completions",
              limited?.completions,
              monthly?.completions,
              resetsAt,
            ),
          ].filter((value): value is UsageWindow => value !== undefined),
        );
      }

      // Org-managed (token-based-billing) seats carry no per-seat quota at all. That is a real
      // state, not a failure, so the plan still shows with an empty meter list.
      return { status: "ok", plan, windows };
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  },
};
