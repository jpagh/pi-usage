import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clampPercent,
  envValue,
  errorMessage,
  finiteNumber,
  homePath,
  httpErrorMessage,
  jwtExpiry,
  nonEmptyString,
  parseReset,
  decodeJwtPayload,
  readJsonIfPresent,
  readKeychain,
  record,
  request,
  type ProviderDefinition,
  type ProviderResult,
  type UsageWindow,
} from "../shared.ts";

const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const PERIOD_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const PLAN_INFO_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";
/** Cursor's public installed-app OAuth client, the same one the app and CLI use. */
const CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const REFRESH_TOKEN_KEY = "cursorAuth/refreshToken";
const REFRESH_BUFFER_MS = 5 * 60 * 1_000;
const SIGN_IN_HINT = "sign in to Cursor again";

export function stateDbPath(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  switch (platform) {
    case "darwin":
      return homePath(
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    case "linux":
      return homePath(".config", "Cursor", "User", "globalStorage", "state.vscdb");
    case "win32":
      return join(
        env.APPDATA ?? homePath("AppData", "Roaming"),
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    default:
      return undefined;
  }
}

const SELECT_VALUE = "SELECT value FROM ItemTable WHERE key = ? LIMIT 1";

/**
 * Cursor keeps its tokens in the editor's own key/value store. Read it with whichever SQLite the host
 * runtime provides — `node:sqlite` under Node, `bun:sqlite` under Bun, the `sqlite3` CLI otherwise.
 * All three open the file read-only.
 */
async function readStateValues(
  dbPath: string,
  keys: string[],
): Promise<Map<string, string>> {
  const failures: string[] = [];
  for (const read of [
    readWithNodeSqlite,
    readWithBunSqlite,
    readWithSqliteCli,
  ]) {
    try {
      return await read(dbPath, keys);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  throw new Error(
    `couldn't read Cursor's local state: ${failures.join("; ")}`,
  );
}

async function readWithNodeSqlite(
  dbPath: string,
  keys: string[],
): Promise<Map<string, string>> {
  const { DatabaseSync } = await import("node:sqlite");

  const query = (target: string) => {
    const values = new Map<string, string>();
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      const statement = db.prepare(SELECT_VALUE);
      for (const key of keys) {
        const value = nonEmptyString(record(statement.get(key))?.value);
        if (value) values.set(key, value);
      }
    } finally {
      db.close();
    }
    return values;
  };

  try {
    return query(dbPath);
  } catch {
    // A database still in WAL mode can reject a read-only open; a copy always opens.
    return query(copyForReading(dbPath));
  }
}

interface BunDatabase {
  query: (sql: string) => { get: (...params: string[]) => unknown };
  close: () => void;
}

async function readWithBunSqlite(
  dbPath: string,
  keys: string[],
): Promise<Map<string, string>> {
  // Non-literal specifier: `bun:sqlite` has no types and must not be resolved under Node.
  const specifier = "bun:sqlite";
  const { Database } = (await import(specifier)) as {
    Database: new (path: string, options?: { readonly?: boolean }) => BunDatabase;
  };

  const values = new Map<string, string>();
  const db = new Database(dbPath, { readonly: true });
  try {
    const statement = db.query(SELECT_VALUE);
    for (const key of keys) {
      const value = nonEmptyString(record(statement.get(key))?.value);
      if (value) values.set(key, value);
    }
  } finally {
    db.close();
  }
  return values;
}

export async function readWithSqliteCli(
  dbPath: string,
  keys: string[],
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  for (const key of keys) {
    const sql = `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}' LIMIT 1;`;
    const stdout = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf8",
    });
    if (!stdout.trim()) continue;
    const rows: unknown = JSON.parse(stdout);
    const value = Array.isArray(rows)
      ? nonEmptyString(record(rows[0])?.value)
      : undefined;
    if (value) values.set(key, value);
  }
  return values;
}

function copyForReading(dbPath: string): string {
  const copy = join(mkdtempSync(join(tmpdir(), "pi-usage-cursor-")), "state.vscdb");
  copyFileSync(dbPath, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
  }
  return copy;
}

interface CursorTokens {
  accessToken?: string;
  refreshToken?: string;
  /** A `crsr_…` user API key, which is exchanged for a one-hour access token. */
  apiKey?: string;
}

/** Where the Cursor CLI writes the credential it gets from `agent login` or `CURSOR_API_KEY`. */
export function cliAuthPath(platform: string = process.platform): string | undefined {
  switch (platform) {
    case "darwin":
      return homePath(".cursor", "auth.json");
    case "linux":
      return homePath(".config", "cursor", "auth.json");
    case "win32":
      return join(
        process.env.APPDATA ?? homePath("AppData", "Roaming"),
        "Cursor",
        "auth.json",
      );
    default:
      return undefined;
  }
}

function hasCredential(tokens: CursorTokens): boolean {
  return Boolean(tokens.accessToken ?? tokens.refreshToken ?? tokens.apiKey);
}

/** The CLI credential first (plain JSON), then the desktop app's state database, then the keychain. */
async function loadTokens(): Promise<CursorTokens> {
  const apiKey = envValue("CURSOR_API_KEY");

  const cliPath = cliAuthPath();
  const cliAuth = cliPath
    ? await readJsonIfPresent(cliPath).catch(() => undefined)
    : undefined;
  const fromCli: CursorTokens = {
    accessToken: nonEmptyString(cliAuth?.accessToken),
    refreshToken: nonEmptyString(cliAuth?.refreshToken),
    apiKey: apiKey ?? nonEmptyString(cliAuth?.apiKey),
  };
  if (hasCredential(fromCli)) return fromCli;

  const dbPath = stateDbPath();
  if (dbPath && existsSync(dbPath)) {
    const values = await readStateValues(dbPath, [
      ACCESS_TOKEN_KEY,
      REFRESH_TOKEN_KEY,
    ]);
    const fromDb: CursorTokens = {
      accessToken: values.get(ACCESS_TOKEN_KEY),
      refreshToken: values.get(REFRESH_TOKEN_KEY),
      apiKey,
    };
    if (hasCredential(fromDb)) return fromDb;
  }

  return {
    accessToken: readKeychain("cursor-access-token"),
    refreshToken: readKeychain("cursor-refresh-token"),
    apiKey,
  };
}

/**
 * Trade a `crsr_…` user API key for an access token. Tokens minted this way last about an hour and
 * cannot be refreshed through the OAuth grant, so they are re-exchanged instead.
 */
async function exchangeApiKey(apiKey: string): Promise<string | undefined> {
  const { status, body } = await request(EXCHANGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (status === 401 || status === 403) {
    throw new Error("Cursor API key was rejected");
  }
  if (status < 200 || status >= 300) return undefined;
  return nonEmptyString(record(body)?.accessToken);
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<string | undefined> {
  const { status, body } = await request(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (record(body)?.shouldLogout === true) {
    throw new Error(`Cursor session expired — ${SIGN_IN_HINT}`);
  }
  if (status < 200 || status >= 300) return undefined;
  return nonEmptyString(record(body)?.access_token);
}

/**
 * The dashboard's session cookie. The user id is the second segment of the token's JWT subject
 * (`auth0|user_...`), and the cookie pairs it with the access token.
 */
export function sessionCookie(accessToken: string): string | undefined {
  const subject = nonEmptyString(decodeJwtPayload(accessToken)?.sub);
  if (!subject) return undefined;
  const parts = subject.split("|");
  const userId = parts.length > 1 ? parts[1] : parts[0];
  return userId?.trim() ? `${userId}%3A%3A${accessToken}` : undefined;
}

function planLabel(value: unknown): string | undefined {
  const plan = nonEmptyString(value);
  if (!plan) return undefined;
  return plan
    .split(/[\s_-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function connectPost(url: string, accessToken: string) {
  return request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
  });
}

/** `GetCurrentPeriodUsage`: spend figures are in cents, and the cycle bounds are epoch-ms strings. */
export function mapPeriodUsage(body: unknown): {
  windows: UsageWindow[];
} {
  const usage = record(body);
  const plan = record(usage?.planUsage);
  const resetsAt = parseReset(usage?.billingCycleEnd);

  const limit = finiteNumber(plan?.limit);
  const spend = finiteNumber(plan?.totalSpend);
  const usedPercent =
    finiteNumber(plan?.totalPercentUsed) ??
    (limit !== undefined && limit > 0 && spend !== undefined
      ? (spend / limit) * 100
      : undefined);

  return {
    windows:
      usedPercent === undefined
        ? []
        : [{ label: "Cycle", usedPercent: clampPercent(usedPercent), resetsAt }],
  };
}

export function mapUsageSummary(body: unknown): {
  plan?: string;
  windows: UsageWindow[];
} {
  const summary = record(body);
  const plan = record(record(summary?.individualUsage)?.plan);
  const resetsAt = parseReset(summary?.billingCycleEnd);

  const reported = finiteNumber(plan?.totalPercentUsed);
  const limit = finiteNumber(plan?.limit);
  const used = finiteNumber(plan?.used);
  const computed =
    limit !== undefined && limit > 0 && used !== undefined
      ? (used / limit) * 100
      : undefined;
  const usedPercent = reported ?? computed;

  return {
    plan: planLabel(summary?.membershipType),
    windows:
      usedPercent === undefined
        ? []
        : [{ label: "Cycle", usedPercent: clampPercent(usedPercent), resetsAt }],
  };
}

/** The dashboard's cookie route, which is all a pasted `CURSOR_SESSION_TOKEN` can drive. */
async function fetchViaCookie(cookie: string): Promise<ProviderResult> {
  const { status, body } = await request(USAGE_SUMMARY_URL, {
    headers: {
      Cookie: `WorkosCursorSessionToken=${cookie}`,
      Accept: "application/json",
    },
  });
  if (status === 401 || status === 403) {
    return { status: "error", message: `session expired — ${SIGN_IN_HINT}` };
  }
  if (status < 200 || status >= 300) {
    return { status: "error", message: httpErrorMessage(status) };
  }
  return { status: "ok", ...mapUsageSummary(body) };
}

/** Resolve an access token, minting a fresh one when the stored one is missing or near expiry. */
async function resolveAccessToken(tokens: CursorTokens): Promise<string | undefined> {
  const expiry = tokens.accessToken ? jwtExpiry(tokens.accessToken) : undefined;
  const usable =
    tokens.accessToken !== undefined &&
    expiry !== undefined &&
    expiry > Date.now() + REFRESH_BUFFER_MS;
  if (usable) return tokens.accessToken;

  if (tokens.apiKey) {
    const exchanged = await exchangeApiKey(tokens.apiKey);
    if (exchanged) return exchanged;
  }
  if (tokens.refreshToken) {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    if (refreshed) return refreshed;
  }
  return tokens.accessToken;
}

export const cursorProvider: ProviderDefinition = {
  name: "Cursor",
  fetch: async (): Promise<ProviderResult> => {
    const pastedCookie = envValue("CURSOR_SESSION_TOKEN");
    if (pastedCookie) {
      try {
        return await fetchViaCookie(pastedCookie);
      } catch (error) {
        return { status: "error", message: errorMessage(error) };
      }
    }

    try {
      const tokens = await loadTokens();
      if (!hasCredential(tokens)) {
        return { status: "absent", message: "not signed in to Cursor" };
      }

      const accessToken = await resolveAccessToken(tokens);
      if (!accessToken) {
        return { status: "error", message: `no usable token — ${SIGN_IN_HINT}` };
      }

      // The Bearer route is the one the CLI uses and needs no cookie composition; the dashboard's
      // cookie endpoint is the fallback, and the only one that reports the plan on team accounts.
      const usage = await connectPost(PERIOD_USAGE_URL, accessToken);
      if (usage.status >= 200 && usage.status < 300) {
        const mapped = mapPeriodUsage(usage.body);
        if (mapped.windows.length > 0) {
          const planInfo = await connectPost(PLAN_INFO_URL, accessToken).catch(
            () => undefined,
          );
          return {
            status: "ok",
            plan: nonEmptyString(
              record(record(planInfo?.body)?.planInfo)?.planName,
            ),
            ...mapped,
          };
        }
      }

      const cookie = sessionCookie(accessToken);
      if (!cookie) {
        return usage.status === 401 || usage.status === 403
          ? { status: "error", message: `session expired — ${SIGN_IN_HINT}` }
          : { status: "error", message: httpErrorMessage(usage.status) };
      }
      return await fetchViaCookie(cookie);
    } catch (error) {
      return { status: "error", message: errorMessage(error) };
    }
  },
};
