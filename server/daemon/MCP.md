English | [繁體中文](MCP.zh-TW.md)

# Sniffer MCP

The stdio MCP server lets AI clients inspect captured HTTP, Socket and Firebase
Analytics traffic, edit mock rules, inject events and control response breakpoints.
It talks to the running daemon over REST. The existing app SDK does not need an
update for MCP itself; newer mock conditions still require their SDK capabilities.

## Run from this checkout

Build the daemon and UI once:

```bash
npm --prefix server/daemon install
npm --prefix server/ui install
npm --prefix server/ui run build
npm --prefix server/daemon run build
node server/daemon/bin/sniffer.js start
```

Keep the daemon running. Configure your MCP client to launch a separate process:

```json
{
  "mcpServers": {
    "sniffer": {
      "command": "node",
      "args": ["/absolute/path/to/sniffer/server/daemon/bin/sniffer.js", "mcp"],
      "env": {
        "SNIFFER_PORT": "9091",
        "SNIFFER_APP_ID": "com.example.app"
      }
    }
  }
}
```

Replace the absolute path and app ID. `env` is optional. The JSON shape above is
for clients that use `mcpServers`; in other clients set the same executable, args
and environment through their MCP settings. For an installed package containing
this feature, use `"command": "sniffer", "args": ["mcp"]`, or
`"command": "npx", "args": ["-y", "@dev-weiqi/sniffer", "mcp"]`.
Existing published versions may not contain MCP yet. `sniffer mcp` does not start
the daemon and reserves stdout for MCP messages.

The desktop app's running daemon can also be used; set `SNIFFER_PORT` to its port.
The default daemon port is 9091. Port 9092 is also the default iOS USB listener
port, so choose a different free port if running both on a shared host.

## Environment

| Variable | Process | Default | Purpose |
| --- | --- | --- | --- |
| `SNIFFER_HOST` | MCP | `127.0.0.1` | Host running the daemon. |
| `SNIFFER_PORT` | MCP | `PORT`, then `9091` | Daemon port to connect to. |
| `SNIFFER_APP_ID` | MCP | unset | Choose the default connected device for this app; ambiguous traffic reads remain within this app. An explicit `deviceId` overrides it. |
| `PORT` | daemon | `9091` | Listening port. |
| `SNIFFER_BIND` | daemon | `127.0.0.1` | Listening interface. Use `0.0.0.0` only when LAN access is needed. |
| `SNIFFER_REDACT_HEADERS` | daemon | built-in names | Additional comma-separated header names to mask. |
| `SNIFFER_REDACT_BODY_FIELDS` | daemon | built-in names | Additional comma-separated field names to mask, including Socket payloads and Analytics params. |

For example, configure redaction on the **daemon**:

```bash
SNIFFER_REDACT_BODY_FIELDS=sessionKey,otp SNIFFER_REDACT_HEADERS=X-My-Token node server/daemon/bin/sniffer.js start
```

With no explicit `deviceId`, tools use the single connected device (optionally
narrowed by app ID). If that is ambiguous, traffic reads cover matching devices;
mutations require `deviceId`. `get_state` always lists all daemon devices, mocks
and breakpoints. `clear_traffic` always affects **all devices**, regardless of app ID.

## Tools

| Tool | Purpose | Arguments |
| --- | --- | --- |
| `get_state` | Devices, entry count, mocks, armed breakpoints and paused responses. | none |
| `list_traffic` | Read captured messages, with secrets masked. | `deviceId?`, `type?` (`http`, `socket`, `firebase`), `method?`, `status?`, `urlContains?`, `bodyContains?`, `userId?`, `event?`, `connectionId?`, `limit?` |
| `get_entry` | All messages for one ID: request/response, event/ack or Analytics event. | `id`, `deviceId?` |
| `create_mock` | Create an HTTP rule (default) or socket rule. Returns `{deviceId, created: {id}}`. | `deviceId?`, `type?` (`http`, `socket`), fields below |
| `update_mock` | Patch a rule, retaining unspecified fields. Returns `{deviceId, updated: {id}}`. | `id`, `deviceId?`, fields below |
| `delete_mock` | Remove a rule by ID. | `id`, `deviceId?` |
| `push_event` | Inject an inbound socket event into the app. Omit/null `connectionId` broadcasts within the device. | `event`, `payload`, `deviceId?`, `connectionId?` |
| `clear_traffic` | Clear all devices' traffic; HTTP/all also releases paused responses unchanged. | `type?` (`http`, `socket`, `firebase`), omitted means all |
| `set_breakpoints` | Replace a device's response breakpoint rules. Empty array disarms all. | `rules`, `deviceId?` |
| `resolve_breakpoint` | Resume with optional edits, or abort a paused response. | `id`, `action` (`resume`, `abort`), `deviceId?`, `status?`, `headers?`, `body?` |

