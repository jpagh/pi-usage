/**
 * Offline checks for the usage providers: credential discovery, request shape, and payload mapping.
 * Run: bun test.ts (or: node --experimental-strip-types test.ts)
 *
 * Every provider is exercised against captured response shapes with `fetch` stubbed and credentials
 * planted in a temporary HOME, so no subscription is needed. Nothing here touches the network.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { plainFormat, renderUsageLines, visibleReports } from "./format.ts";
import { claudeProvider } from "./providers/claude.ts";
import { codexProvider } from "./providers/codex.ts";
import { copilotProvider, ghHostsToken } from "./providers/copilot.ts";
import {
  cursorProvider,
  mapPeriodUsage,
  readWithSqliteCli,
  sessionCookie,
} from "./providers/cursor.ts";
import { opencodeProvider } from "./providers/opencode.ts";
import { openrouterProvider } from "./providers/openrouter.ts";
import { mapQuota, zaiProvider } from "./providers/zai.ts";
import type { ProviderDefinition, ProviderResult } from "./shared.ts";

// ---------------------------------------------------------------- harness

interface StubResponse {
  status?: number;
  body: unknown;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let calls: Call[] = [];
let routes: Record<string, StubResponse> = {};

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  calls.push({
    url,
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === "string" ? init.body : undefined,
  });
  const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
  if (!route) throw new Error(`unstubbed request: ${url}`);
  const { status = 200, body } = route[1];
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
  });
}) as typeof fetch;

/** A context whose provider auth is empty unless a test supplies one. */
function fakeContext(
  auth: Record<string, { source: string; apiKey: string }> = {},
) {
  return {
    modelRegistry: {
      getProviderAuth: async (id: string) => {
        const entry = auth[id];
        return entry
          ? { source: entry.source, auth: { apiKey: entry.apiKey } }
          : undefined;
      },
    },
  } as never;
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

let home = "";
let failures = 0;
let passed = 0;
const originalPath = process.env.PATH;

/** A fresh empty HOME and environment for each case, so nothing leaks between tests. */
function reset(env: Record<string, string | undefined> = {}) {
  calls = [];
  routes = {};
  home = mkdtempSync(join(tmpdir(), "usage-home-"));
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CURSOR_API_KEY",
    "CURSOR_SESSION_TOKEN",
    "GLM_API_KEY",
    "OPENCODE_DATA_DIR",
    "OPENROUTER_API_KEY",
    "PI_CODING_AGENT_DIR",
    "XDG_DATA_HOME",
    "ZAI_API_KEY",
  ]) {
    delete process.env[name];
  }
  process.env.HOME = home;
  process.env.PATH = originalPath;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run();
    passed += 1;
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : error}`);
  }
}

async function fetchProvider(
  provider: ProviderDefinition,
  auth?: Record<string, { source: string; apiKey: string }>,
): Promise<ProviderResult> {
  return provider.fetch(fakeContext(auth));
}

function windowsOf(result: ProviderResult): Record<string, number | undefined> {
  assert.equal(result.status, "ok", `expected ok, got ${JSON.stringify(result)}`);
  if (result.status !== "ok") throw new Error("unreachable");
  return Object.fromEntries(
    result.windows.map((window) => [window.label, window.usedPercent]),
  );
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

// ---------------------------------------------------------------- Claude

await check("claude: maps five_hour/seven_day from Claude Code credentials", async () => {
  reset();
  writeJson(join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: { accessToken: "sk-ant-oat-test", expiresAt: Date.now() + 60_000 },
  });
  routes["https://api.anthropic.com/api/oauth/usage"] = {
    body: {
      five_hour: { utilization: 77, resets_at: "2026-08-19T20:00:00Z" },
      seven_day: { utilization: 72.4, resets_at: "2026-08-22T05:00:00Z" },
    },
  };

  const result = await fetchProvider(claudeProvider);
  assert.deepEqual(windowsOf(result), { Session: 77, Week: 72.4 });
  assert.equal(calls[0]?.headers.Authorization, "Bearer sk-ant-oat-test");
  assert.equal(calls[0]?.headers["anthropic-beta"], "oauth-2025-04-20");
});

await check("claude: expired Claude Code token reads as absent", async () => {
  reset();
  writeJson(join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: { accessToken: "sk-ant-oat-test", expiresAt: Date.now() - 1_000 },
  });

  const result = await fetchProvider(claudeProvider);
  assert.equal(result.status, "absent");
  assert.equal(calls.length, 0);
});

await check("claude: rejected token reports an error", async () => {
  reset();
  writeJson(join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: { accessToken: "stale", expiresAt: Date.now() + 60_000 },
  });
  routes["https://api.anthropic.com"] = { status: 401, body: { error: "nope" } };

  const result = await fetchProvider(claudeProvider);
  assert.equal(result.status, "error");
  assert.match(result.status === "error" ? result.message : "", /rejected/);
});

// ---------------------------------------------------------------- Codex

await check("codex: classifies windows by duration, not payload order", async () => {
  reset();
  routes["https://chatgpt.com/backend-api/wham/usage"] = {
    body: {
      rate_limit: {
        primary_window: {
          used_percent: 96,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: 1787214371,
        },
        secondary_window: {
          used_percent: 12,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: 1787169599,
        },
      },
    },
  };

  const result = await fetchProvider(codexProvider, {
    "openai-codex": {
      source: "OAuth",
      apiKey: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
      }),
    },
  });
  assert.deepEqual(windowsOf(result), { Session: 12, Week: 96 });
  assert.equal(calls[0]?.headers["chatgpt-account-id"], "acct_123");
});

await check("codex: without a Pi credential it is absent", async () => {
  reset();
  const result = await fetchProvider(codexProvider);
  assert.equal(result.status, "absent");
});

// ---------------------------------------------------------------- Cursor

function writeCursorStateDb(dbPath: string, values: Record<string, string>) {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values)) insert.run(key, value);
  db.close();
}

const cursorSummary = {
  billingCycleStart: "2026-08-01T00:00:00.000Z",
  billingCycleEnd: "2026-09-01T00:00:00.000Z",
  membershipType: "pro",
  individualUsage: {
    plan: { enabled: true, used: 1500, limit: 2000, totalPercentUsed: 75 },
    onDemand: { enabled: true, used: 2309, limit: null },
  },
};

/** `GetCurrentPeriodUsage`: cents, and cycle bounds as epoch-ms strings. */
const cursorPeriodUsage = {
  billingCycleStart: "1784958141000",
  billingCycleEnd: "1787550141000",
  planUsage: {
    limit: 2_000,
    totalSpend: 1_060,
    remaining: 940,
    autoPercentUsed: 12,
    apiPercentUsed: 41,
    totalPercentUsed: 53,
  },
};

const freshToken = () =>
  jwt({ sub: "auth0|user_01ABC", exp: Math.floor(Date.now() / 1_000) + 3_600 });

await check("cursor: state database token drives the Bearer route", async () => {
  reset();
  const token = freshToken();
  writeCursorStateDb(
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    { "cursorAuth/accessToken": token, "cursorAuth/refreshToken": "refresh-me" },
  );
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"] =
    { body: cursorPeriodUsage };
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"] = {
    body: { planInfo: { planName: "Pro+", price: "$60/mo" } },
  };

  const result = await fetchProvider(cursorProvider);
  assert.deepEqual(windowsOf(result), { Cycle: 53 });
  assert.equal(result.status === "ok" ? result.plan : undefined, "Pro+");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0]?.headers["Connect-Protocol-Version"], "1");
});

await check("cursor: epoch-ms string cycle end becomes a real reset time", () => {
  const [window] = mapPeriodUsage(cursorPeriodUsage).windows;
  assert.equal(window?.resetsAt, 1_787_550_141_000);
  // Percent is computed from cents when the payload omits totalPercentUsed.
  const computed = mapPeriodUsage({
    billingCycleEnd: "1787550141000",
    planUsage: { limit: 2_000, totalSpend: 500 },
  });
  assert.equal(computed.windows[0]?.usedPercent, 25);
});

await check("cursor: CURSOR_API_KEY is exchanged for an access token", async () => {
  reset({ CURSOR_API_KEY: "crsr_test_key" });
  const token = freshToken();
  routes["https://api2.cursor.sh/auth/exchange_user_api_key"] = {
    body: { accessToken: token, refreshToken: "eyJ-refresh" },
  };
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"] =
    { body: cursorPeriodUsage };
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"] = {
    body: {},
  };

  const result = await fetchProvider(cursorProvider);
  assert.deepEqual(windowsOf(result), { Cycle: 53 });
  assert.equal(calls[0]?.url, "https://api2.cursor.sh/auth/exchange_user_api_key");
  assert.equal(calls[0]?.headers.Authorization, "Bearer crsr_test_key");
  assert.equal(calls[1]?.headers.Authorization, `Bearer ${token}`);
});

await check("cursor: a rejected API key reports the key, not a sign-in", async () => {
  reset({ CURSOR_API_KEY: "crsr_bad" });
  routes["https://api2.cursor.sh/auth/exchange_user_api_key"] = {
    status: 401,
    body: { code: "error", message: "Invalid User API Key" },
  };

  const result = await fetchProvider(cursorProvider);
  assert.equal(result.status, "error");
  assert.match(result.status === "error" ? result.message : "", /API key was rejected/);
});

await check("cursor: the CLI auth.json is preferred over the state database", async () => {
  reset();
  const cliToken = freshToken();
  writeJson(join(home, ".config", "cursor", "auth.json"), {
    accessToken: cliToken,
    refreshToken: "eyJ-refresh",
    apiKey: "crsr_from_file",
  });
  writeCursorStateDb(
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    { "cursorAuth/accessToken": jwt({ sub: "auth0|other", exp: 1 }) },
  );
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"] =
    { body: cursorPeriodUsage };
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"] = { body: {} };

  const result = await fetchProvider(cursorProvider);
  assert.equal(result.status, "ok");
  assert.equal(calls[0]?.headers.Authorization, `Bearer ${cliToken}`);
});

await check("cursor: falls back to the cookie route when the Bearer route has no meters", async () => {
  reset();
  const token = freshToken();
  writeJson(join(home, ".config", "cursor", "auth.json"), { accessToken: token });
  // An enterprise seat whose planUsage carries no limit or percentage.
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"] =
    { body: { billingCycleEnd: "1787550141000", planUsage: {} } };
  routes["https://cursor.com/api/usage-summary"] = { body: cursorSummary };

  const result = await fetchProvider(cursorProvider);
  assert.deepEqual(windowsOf(result), { Cycle: 75 });
  assert.equal(result.status === "ok" ? result.plan : undefined, "Pro");
  assert.equal(
    calls.at(-1)?.headers.Cookie,
    `WorkosCursorSessionToken=user_01ABC%3A%3A${token}`,
  );
});

await check("cursor: refreshes an expired access token before querying usage", async () => {
  reset();
  const fresh = jwt({
    sub: "auth0|user_01ABC",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  writeCursorStateDb(
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    {
      "cursorAuth/accessToken": jwt({
        sub: "auth0|user_01ABC",
        exp: Math.floor(Date.now() / 1_000) - 10,
      }),
      "cursorAuth/refreshToken": "refresh-me",
    },
  );
  routes["https://api2.cursor.sh/oauth/token"] = { body: { access_token: fresh } };
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"] =
    { body: cursorPeriodUsage };
  routes["https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"] = { body: {} };

  const result = await fetchProvider(cursorProvider);
  assert.deepEqual(windowsOf(result), { Cycle: 53 });
  assert.equal(calls[0]?.url, "https://api2.cursor.sh/oauth/token");
  assert.match(calls[0]?.body ?? "", /refresh_token/);
  assert.equal(calls[1]?.headers.Authorization, `Bearer ${fresh}`);
});

await check("cursor: shouldLogout on refresh surfaces a sign-in error", async () => {
  // The live endpoint answers 200 with an empty token and shouldLogout for a dead refresh token,
  // so the flag has to be honoured regardless of status.
  for (const status of [200, 401]) {
    reset();
    writeCursorStateDb(
      join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
      { "cursorAuth/refreshToken": "dead" },
    );
    routes["https://api2.cursor.sh/oauth/token"] = {
      status,
      body: { access_token: "", id_token: "", shouldLogout: true },
    };

    const result = await fetchProvider(cursorProvider);
    assert.equal(result.status, "error", `status ${status}`);
    assert.match(
      result.status === "error" ? result.message : "",
      /sign in to Cursor/,
    );
  }
});

await check("cursor: CURSOR_SESSION_TOKEN bypasses local credential lookup", async () => {
  reset({ CURSOR_SESSION_TOKEN: "user_9%3A%3Araw-cookie" });
  routes["https://cursor.com/api/usage-summary"] = { body: cursorSummary };

  const result = await fetchProvider(cursorProvider);
  assert.deepEqual(windowsOf(result), { Cycle: 75 });
  assert.equal(
    calls[0]?.headers.Cookie,
    "WorkosCursorSessionToken=user_9%3A%3Araw-cookie",
  );
});

await check("cursor: no local login is absent, not an error", async () => {
  reset();
  const result = await fetchProvider(cursorProvider);
  assert.equal(result.status, "absent");
});

await check("cursor: the sqlite3 CLI fallback parses -json output", async () => {
  reset();
  // Stands in for the sqlite3 CLI (absent here, and the only reader available to Bun builds of pi
  // that lack node:sqlite). Honours -readonly/-json and emits the same JSON row array.
  const binDir = mkdtempSync(join(tmpdir(), "usage-bin-"));
  writeFileSync(
    join(binDir, "sqlite3"),
    [
      "#!/usr/bin/env python3",
      "import json, sqlite3, sys",
      "args = [a for a in sys.argv[1:] if not a.startswith('-')]",
      "assert '-readonly' in sys.argv and '-json' in sys.argv",
      "con = sqlite3.connect(args[0])",
      "rows = con.execute(args[1]).fetchall()",
      "print(json.dumps([{'value': r[0]} for r in rows]) if rows else '')",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  const dbPath = join(home, "state.vscdb");
  writeCursorStateDb(dbPath, { "cursorAuth/accessToken": "token-from-cli" });
  const values = await readWithSqliteCli(dbPath, [
    "cursorAuth/accessToken",
    "cursorAuth/missing",
  ]);
  assert.equal(values.get("cursorAuth/accessToken"), "token-from-cli");
  assert.equal(values.has("cursorAuth/missing"), false);
});

await check("cursor: percent falls back to used/limit when not reported", () => {
  const cookie = sessionCookie(jwt({ sub: "auth0|user_1" }));
  assert.equal(cookie?.startsWith("user_1%3A%3A"), true);
  assert.equal(sessionCookie("not-a-jwt"), undefined);
});

await check("cursor: enterprise summary without totalPercentUsed computes usage", async () => {
  reset({ CURSOR_SESSION_TOKEN: "user_9%3A%3Araw" });
  routes["https://cursor.com/api/usage-summary"] = {
    body: {
      billingCycleEnd: "2026-09-01T00:00:00.000Z",
      membershipType: "enterprise",
      individualUsage: { plan: { enabled: true, used: 250, limit: 1000 } },
    },
  };

  const result = await fetchProvider(cursorProvider);
  assert.deepEqual(windowsOf(result), { Cycle: 25 });
});

// ---------------------------------------------------------------- Copilot

const copilotPaid = {
  copilot_plan: "pro",
  quota_reset_date: "2099-01-15T00:00:00Z",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      remaining: 123,
      percent_remaining: 41,
    },
    chat: { entitlement: 1000, remaining: 950, percent_remaining: 95 },
    completions: { entitlement: -1, remaining: -1 },
  },
};

await check("copilot: reads the editor token and maps percent remaining to used", async () => {
  reset();
  writeJson(join(home, ".config", "github-copilot", "apps.json"), {
    "github.com:Iv1.b507a08c87ecfe98": { oauth_token: "gho_editor_token" },
  });
  routes["https://api.github.com/copilot_internal/user"] = { body: copilotPaid };

  const result = await fetchProvider(copilotProvider);
  assert.deepEqual(windowsOf(result), { Credits: 59, Chat: 5 });
  assert.equal(result.status === "ok" ? result.plan : undefined, "Pro");
  assert.equal(calls[0]?.headers.Authorization, "token gho_editor_token");
  assert.equal(calls[0]?.headers["X-Github-Api-Version"], "2025-04-01");
});

await check("copilot: ignores non-github.com hosts in the editor config", async () => {
  reset();
  writeJson(join(home, ".config", "github-copilot", "apps.json"), {
    "github.enterprise.corp:Iv1.abc": { oauth_token: "gho_enterprise" },
  });

  const result = await fetchProvider(copilotProvider);
  assert.equal(result.status, "absent");
  assert.equal(calls.length, 0);
});

await check("copilot: falls back to the gh CLI token", async () => {
  reset();
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(
    join(home, ".config", "gh", "hosts.yml"),
    [
      "github.enterprise.corp:",
      "    oauth_token: gho_enterprise",
      "    user: someone",
      "github.com:",
      "    user: octocat",
      "    oauth_token: gho_cli_token",
      "    git_protocol: https",
    ].join("\n"),
  );
  routes["https://api.github.com/copilot_internal/user"] = { body: copilotPaid };

  const result = await fetchProvider(copilotProvider);
  assert.equal(result.status, "ok");
  assert.equal(calls[0]?.headers.Authorization, "token gho_cli_token");
});

await check("copilot: falls back to Pi's stored GitHub token", async () => {
  reset();
  const configDir = join(home, "pi-agent");
  writeJson(join(configDir, "auth.json"), {
    "github-copilot": { type: "oauth", access: "copilot-api-token", refresh: "gho_pi_token" },
  });
  process.env.PI_CODING_AGENT_DIR = configDir;
  routes["https://api.github.com/copilot_internal/user"] = { body: copilotPaid };

  const result = await fetchProvider(copilotProvider);
  assert.equal(result.status, "ok");
  // The GitHub OAuth token, not the short-lived Copilot API token.
  assert.equal(calls[0]?.headers.Authorization, "token gho_pi_token");
});

await check("copilot: free-plan legacy quotas map when snapshots are absent", async () => {
  reset();
  writeJson(join(home, ".config", "github-copilot", "hosts.json"), {
    "github.com": { oauth_token: "gho_free" },
  });
  routes["https://api.github.com/copilot_internal/user"] = {
    body: {
      copilot_plan: "free",
      limited_user_reset_date: "2099-02-01T00:00:00Z",
      limited_user_quotas: { chat: 25, completions: 1000 },
      monthly_quotas: { chat: 50, completions: 2000 },
    },
  };

  const result = await fetchProvider(copilotProvider);
  assert.deepEqual(windowsOf(result), { Chat: 50, Completions: 50 });
});

await check("copilot: org-managed seat keeps the plan with no meters", async () => {
  reset();
  writeJson(join(home, ".config", "github-copilot", "hosts.json"), {
    "github.com": { oauth_token: "gho_org" },
  });
  routes["https://api.github.com/copilot_internal/user"] = {
    body: {
      copilot_plan: "business",
      token_based_billing: true,
      quota_snapshots: {
        premium_interactions: { entitlement: 0, remaining: 0, overage_permitted: true },
      },
    },
  };

  const result = await fetchProvider(copilotProvider);
  assert.deepEqual(windowsOf(result), {});
  assert.equal(result.status === "ok" ? result.plan : undefined, "Business");
});

await check("copilot: gh hosts.yml parser is scoped to github.com", () => {
  assert.equal(
    ghHostsToken("github.com:\n    oauth_token: gho_a\n"),
    "gho_a",
  );
  assert.equal(
    ghHostsToken("ghe.example.com:\n    oauth_token: gho_b\n"),
    undefined,
  );
  assert.equal(ghHostsToken('github.com:\n    oauth_token: "gho_c"\n'), "gho_c");
});

// ---------------------------------------------------------------- OpenCode

await check("opencode: reads the Go key from auth.json and maps three windows", async () => {
  reset();
  const dataDir = join(home, "oc-data");
  writeJson(join(dataDir, "auth.json"), {
    anthropic: { type: "api", key: "sk-ant-unrelated" },
    "opencode-go": { type: "api", key: "oc_go_key" },
  });
  process.env.OPENCODE_DATA_DIR = dataDir;
  routes["https://opencode.ai/zen/go/v1/usage"] = {
    body: {
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-08-19T21:00:00.000Z" },
        weekly: { status: "ok", percent: 8, resetsAt: "2026-08-24T00:00:00.000Z" },
        monthly: { status: "ok", percent: 35, resetsAt: "2026-09-04T11:18:32.000Z" },
      },
    },
  };

  const result = await fetchProvider(opencodeProvider);
  assert.deepEqual(windowsOf(result), { Session: 12, Week: 8, Month: 35 });
  assert.equal(calls[0]?.headers.Authorization, "Bearer oc_go_key");
});

await check("opencode: honours XDG_DATA_HOME", async () => {
  reset();
  const xdg = join(home, "xdg");
  writeJson(join(xdg, "opencode", "auth.json"), {
    "opencode-go": { type: "api", key: "oc_xdg_key" },
  });
  process.env.XDG_DATA_HOME = xdg;
  routes["https://opencode.ai"] = { body: { usage: {} } };

  const result = await fetchProvider(opencodeProvider);
  assert.equal(result.status, "ok");
  assert.equal(calls[0]?.headers.Authorization, "Bearer oc_xdg_key");
});

await check("opencode: 403 on a Zen-only key is absent, 401 is an error", async () => {
  reset();
  const dataDir = join(home, "oc-data");
  writeJson(join(dataDir, "auth.json"), { "opencode-go": { key: "oc_key" } });
  process.env.OPENCODE_DATA_DIR = dataDir;

  routes["https://opencode.ai"] = {
    status: 403,
    body: { type: "error", error: { type: "EntitlementError", message: "no go" } },
  };
  assert.equal((await fetchProvider(opencodeProvider)).status, "absent");

  routes["https://opencode.ai"] = {
    status: 401,
    body: { type: "error", error: { type: "AuthError", message: "Unauthorized" } },
  };
  assert.equal((await fetchProvider(opencodeProvider)).status, "error");
});

await check("opencode: no auth.json falls back to Pi's key, else absent", async () => {
  reset();
  assert.equal((await fetchProvider(opencodeProvider)).status, "absent");

  routes["https://opencode.ai"] = { body: { usage: {} } };
  const result = await fetchProvider(opencodeProvider, {
    "opencode-go": { source: "ApiKey", apiKey: "oc_pi_key" },
  });
  assert.equal(result.status, "ok");
  assert.equal(calls[0]?.headers.Authorization, "Bearer oc_pi_key");
});

// ---------------------------------------------------------------- Z.ai

/** Captured GLM Coding Pro shape (percentage quotas + monthly web-search entry). */
const zaiQuota = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    level: "pro",
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 17, nextResetTime: 1782724971179 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 3, nextResetTime: 1783305486997 },
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 0, percentage: 0 },
    ],
  },
};

await check("zai: maps session and weekly percentages by window unit", async () => {
  reset({ ZAI_API_KEY: "zai_key" });
  routes["https://api.z.ai/api/monitor/usage/quota/limit"] = { body: zaiQuota };
  routes["https://api.z.ai/api/biz/subscription/list"] = {
    body: {
      code: 200,
      success: true,
      data: [{ productName: "GLM Coding Pro", status: "VALID" }],
    },
  };

  const result = await fetchProvider(zaiProvider);
  assert.deepEqual(windowsOf(result), { Session: 17, Week: 3 });
  assert.equal(result.status === "ok" ? result.plan : undefined, "GLM Coding Pro");
  assert.equal(calls[0]?.headers.Authorization, "Bearer zai_key");
});

await check("zai: CREDIT_LIMIT is treated like TOKENS_LIMIT", () => {
  const windows = mapQuota({
    data: {
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 0 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 98, nextResetTime: 1786685679998 },
      ],
    },
  });
  assert.deepEqual(
    windows.map((window) => [window.label, window.usedPercent]),
    [
      ["Session", 0],
      ["Week", 98],
    ],
  );
});

await check("zai: an unrecognized window unit is ignored, not mislabelled", () => {
  const windows = mapQuota({
    data: {
      limits: [
        { type: "CREDIT_LIMIT", unit: 99, number: 1, percentage: 42 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 7 },
      ],
    },
  });
  assert.deepEqual(
    windows.map((window) => [window.label, window.usedPercent]),
    [["Week", 7]],
  );
});

await check("zai: in-body 401 is an error, missing coding plan is absent", async () => {
  reset({ ZAI_API_KEY: "zai_key" });
  routes["https://api.z.ai"] = {
    body: { code: 401, msg: "token expired or incorrect", success: false },
  };
  const rejected = await fetchProvider(zaiProvider);
  assert.equal(rejected.status, "error");
  assert.match(rejected.status === "error" ? rejected.message : "", /rejected/);

  reset({ ZAI_API_KEY: "zai_key" });
  routes["https://api.z.ai"] = {
    body: { code: 500, msg: "Please subscribe to a coding plan", success: false },
  };
  assert.equal((await fetchProvider(zaiProvider)).status, "absent");
});

await check("zai: legacy GLM_API_KEY is accepted", async () => {
  reset({ GLM_API_KEY: "glm_key" });
  routes["https://api.z.ai"] = { body: zaiQuota };

  assert.equal((await fetchProvider(zaiProvider)).status, "ok");
  assert.equal(calls[0]?.headers.Authorization, "Bearer glm_key");
});

// ---------------------------------------------------------------- OpenRouter

await check("openrouter: credits meter plus balance, with the key's spend cap", async () => {
  reset({ OPENROUTER_API_KEY: "sk-or-test" });
  routes["https://openrouter.ai/api/v1/credits"] = {
    body: { data: { total_credits: 25, total_usage: 10.25 } },
  };
  routes["https://openrouter.ai/api/v1/key"] = {
    body: {
      data: {
        label: "pi",
        is_free_tier: false,
        usage: 10.25,
        limit: 20,
        limit_remaining: 15,
      },
    },
  };

  const result = await fetchProvider(openrouterProvider);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  assert.deepEqual(
    result.windows.map((w) => [w.label, w.usedPercent, w.trailer]),
    [
      ["Credits", 41, "$10.25 of $25.00"],
      ["Balance", undefined, "$14.75 left"],
      ["Key limit", 25, "$5.00 of $20.00"],
    ],
  );
  assert.equal(result.plan, "Pay as you go");
  assert.equal(calls[0]?.headers.Authorization, "Bearer sk-or-test");
});

await check("openrouter: an account that never topped up still reports a balance", async () => {
  reset({ OPENROUTER_API_KEY: "sk-or-test" });
  routes["https://openrouter.ai/api/v1/credits"] = {
    body: { data: { total_credits: 0, total_usage: 0 } },
  };
  routes["https://openrouter.ai/api/v1/key"] = {
    body: { data: { is_free_tier: true, usage: 0, limit: null } },
  };

  const result = await fetchProvider(openrouterProvider);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  assert.deepEqual(
    result.windows.map((w) => [w.label, w.trailer]),
    [["Balance", "$0.00 left"]],
  );
  assert.equal(result.plan, "Free tier");
});

await check("openrouter: one gated endpoint still yields the other's rows", async () => {
  reset({ OPENROUTER_API_KEY: "sk-or-test" });
  routes["https://openrouter.ai/api/v1/credits"] = {
    status: 404,
    body: { error: { message: "not available for this key" } },
  };
  routes["https://openrouter.ai/api/v1/key"] = {
    body: { data: { is_free_tier: false, limit: 10, limit_remaining: 2.5 } },
  };

  const result = await fetchProvider(openrouterProvider);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  assert.deepEqual(
    result.windows.map((w) => [w.label, w.usedPercent]),
    [["Key limit", 75]],
  );
});

await check("openrouter: a rejected key is an error, a missing key is absent", async () => {
  reset({ OPENROUTER_API_KEY: "sk-or-bad" });
  routes["https://openrouter.ai/api/v1"] = {
    status: 401,
    body: { error: { message: "Missing Authentication header", code: 401 } },
  };
  const rejectedResult = await fetchProvider(openrouterProvider);
  assert.equal(rejectedResult.status, "error");
  assert.match(
    rejectedResult.status === "error" ? rejectedResult.message : "",
    /rejected/,
  );

  reset();
  assert.equal((await fetchProvider(openrouterProvider)).status, "absent");

  reset();
  routes["https://openrouter.ai/api/v1"] = { body: { data: { total_usage: 1 } } };
  const viaPi = await fetchProvider(openrouterProvider, {
    openrouter: { source: "OAuth", apiKey: "sk-or-from-pi" },
  });
  assert.equal(viaPi.status, "ok");
  assert.equal(calls[0]?.headers.Authorization, "Bearer sk-or-from-pi");
});

// ---------------------------------------------------------------- rendering

await check("render: absent providers are hidden unless requested", () => {
  const reports = [
    { name: "Claude Code", windows: [{ label: "Session", usedPercent: 77 }] },
    { name: "Cursor", windows: [], note: "not signed in to Cursor" },
  ];
  assert.deepEqual(
    visibleReports(reports, false).map((report) => report.name),
    ["Claude Code"],
  );
  assert.deepEqual(
    visibleReports(reports, true).map((report) => report.name),
    ["Claude Code", "Cursor"],
  );
  assert.deepEqual(
    visibleReports([reports[1]!], false).map((report) => report.name),
    ["No connected subscriptions"],
  );
});

await check("render: columns line up per provider and plans are shown", () => {
  const resetsAt = new Date("2026-08-22T05:00:00Z").getTime();
  const text = renderUsageLines(
    [
      {
        name: "GitHub Copilot",
        plan: "Pro",
        windows: [
          { label: "Credits", usedPercent: 59, resetsAt },
          { label: "Completions", usedPercent: 5.5, resetsAt },
        ],
      },
      { name: "Cursor", windows: [], error: "Unavailable: session expired" },
    ],
    plainFormat,
  ).join("\n");

  const lines = text.split("\n");
  assert.equal(lines[0], "GitHub Copilot (Pro)");
  // Both meters put "resets" in the same column.
  assert.equal(lines[1]?.indexOf("resets"), lines[2]?.indexOf("resets"));
  assert.match(lines[1] ?? "", /Credits:\s+59% used,\s+resets/);
  assert.match(lines[2] ?? "", /Completions:\s+5\.5% used,\s+resets/);
  assert.equal(lines[3], "");
  assert.equal(lines[4], "Cursor");
  assert.equal(lines[5], "  Unavailable: session expired");
});

await check("render: entries persisted in the old shape still render", () => {
  // What /usage wrote before meters became a list: one session and one week object, no labels.
  const legacy = [
    {
      name: "Claude Code",
      session: { usedPercent: 77, resetsAt: new Date("2026-08-19T20:00:00Z").getTime() },
      week: { usedPercent: 72, resetsAt: new Date("2026-08-22T05:00:00Z").getTime() },
    },
    { name: "Codex", error: "Unavailable: HTTP 500" },
  ] as unknown as Parameters<typeof renderUsageLines>[0];

  const lines = renderUsageLines(legacy, plainFormat);
  assert.equal(lines[0], "Claude Code");
  assert.match(lines[1] ?? "", /Session: 77% used/);
  assert.match(lines[2] ?? "", /Week:    72% used/);
  assert.equal(lines[4], "Codex");
  assert.equal(lines[5], "  Unavailable: HTTP 500");
});

await check("render: dollar rows omit the percent column and keep alignment", () => {
  const text = renderUsageLines(
    [
      {
        name: "OpenRouter",
        plan: "Pay as you go",
        windows: [
          { label: "Credits", usedPercent: 41, trailer: "$10.25 of $25.00" },
          { label: "Balance", trailer: "$14.75 left" },
        ],
      },
    ],
    plainFormat,
  ).join("\n");

  assert.equal(
    text,
    [
      "OpenRouter (Pay as you go)",
      "  Credits: 41% used, $10.25 of $25.00",
      "  Balance: $14.75 left",
    ].join("\n"),
  );
});

await check("render: a provider with no meters says so", () => {
  const text = renderUsageLines(
    [{ name: "GitHub Copilot", plan: "Business", windows: [] }],
    plainFormat,
  ).join("\n");
  assert.equal(text, "GitHub Copilot (Business)\n  No usage data reported");
});

// ---------------------------------------------------------------- results

globalThis.fetch = realFetch;
console.log(`${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
