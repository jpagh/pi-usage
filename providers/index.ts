import type { ProviderDefinition } from "../shared.ts";
import { claudeProvider } from "./claude.ts";
import { codexProvider, codexWorkProvider } from "./codex.ts";
import { copilotProvider } from "./copilot.ts";
import { cursorProvider } from "./cursor.ts";
import { opencodeProvider } from "./opencode.ts";
import { openrouterProvider } from "./openrouter.ts";
import { zaiProvider } from "./zai.ts";

export const providers: ProviderDefinition[] = [
  claudeProvider,
  codexProvider,
  codexWorkProvider,
  cursorProvider,
  copilotProvider,
  opencodeProvider,
  zaiProvider,
  openrouterProvider,
];
