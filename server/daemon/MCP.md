English | [繁體中文](MCP.zh-TW.md)

# Sniffer MCP

The stdio MCP server lets AI clients inspect captured HTTP and Socket traffic, edit mock rules, inject events and control response breakpoints.
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
MCP is included starting with version 0.8.0. `sniffer mcp` does not start
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
| `SNIFFER_REDACT_BODY_FIELDS` | daemon | built-in names | Additional comma-separated field names to mask, including Socket payloads. |

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
| `list_traffic` | Read captured messages, with secrets masked. | `deviceId?`, `type?` (`http`, `socket`), `method?`, `status?`, `urlContains?`, `bodyContains?`, `userId?`, `event?`, `connectionId?`, `limit?` |
| `get_entry` | All messages for one ID: request/response, event/ack. | `id`, `deviceId?` |
| `create_mock` | Create an HTTP rule (default) or socket rule. Returns `{deviceId, created: {id}}`. | `deviceId?`, `type?` (`http`, `socket`), fields below |
| `copy_mock_with_fields` | Copy an HTTP JSON mock with field replacements; the copy is disabled and device-local. | `id`, `replacements: [{path, value}]`, `deviceId?`, `name?` |
| `update_mock` | Patch a rule, retaining unspecified fields. Returns `{deviceId, updated: {id}}`. | `id`, `deviceId?`, fields below |
| `delete_mock` | Remove a rule by ID. | `id`, `deviceId?` |
| `push_event` | Inject an inbound socket event into the app. Omit/null `connectionId` broadcasts within the device. | `event`, `payload`, `deviceId?`, `connectionId?` |
| `clear_traffic` | Clear all devices' traffic; HTTP/all also releases paused responses unchanged. | `type?` (`http`, `socket`), omitted means all |
| `set_breakpoints` | Replace a device's response breakpoint rules. Empty array disarms all. | `rules`, `deviceId?` |
| `resolve_breakpoint` | Resume with optional edits, or abort a paused response. | `id`, `action` (`resume`, `abort`), `deviceId?`, `status?`, `headers?`, `body?` |

HTTP request and response are separate messages with the same ID. HTTP method,
status, URL and user ID filters correlate them within a device. `limit` returns
the last N **messages**, not N complete flows; use `get_entry` for a full flow.
`bodyContains` searches each message's body, socket payload.
`event` matches a socket event name exactly; `userId` matches the
captured identity exactly (empty string means explicitly unset). The response
preserves image `bodyBase64`, truncation, delay and error fields, socket labels. Very large image bodies can exceed an MCP client's
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
2. “Find failed HTTP requests and show their response bodies.”
3. “Mock `/orders` only when query `page=2` and JSON body `limit=20`.”
4. “For Socket.IO `items:get` with payload `page=2`, reply with `items:result`.”
5. “Pause the `/checkout` response; show the pending hit and resume it with status 200.”

## Data handling

The daemon masks known sensitive headers and JSON keys, token-shaped strings
(JWT, Bearer/Basic and PEM), and sensitive URL query parameters. This covers
HTTP bodies, Socket payloads/acks, and MCP state reads. Stored
traffic and the UI WebSocket remain unchanged. MCP offers no raw-read option;
REST `/api/entries?redact=0` is an explicit local debugging bypass.

Redaction is best effort: arbitrary plaintext secrets, image contents and unknown
field names may remain. Add project-specific names on the daemon. The daemon has
no authentication; keep the default loopback binding or use a trusted network.

See [the protocol](../../PROTOCOL.md) and [the user guide](../../docs/GUIDE.md).


### Copy with JSON field changes

Use an existing HTTP rule ID from `get_state` with `copy_mock_with_fields`:

```json
{
  "id": "source-rule-id",
  "replacements": [{ "path": "/data/commentCount", "value": 36 }],
  "name": "36 comments"
}
```

The source body must be valid JSON. Paths are JSON Pointers, for example `/items/0/name`;
escape `/` in a field name as `~1` and `~` as `~0`. Only existing fields of the same JSON
type can be replaced. Additions, deletions and root replacement are not supported.
Supply 1 to 100 distinct, non-overlapping paths. Any invalid replacement rejects the entire
copy. Bodies containing unsafe integers are rejected to avoid corrupting unrelated values.
JSON is reformatted; whitespace and key order are not preserved. Validation covers JSON
structure and types, not the app's business schema.

Returns `{deviceId, sourceId, created: {id, enabled: false, starred: false}, changedPaths}`,
without field values. The source and other rules stay unchanged. Even a shared source creates
a device-local copy. Conditions, status, headers and delay are retained; explicitly enable
with `update_mock` after review. Existing shared-rule precedence still applies, so enabling
a local copy does not guarantee it overrides a shared source.

No backend request or SDK update is needed. Delay-only rules, Socket rules, non-JSON bodies
and placeholder templates that cannot be parsed as JSON are unsupported.

