import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  plainFormat,
  renderUsageLines,
  visibleReports,
  type ProviderReport,
} from "./format.ts";
import { providers } from "./providers/index.ts";
import { errorMessage } from "./shared.ts";

const CACHE_TTL_MS = 60_000;

interface UsageEntryData {
  providers: ProviderReport[];
  fetchedAt: number;
}

let cachedReports: { value: ProviderReport[]; expiresAt: number } | undefined;

async function loadReports(
  ctx: ExtensionCommandContext,
  force: boolean,
): Promise<ProviderReport[]> {
  if (!force && cachedReports && cachedReports.expiresAt > Date.now()) {
    return cachedReports.value;
  }

  const value = await Promise.all(
    providers.map(async (provider): Promise<ProviderReport> => {
      try {
        const result = await provider.fetch(ctx);
        if (result.status === "ok") {
          return {
            name: provider.name,
            plan: result.plan,
            windows: result.windows,
          };
        }
        if (result.status === "absent") {
          return { name: provider.name, windows: [], note: result.message };
        }
        return {
          name: provider.name,
          windows: [],
          error: `Unavailable: ${result.message}`,
        };
      } catch (error) {
        return {
          name: provider.name,
          windows: [],
          error: `Unavailable: ${errorMessage(error)}`,
        };
      }
    }),
  );

  cachedReports = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export default function subscriptionUsageExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<UsageEntryData>(
    "subscription-usage",
    (entry, _options, theme) => {
      const lines = renderUsageLines(entry.data?.providers ?? [], {
        indent: "",
        name: (value) => theme.fg("accent", theme.bold(value)),
        plan: (value) => theme.fg("muted", value),
        error: (value) => theme.fg("error", value),
        muted: (value) => theme.fg("muted", value),
      });

      return new Text(lines.join("\n"), 1, 0);
    },
  );

  pi.registerCommand("usage", {
    description: "Show coding subscription usage (Claude, Codex, Cursor, …)",
    getArgumentCompletions: (prefix) =>
      ["refresh", "all"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const flags = args.trim().split(/\s+/).filter(Boolean);
      const unknown = flags.filter(
        (flag) => flag !== "refresh" && flag !== "all",
      );
      if (unknown.length > 0) {
        ctx.ui.notify("Usage: /usage [refresh] [all]", "warning");
        return;
      }

      const reports = visibleReports(
        await loadReports(ctx, flags.includes("refresh")),
        flags.includes("all"),
      );
      pi.appendEntry<UsageEntryData>("subscription-usage", {
        providers: reports,
        fetchedAt: Date.now(),
      });

      // Only the TUI renders custom entries; other modes need the plain text.
      if (ctx.mode === "tui") return;

      const text = renderUsageLines(reports, plainFormat).join("\n");
      if (ctx.hasUI) {
        const allFailed = reports.every((report) => report.error);
        ctx.ui.notify(text, allFailed ? "error" : "info");
        return;
      }

      // Print and JSON modes reserve stdout for agent output.
      process.stderr.write(`${text}\n`);
    },
  });
}
