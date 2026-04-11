# pi-memory-honcho

Honcho-backed persistent memory extension for the [PI coding agent](https://github.com/badlogic/pi-mono). Persistent user context, cross-workspace memory sharing, and dialectic reasoning across sessions.

> **Renamed:** this package was previously published as `pi-honcho-memory`. Use `pi install npm:pi-memory-honcho` going forward.

## Install

```bash
pi install npm:pi-memory-honcho
# or from git
pi install https://github.com/acsezen/pi-memory-honcho
```

## Setup

1. Get a Honcho API key from [honcho.dev](https://honcho.dev) or self-host.
2. Run `/honcho:setup` inside PI to configure your key, workspace, and peer names.
3. Verify with `/honcho:doctor`.

Or create `~/.honcho/config.json` manually:

```json
{
  "apiKey": "hch-v3-...",
  "peerName": "yourname",
  "hosts": {
    "pi": {
      "workspace": "pi",
      "aiPeer": "pi",
      "recallMode": "hybrid"
    }
  }
}
```

## Features

### Memory tools

| Tool | Description |
|------|-------------|
| `honcho_profile` | Retrieve user profile from this and linked workspaces |
| `honcho_search` | Search durable memory across all linked workspaces |
| `honcho_context` | Synthesize memory context via dialectic reasoning across all linked workspaces |
| `honcho_conclude` | Store a durable preference, fact, or decision (primary workspace only) |
| `honcho_seed_identity` | Seed the AI peer's identity representation (primary workspace only) |

### Commands

| Command | Description |
|---------|-------------|
| `/honcho:setup` | Interactive first-time configuration |
| `/honcho:status` | Show connection, cache, and config status |
| `/honcho:config` | Show effective config (redacted API key) |
| `/honcho:doctor` | Preflight check for config, connectivity, session |
| `/honcho:interview` | Save a preference or working style insight |
| `/honcho:mode` | Switch recall mode (hybrid / context / tools) |
| `/honcho:sync` | Force context refresh and flush pending uploads |
| `/honcho:map` | Map current directory to a custom session name |

### Lifecycle

- **Session start**: Bootstraps Honcho connection, fetches context, migrates legacy memory files (MEMORY.md, USER.md, SOUL.md)
- **Before agent start**: Injects persistent memory into the system prompt (user profile, peer cards, AI profile, project summary)
- **Agent end**: Uploads conversation messages to Honcho
- **Session shutdown/switch/fork/compact**: Flushes pending uploads

## Configuration

All fields can be set via `~/.honcho/config.json` (under `hosts.pi`) or environment variables.

| Field | Env var | Default | Description |
|-------|---------|---------|-------------|
| `recallMode` | `HONCHO_RECALL_MODE` | `hybrid` | `hybrid` / `context` / `tools` |
| `sessionStrategy` | `HONCHO_SESSION_STRATEGY` | `per-directory` | `per-directory` / `git-branch` / `pi-session` / `per-repo` / `global` |
| `writeFrequency` | `HONCHO_WRITE_FREQUENCY` | `async` | `async` / `turn` / `session` / N (number) |
| `injectionFrequency` | `HONCHO_INJECTION_FREQUENCY` | `every-turn` | `every-turn` / `first-turn` |
| `saveMessages` | `HONCHO_SAVE_MESSAGES` | `true` | Upload conversation messages to Honcho |
| `dialecticDynamic` | `HONCHO_DIALECTIC_DYNAMIC` | `true` | Auto-bump reasoning level by query length |
| `dialecticMaxChars` | `HONCHO_DIALECTIC_MAX_CHARS` | `600` | Truncate dialectic results |
| `dialecticMaxInputChars` | `HONCHO_DIALECTIC_MAX_INPUT_CHARS` | `10000` | Truncate dialectic queries |
| `reasoningLevel` | `HONCHO_REASONING_LEVEL` | `low` | Base reasoning level for dialectic |
| `reasoningLevelCap` | `HONCHO_REASONING_LEVEL_CAP` | none | Hard cap on reasoning level |
| `contextTokens` | `HONCHO_CONTEXT_TOKENS` | `1200` | Token budget for injected context |
| `contextRefreshTtlSeconds` | `HONCHO_CONTEXT_REFRESH_TTL_SECONDS` | `300` | TTL before re-fetching context |
| `maxMessageLength` | `HONCHO_MAX_MESSAGE_LENGTH` | `25000` | Max chars per message chunk |
| `searchLimit` | `HONCHO_SEARCH_LIMIT` | `8` | Max search results |
| `sessionPeerPrefix` | `HONCHO_SESSION_PEER_PREFIX` | `false` | Prefix session keys with peer name |
| `observationMode` | `HONCHO_OBSERVATION_MODE` | `directional` | `directional` / `unified` |
| `contextCadence` | `HONCHO_CONTEXT_CADENCE` | `1` | Min turns between context API calls |
| `dialecticCadence` | `HONCHO_DIALECTIC_CADENCE` | `1` | Min turns between dialectic calls |
| `environment` | `HONCHO_ENVIRONMENT` | `production` | `local` / `production` |
| `logging` | `HONCHO_LOGGING` | `true` | Enable console logging |

### Manual session mappings

Add `sessions` to your `~/.honcho/config.json` to map directories to specific session names:

```json
{
  "sessions": {
    "/home/user/project-a": "my-project-a",
    "/home/user/project-b": "my-project-b"
  }
}
```

### Linked hosts

Share memory across AI tools by linking their workspaces. Read tools (`honcho_profile`, `honcho_search`, `honcho_context`) fan out to all linked workspaces and merge results. Write tools (`honcho_conclude`, `honcho_seed_identity`) stay in the primary workspace, following Honcho's workspace isolation design.

Linked host SDK clients are created once at startup and cached, not per tool call. Profile reads from linked workspaces use `peer.representation()` (no reasoning tokens) instead of dialectic calls.

```json
{
  "hosts": {
    "pi": {
      "workspace": "pi",
      "aiPeer": "pi",
      "linkedHosts": ["claude_code", "codex", "cursor"]
    },
    "claude_code": {
      "workspace": "claude_code",
      "aiPeer": "claude"
    },
    "codex": {
      "workspace": "codex",
      "aiPeer": "codex"
    },
    "cursor": {
      "workspace": "cursor",
      "aiPeer": "cursor"
    }
  }
}
```

Each linked host must have `workspace` and `aiPeer` defined. Results are labeled by source workspace (e.g., `=== [cursor] ===`).

## Development

```bash
git clone https://github.com/acsezen/pi-memory-honcho.git
cd pi-memory-honcho
npm install
npm run typecheck
npm test
```

## License

MIT