Field replacement is available through MCP. The UI keeps the existing Copy button and response editor.

The local preview API remains `POST /api/mock-body/replace-fields` with `{body, replacements}`.
It returns `{body, changes: [{path, before, after}]}` or HTTP 400 on invalid input.
It does not persist rules; preview values are unmasked.

## Scenario templates

`save_scenario({name, appId, rules, id?})` persists a template in the daemon mock store.
Rules use the `create_mock` fields without deviceId. An existing id updates that template.
`list_scenarios({appId?})` returns metadata and required parameter names, not bodies.
`delete_scenario({id})` removes a template without removing its previously applied rules.
`apply_scenario({id, deviceId?, parameters})` atomically adds fresh device-local rules and returns
`{deviceId, scenarioId, ruleIds, status: "sent"}`. This is not SDK readiness confirmation.
The connected device must have the template's appId. All required parameters, and no extras,
must be provided. Existing rules and shared-rule precedence remain unchanged.

```json
{
  "name": "Empty comments", "appId": "com.example.app",
  "rules": [{ "method": "GET", "urlPattern": "/characters/{{characterId}}/comments",
    "body": "{\"commentCount\":\"{{count}}\",\"comments\":[]}" }]
}
```

Apply with `{"id":"scenario-id","parameters":{"characterId":"194","count":0}}`.
Inside JSON bodies, a complete `{{parameter}}` string becomes the supplied JSON scalar;
embedded replacements remain strings and are escaped by JSON serialization. Path parameters
must be nonempty single segments using letters, digits, `_`, `.`, `~` or `-`.
SDK placeholders such as `${randomId}` remain unchanged. Repeated application creates new
rules; use returned IDs for cleanup. No UI redesign or SDK change is required.

## Verification runs

`start_run({deviceId?, name?, scenarioId?, parameters?})` creates a persistent run, optionally
applying a scenario in the same transaction. Returns `{run, status: "sent"}`. Use
`create_mock({runId, ...fields})` to add more rules; the run supplies the device and forces
new rules to be device-local. `list_runs({deviceId?})` includes finished and unfinished runs
and survives daemon restarts. The MCP appId setting scopes this listing.

`end_run({runId})` removes only the recorded IDs from that device. It never clears traffic,
other runs, or existing rules. Calling it again is safe. Rules moved into the shared bucket
block cleanup until explicitly unshared. Offline cleanup updates persistent daemon state but
returns `cleanup-pending-device`; online cleanup returns `cleanup-sent`, not an SDK ACK.
No automatic expiry is assumed. End every run explicitly, including after failed verification.
No SDK update is required for run ownership and daemon-side cleanup.

## Device readiness and hits

`get_run_status({runId, waitMs?})` reads `supported`, `connected`, `ready`, `revision`,
`acknowledged`, `omittedRuleIds` and recent exact-rule `hits`. waitMs is 0 to 30000 and
waits only for readiness, stopping early for unsupported/offline devices. Poll again after
UI interaction for hits. Active runs are ready only when every owned rule was included and
the SDK ACKed the current sync. Ended runs are ready when the SDK ACKs their removal.
This requires SDK capability `mock-observability`. Hits are bounded, in-memory matching
evidence; they do not prove response completion or UI correctness. A shared rule may take
precedence even when a local run is ready. No network request is blocked by waiting in MCP.

### Sequential responses

Use `create_mock` or `update_mock` with `sequence: {steps:[{status:503,body:"retry"},{status:200,body:"ok"}],onExhausted:"last",resetToken:""}`. Each step accepts status, headers, body and delayMs. Use `last`, `loop` or `stop` for exhaustion; stop fails matching requests and never falls through to the server. Reset by updating the sequence with a new resetToken. Set sequence to null to return to static responses. Requires SDK capability `http-sequences`; inspect `get_run_status` for readiness and zero-based `hits[].stepIndex`. A hit means selection, not completion. Only matched requests count, including background calls. JSON field copies only support static responses.

### Timed SSE streams

Use `create_mock` / `update_mock` with `sse: {events:[{data:"first",delayMs:100},{event:"done",data:"second",delayMs:500}],ending:"close"}`. Each event supports data, event, id, retry and delayMs. Requires status 200 and SDK capability `http-sse-mocks`. Cannot combine with sequence or delayOnly; clear old modes with null when switching. SSE data is plain text or serialized JSON, without wire prefixes. JSON data and sequence step bodies support escaped scenario parameters.
Endings: close normally, open until caller cancellation/timeout, or disconnect with a read error after emitting the last event (unread buffered bytes may be lost). Each matching request starts from event 1. Client auto-reconnect can create another stream; this feature does not disable it. `get_run_status` confirms synchronization and rule matching, not consumption or UI rendering. Responses deliberately report null body for timed streams. Use the app's stream consumer to verify event timing.
