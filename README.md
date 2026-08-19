# pi-usage

A [pi](https://pi.dev) extension that answers "how much of my coding subscriptions have I burned?"
in one command, across every provider you're signed in to.

```
Claude Code
  Session: 13% used, resets Aug 20 at 12:59am
  Week:    74% used, resets Aug 22 at 4:59am

Codex
  Week: 96% used, resets Aug 20 at 8:26am

GitHub Copilot (Individual)
  Chat:        0% used, resets Sep 1 at 12:00am
  Completions: 0% used, resets Sep 1 at 12:00am

OpenRouter (Pay as you go)
  Credits: 41% used, $10.25 of $25.00
  Balance: $14.75 left
```

## Install

```bash
pi install npm:@destiner/pi-usage
```

## Use

```
/usage           # subscriptions you're signed in to
/usage refresh   # bypass the 60s cache
/usage all       # include the ones with no credentials, and why
```

Providers with no credentials on the machine are hidden, so the list stays short. Works in every pi
mode: the TUI renders it in the transcript, RPC clients get it as a notification, and print/JSON
modes write it to stderr.

Nothing is sent anywhere except each provider's own usage endpoint. Credentials are read from the
places the vendors' own tools already put them, and never logged, copied, or persisted.

## Providers

| Provider | Meters | Credentials, in order |
|---|---|---|
| Claude Code | Session, Week | pi's `anthropic` OAuth, then `~/.claude/.credentials.json` (`CLAUDE_CONFIG_DIR`) |
| Codex | Session, Week | pi's `openai-codex` OAuth |
| Cursor | Cycle | `CURSOR_API_KEY`, then the CLI's `auth.json`, then Cursor's `state.vscdb`, then the macOS keychain; `CURSOR_SESSION_TOKEN` overrides all of them |
| GitHub Copilot | Credits, Chat, Completions | `~/.config/github-copilot/{apps,hosts}.json`, then `~/.config/gh/hosts.yml`, then pi's `github-copilot` credential |
| OpenCode Go | Session, Week, Month | `auth.json` in OpenCode's data dir (`OPENCODE_DATA_DIR`, `XDG_DATA_HOME`), then pi's `opencode-go` key |
| Z.ai (GLM Coding Plan) | Session, Week | `ZAI_API_KEY`, `GLM_API_KEY`, then pi's `zai` key |
| OpenRouter | Credits, Balance, Key limit | `OPENROUTER_API_KEY`, then pi's `openrouter` key |

Notes:

- **Cursor** works without the desktop app: create a user API key (`crsr_…`) in the dashboard and
  export it as `CURSOR_API_KEY`. It is exchanged for a one-hour access token, which drives the same
  RPC the Cursor CLI uses. Otherwise the token comes from the CLI's `auth.json` or the desktop app's
  key/value store (read via `node:sqlite`, `bun:sqlite`, or the `sqlite3` CLI) and is refreshed in
  memory when expired. `CURSOR_SESSION_TOKEN` (the dashboard's `WorkosCursorSessionToken` cookie)
  skips credential discovery entirely.
- **Copilot** needs the GitHub OAuth token that `gh auth login` or a Copilot editor plugin writes,
  not the short-lived Copilot API token. Org-managed seats report no per-seat quota, so the plan
  shows with no meters.
- **OpenRouter** is prepaid credits rather than a plan: Credits meters lifetime spend against
  top-ups, Balance is what's left, and Key limit appears only when the key has a spend cap.

Meters are percentages where a denominator exists; meters without one show the figure instead.

Not covered: Grok and Antigravity (their usage APIs need a protobuf-JSON decoder and a loopback
language server respectively), Cursor on-demand spend, and Copilot overage counts.

## Caveats

These are the same subscription/backend endpoints the vendors' own apps call. Most are undocumented
and can change without notice — if a provider starts reporting an error, that is the first thing to
check. Only Claude Code, Codex, and GitHub Copilot have been exercised against live accounts; the
rest are verified against captured payloads plus each endpoint's live unauthenticated response.

## Development

```bash
npm install
npm test         # offline: fetch is stubbed, credentials are planted in a temp HOME
npm run typecheck
```

On Node 22.x, run the tests as `node --experimental-strip-types test.ts`.

## License

MIT