HTTP request and response are separate messages with the same ID. HTTP method,
status, URL and user ID filters correlate them within a device. `limit` returns
the last N **messages**, not N complete flows; use `get_entry` for a full flow.
`bodyContains` searches each message's body, socket payload or Analytics params.
`event` matches a socket event name or Analytics name exactly; `userId` matches the
captured identity exactly (empty string means explicitly unset). The response
preserves image `bodyBase64`, truncation, delay and error fields, socket labels,
and Analytics `firebaseSdkCalled`. A local Analytics capture is not proof of
Firebase cloud delivery. Very large image bodies can exceed an MCP client's
message size limit.

### Mock fields

Common fields: `enabled`, `name`, `starred`, `delayMs` (nonnegative milliseconds).
`starred` shares the rule across devices with the same app ID; editing/deleting
it affects those devices too. New rules are inserted first within their group;
shared rules precede device-only rules. IDs and creation timestamps are generated.

HTTP requires `urlPattern`, an exact request path without scheme, host or query.
Optional fields: `method` (null matches any), `status` (default 200), `headers`,
`body`, `delayOnly`, `queryParams` (string values), `bodyMatch` (a JSON object encoded
as a string). `delayOnly: true` delays the real request instead of mocking a response.

Socket requires `type: "socket"` and `event`. Optional fields: `transport`
(`socketio` by default, or `ktor-ws`), `ackPayload`, `payloadMatch` (a JSON object
encoded as a string), `pushEvent`, `pushPayload`. Socket.IO ack/push payloads are
JSON argument arrays. Ktor WS uses raw text frames; its `event` is an outgoing
substring matcher and `ackPayload` is the reply frame. `pushEvent`/`pushPayload`
apply only to Socket.IO event replies.

Set `bodyMatch`/`payloadMatch` to null or empty string to remove a condition.
Query/body/payload conditions use `http-query-mocks`, `http-body-mocks` and
`socket-payload-mocks` SDK capabilities. Unsupported conditional rules are not sent
to old SDKs. Bodies and replies support `${randomId}`, `${now}` and
`${randomString(min~max)}`. Invalid arguments are rejected before mutation.

Mock writes read the current full rule set before updating it. One MCP process
serializes its mock writes; avoid editing mocks simultaneously from the UI or
another MCP process, which can overwrite changes based on an older snapshot.

### Breakpoints

Each rule has `id`, `urlPattern`, optional `method`, `enabled`, and
`phase: "response"`. Read `get_state.pausedHits` to find a hit's ID and device.
Breakpoints apply to supported real HTTP text responses, not mocked responses,
SSE streams or image/upgrade responses. Disconnecting releases paused calls.

## Example prompts

1. “Show the last 10 HTTP messages for `/orders` with status 503, then fetch the full failing flow.”
2. “Find `screen_view` Analytics events for `user-7` and show their params.”
3. “Mock `/orders` only when query `page=2` and JSON body `limit=20`.”
4. “For Socket.IO `items:get` with payload `page=2`, reply with `items:result`.”
5. “Pause the `/checkout` response; show the pending hit and resume it with status 200.”

## Data handling

The daemon masks known sensitive headers and JSON keys, token-shaped strings
(JWT, Bearer/Basic and PEM), and sensitive URL query parameters. This covers
HTTP bodies, Socket payloads/acks, Analytics params, and MCP state reads. Stored
traffic and the UI WebSocket remain unchanged. MCP offers no raw-read option;
REST `/api/entries?redact=0` is an explicit local debugging bypass.

Redaction is best effort: arbitrary plaintext secrets, image contents and unknown
field names may remain. Add project-specific names on the daemon. The daemon has
no authentication; keep the default loopback binding or use a trusted network.

See [the protocol](../../PROTOCOL.md) and [the user guide](../../docs/GUIDE.md).
