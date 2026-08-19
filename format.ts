import type { UsageWindow } from "./shared.ts";

export interface ProviderReport {
  name: string;
  plan?: string;
  windows: UsageWindow[];
  /** Credentials were found but usage could not be read. */
  error?: string;
  /** Why there is nothing to meter — shown for absent providers under `/usage all`. */
  note?: string;
}

export interface LineFormat {
  indent: string;
  name: (value: string) => string;
  plan: (value: string) => string;
  error: (value: string) => string;
  muted: (value: string) => string;
}

export const plainFormat: LineFormat = {
  indent: "  ",
  name: (value) => value,
  plan: (value) => value,
  error: (value) => value,
  muted: (value) => value,
};

/**
 * Session entries persisted before meters became a list carried one `session` and one `week` object.
 * Old entries are re-rendered whenever their session is reopened, so they are migrated on read
 * rather than left to fail.
 */
export function normalizeReport(report: ProviderReport): ProviderReport {
  if (Array.isArray(report.windows)) return report;

  const legacy = report as {
    session?: { usedPercent?: number; resetsAt?: number };
    week?: { usedPercent?: number; resetsAt?: number };
  };
  const windows: UsageWindow[] = [];
  for (const [label, window] of [
    ["Session", legacy.session],
    ["Week", legacy.week],
  ] as const) {
    if (typeof window?.usedPercent === "number") {
      windows.push({ label, usedPercent: window.usedPercent, resetsAt: window.resetsAt });
    }
  }
  return { ...report, windows };
}

/**
 * Providers with nothing to report are dropped: with several subscriptions supported, listing every
 * one the machine has no credentials for buries the ones it does. `includeAbsent` (`/usage all`) keeps
 * them, with the reason, so a missing subscription can be diagnosed.
 */
export function visibleReports(
  reports: ProviderReport[],
  includeAbsent: boolean,
): ProviderReport[] {
  if (includeAbsent) return reports;
  const connected = reports.filter((report) => !report.note);
  return connected.length > 0
    ? connected
    : [
        {
          name: "No connected subscriptions",
          windows: [],
          note: "run /usage all to see what was checked",
        },
      ];
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatTime(date: Date): string {
  return date
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .replace(/\s/g, "")
    .toLowerCase();
}

export function formatReset(
  timestamp: number | undefined,
  now = new Date(),
): string {
  if (!timestamp) return "reset unknown";
  const date = new Date(timestamp);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `resets ${formatTime(date)}`;

  const includeYear = date.getFullYear() !== now.getFullYear();
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
  });
  return `resets ${day} at ${formatTime(date)}`;
}

export function formatDollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatWindow(
  window: UsageWindow,
  labelWidth: number,
  usageWidth: number,
): string {
  const label = `${window.label}:`.padEnd(labelWidth + 2);
  const trailer = window.trailer ?? formatReset(window.resetsAt);
  if (window.usedPercent === undefined) return `${label}${trailer}`;
  const usage = `${formatPercent(window.usedPercent)} used,`.padEnd(
    usageWidth + 7,
  );
  return `${label}${usage}${trailer}`;
}

/**
 * The report as lines, styled by `format`. Columns are sized per provider so a long label
 * ("Completions") does not pad every other provider's rows.
 */
export function renderUsageLines(
  providers: ProviderReport[],
  format: LineFormat,
): string[] {
  const lines: string[] = [];

  for (const [index, raw] of providers.entries()) {
    const provider = normalizeReport(raw);
    if (index > 0) lines.push("");
    const plan = provider.plan ? ` ${format.plan(`(${provider.plan})`)}` : "";
    lines.push(`${format.name(provider.name)}${plan}`);

    if (provider.error) {
      lines.push(format.indent + format.error(provider.error));
      continue;
    }
    if (provider.note) {
      lines.push(format.indent + format.muted(provider.note));
      continue;
    }
    if (provider.windows.length === 0) {
      lines.push(format.indent + format.muted("No usage data reported"));
      continue;
    }

    const labelWidth = Math.max(...provider.windows.map((w) => w.label.length));
    const percentWidths = provider.windows
      .filter((w) => w.usedPercent !== undefined)
      .map((w) => formatPercent(w.usedPercent ?? 0).length);
    const usageWidth = percentWidths.length > 0 ? Math.max(...percentWidths) : 0;
    for (const window of provider.windows) {
      lines.push(format.indent + formatWindow(window, labelWidth, usageWidth));
    }
  }

  return lines;
}
