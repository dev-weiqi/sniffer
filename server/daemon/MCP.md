# Sniffer MCP

Sniffer ships an [MCP](https://modelcontextprotocol.io) server so AI tools
(Claude Code, Cursor, Codex, …) can read the traffic your app is producing and
drive mocks, with no copy-pasting.

It is a thin wrapper over the daemon's REST API (see `PROTOCOL.md`), so the
daemon must be running: `sniffer start`. The MCP server talks to it over
`http://127.0.0.1:9091` by default.

## Example prompts

Talk to it in natural language; the AI picks the tool.

- "What devices are connected, and how much traffic have we captured?"
- "Show me the last 10 requests whose URL contains `/api/`."
- "Any failed requests? List the 500s."
- "Which call returned `point`? Show its full request and response."
- "Mock `/api/user` to return 500 with an empty body."
- "Make `/api/checkout` respond after a 3s delay."
- "Delete that mock again."
- "Push a `chat:new` socket event to the app."
- "Clear the recorded traffic."

## Setup

Each CLI has an `mcp add` command; use `-y @dev-weiqi/sniffer mcp` in place of `sniffer mcp`
if it isn't installed globally.

**Claude Code**

```bash
claude mcp add sniffer -- sniffer mcp
```

**Gemini CLI**

```bash
gemini mcp add sniffer sniffer mcp
```

**Codex CLI**

```bash
codex mcp add sniffer -- sniffer mcp
```

**Manual config** (any MCP client): a JSON `mcpServers` entry. Every env key is optional;
omit `env` for the defaults.

```jsonc
{
  "mcpServers": {
    "sniffer": {
      "command": "sniffer",
      "args": ["mcp"],
      "env": {
        "SNIFFER_APP_ID": "com.your.app",   // scope tools to one app; deviceId can then be omitted
        "SNIFFER_PORT": "9092",             // only if the daemon isn't on 9091
        "SNIFFER_HOST": "127.0.0.1"         // only if the daemon isn't on localhost
        // redaction vars are NOT set here; they go on the daemon (see below)
      }
    }
  }
}
```

The transport is stdio; the MCP only reaches the daemon on loopback.

The two **redaction** vars belong on the *daemon*, not the MCP config. Set them when you
start it (see Environment / Secrets for the full list):

```bash
SNIFFER_REDACT_BODY_FIELDS=sessionKey,otp SNIFFER_REDACT_HEADERS=X-My-Token sniffer start
```

## Environment

All optional. With no env set, the MCP talks to `127.0.0.1:9091`, scopes to nothing,
and redacts the built-in secret set.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SNIFFER_PORT` | optional | `9091` | Daemon port (falls back to `PORT`). |
| `SNIFFER_HOST` | optional | `127.0.0.1` | Daemon host the MCP connects to. |
| `SNIFFER_APP_ID` | optional | none (no scope) | Scope this MCP to one app, so tools default to its connected device when `deviceId` is omitted. |
| `SNIFFER_BIND` | optional | `127.0.0.1` | Daemon: interface to bind. Set `0.0.0.0` for an iOS device on wifi (see Security). |
| `SNIFFER_REDACT_HEADERS` | optional | built-in set | Daemon: comma-separated extra header names to mask (see Security). |
| `SNIFFER_REDACT_BODY_FIELDS` | optional | built-in set | Daemon: comma-separated extra body field names to mask (see Security). |

Set on the right process: `SNIFFER_PORT` / `SNIFFER_HOST` / `SNIFFER_APP_ID` are read by
the **MCP** (`sniffer mcp`, so in your MCP client's `env`). `SNIFFER_BIND` and the two `*_REDACT_*` vars are
read by the **daemon** (`sniffer start`), not the MCP; setting them in the MCP config has
no effect.

## Tools

### Read

| Tool | Does | Args |
|------|------|------|
| `get_state` | Connected devices, recorded entry count, mock rules per device. | none |
| `list_traffic` | Recorded HTTP/Socket entries. HTTP request and response are **separate entries sharing an `id`**. Filters apply, then the last N. | `deviceId?`, `type?` (`http`\|`socket`), `method?`, `status?`, `urlContains?`, `bodyContains?`, `limit?` |
| `get_entry` | Every entry sharing one `id`: the full flow (request + response, or event + ack). | `id` |

`bodyContains` searches message bodies (usually matches the response, since request/response are separate entries); use it to find a call by a value it returned, e.g. `bodyContains: "point"`.

### Mocks

Mock edits are read-modify-write on the daemon's per-device rule set. `urlPattern`
is an **exact match against the request path** (scheme/host/query stripped).
`body` / `ackPayload` support placeholders expanded on the device: `${randomId}`,
`${now}`, `${randomString(min~max)}`.

| Tool | Does | Args |
|------|------|------|
| `create_mock` | Add an HTTP mock rule. Returns the created rule with its `id`. | `deviceId?`, `urlPattern`, `status`, `method?`, `headers?`, `body?`, `delayMs?` |
| `update_mock` | Patch a rule (HTTP or socket) by `id`; only the fields you pass change. | `deviceId?`, `id`, + any of `enabled`/`method`/`urlPattern`/`status`/`headers`/`body`/`delayMs`/`event`/`ackPayload` |
| `delete_mock` | Remove a rule (HTTP or socket) by `id`. | `deviceId?`, `id` |

### Session

| Tool | Does | Args |
|------|------|------|
| `push_event` | Inject a server→client socket event into a connected device. Omit `connectionId` to broadcast. | `deviceId?`, `event`, `payload`, `connectionId?` |
| `clear_traffic` | Clear recorded traffic. Omit `type` for all. | `type?` (`http`\|`socket`) |

## Security

- The daemon binds to `127.0.0.1` only (no network exposure; `SNIFFER_BIND=0.0.0.0` to open it up).
- Sensitive data (auth tokens, passwords, API keys) is automatically redacted from AI reads.
