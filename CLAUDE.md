# Sniffer — Working Agreement

Self-hosted Flipper alternative: monitor and mock an app's HTTP/Socket traffic.
`client/` is a Kotlin Multiplatform SDK, `server/` is a Node daemon + React UI.

## Layout

| Path | What |
|------|------|
| `client/` | KMP SDK. Plugin modules: `core` (required) + `okhttp` / `ktor` / `ktor-ws` / `socketio`, each with a `-noop` release twin. Also `sample` (Android, all plugins) and `sample-cmp` (Compose Multiplatform, **ktor-only**, Android + iOS). |
| `server/daemon` | Node/TS. WebSocket hub, per-device mock store, `adb reverse`, test endpoints. |
| `server/ui` | React/TS. API / Socket / Mocks tabs. |
| `PROTOCOL.md` | Wire protocol — the source of truth for both sides. |

## Golden rules

1. **Protocol change ⇒ update `PROTOCOL.md` in the same change.** A new message field must land in three places together: `PROTOCOL.md`, the Kotlin data class in `client/core/.../Protocol.kt`, and the TS types in `server/ui/src/state.ts`. The daemon forwards rules/messages opaquely (`normalizeMocks` passes rule objects through) — don't assume it validates new fields.
2. **Non-trivial logic ships with a test.** Pure logic (mock matching, placeholder expansion, protocol (de)serialization) → `client/core/src/commonTest`. Keep the existing `MockRegistryTest` / `MockPlaceholdersTest` style.
3. **The SDK must never affect the host app.** Swallow errors, reconnect silently, cap buffers (1000 msgs offline). A monitoring bug must not surface in production traffic.
4. **Keep `sample` and `sample-cmp` in parity** — same layout, headers, and action labels. The only allowed difference: CMP is ktor-only (no okhttp / socketio).
5. **Commits:** split by feature; end messages with the `Co-Authored-By` trailer.
   **Never push without explicit approval for that push** — committing locally is fine,
   pushing (normal or force) always waits for the user's go-ahead.

## Before you say "done"

**Always report what changed, split by side, before declaring done:**

```
server：<daemon / ui changes, or 無>
client：<SDK / sample changes, or 無>
```

The bar is **automated tests + typecheck + build passing** — not just compiling:

```bash
cd client && ./gradlew :core:jvmTest :okhttp:test \
  :ktor:compileKotlinIosSimulatorArm64 :sample:compileDebugKotlin :sample-cmp:compileDebugKotlinAndroid
cd ../server/daemon && npm run typecheck
cd ../ui && npm run build
```

**Cover logic with a test, not a manual device run.** Mock matching, header/status/body
application, placeholder expansion, and protocol (de)serialization all have (or should get)
unit tests in `client/core` / `client/okhttp`. For SDK behaviour you can't unit-test, add a
throwaway `JavaExec` harness in `client/ktor-ws` jvmTest (see `wsDebug` / `sseDebug`) that
drives the real SDK against the daemon, assert, then delete it.

Only start the emulator/simulator when a change genuinely can't be verified another way (new
on-device UI wiring, adb reverse, platform glue). It's slow — don't gate every change on it.

**Transformation points are the compatibility risk.** Fences only stop the SDK from
*crashing* the host; code that *transforms* traffic (ktor tee / mock call rebuild, okhttp
tee / mock response, the ws and socketio wrappers) can be semantically wrong for consumers
we don't know about, and no try/catch will catch that. Default-safe policy: transform only
when the situation is positively recognized; anything carrying an unknown marker (e.g. an
engine-level response adapter) passes through untouched. Before an SDK release, exercise
the integration matrix — the sample buttons cover both SSE styles; add a button whenever a
new consumption style appears in a real app.

## Gotchas (already paid for — don't relearn)

- **adb reverse** is how a device/emulator reaches `localhost:9091`. The daemon re-runs it every 5s; a freshly booted emulator needs ~6s before it connects.
- **Never `save()` / `peekBody()` a 101 upgrade or a `text/event-stream` response** — it freezes the live stream and kills the socket. WebSocket upgrades pass through untouched; SSE is teed (`teeEventStream`) so the body is captured as the app reads it.
- **ktor's SSE *plugin* is engine-level and must not be touched at all**: `client.sse { }` responses carry an `SSESession` object as the body, not a byte stream — teeing/rebuilding that call breaks every SSE request ("Expected SSESession content but was ByteChannel"). Requests with the `SSERequestFlag` attribute pass through untouched. The tee only applies to raw `bodyAsChannel()` reads. The sample SSE button uses the plugin; the raw-read path is covered by the `:ktor-ws:sseDebug` harness.
- **Ktor response status is captured in `onResponse`**, not from the caught exception. A downstream `HttpResponseValidator` (e.g. Eden's) can rethrow the error as a custom exception with no `cause`, so catching `ResponseException` is not enough. This is why the status is stashed in a per-call attribute holder.
- **Mocks are per-device** on the daemon (`mockStore.devices[deviceId]`); `PUT /api/mocks` requires `deviceId`. Rules persist to `~/.sniffer/mocks.json`; recorded traffic is in-memory only (cleared on restart).
- **`delayOnly` rule** = let the real request run, only inject latency; do not fake the response. The interceptor's timer starts before the injected delay so the reported duration includes it.
- **Runtime host/port override** (no rebuild): Android `adb shell setprop debug.sniffer.port <n>` / `debug.sniffer.host <ip>`; iOS `SNIFFER_HOST` / `SNIFFER_PORT` env; JVM `-Dsniffer.port`. Precedence: override > `Sniffer.start(...)` args > default.
- **KMP `commonMain` has no reflection and no `Date.now()` / `Math.random()`-style host APIs** — go through `expect`/`actual` (see `Platform.kt`).
- **Android's ICU regex is stricter than the JVM's** — a bare `}` in a pattern compiles on JVM but throws `PatternSyntaxException` on Android, at class-init (`ExceptionInInitializerError` in the host). jvmTest cannot catch this; escape every literal brace and keep regexes out of hot init paths.
- **Clearing traffic must survive SDK buffer replay**: a disconnected SDK buffers ≤1000 messages and dumps them on reconnect, resurrecting "cleared" entries. The daemon keeps per-kind clear watermarks (`clearedAt` in `server.ts`) and drops incoming messages timestamped before the last clear (5s clock-skew tolerance).
- The web UI version is injected at build time from `server/daemon/package.json` (`__APP_VERSION__` in `vite.config.ts`) — don't hardcode it in the UI.

## Releasing

**NEVER publish (Maven/npm) or bump a version on your own.** Publishing is irreversible
(Maven Central is immutable) and version numbering belongs to the maintainer. Even when a
task seems to require a release, stop, explain why, and wait for an explicit go-ahead
naming the version.

Two channels; credentials never live in the repo.

**SDK → Maven Central** (`io.github.dev-weiqi.sniffer:*`, vanniktech maven-publish plugin):

1. Bump `VERSION_NAME` in `client/gradle.properties` — the only version to touch
   (root `build.gradle.kts` reads it; also update `snifferVersion` in README).
2. `cd client && ./gradlew publishAndReleaseToMavenCentral` — builds, signs, uploads,
   and releases all 8 library modules (samples excluded).
3. Verify (Central validation takes ~5–10 min):
   `curl -sI https://repo1.maven.org/maven2/io/github/dev-weiqi/sniffer/core/<v>/core-<v>.pom` → 200.

Credentials in `~/.gradle/gradle.properties` (machine-local): `mavenCentralUsername/Password`
(Sonatype user token from central.sonatype.com, GitHub login `dev-weiqi`) and
`signingInMemoryKey` (GPG key `D16D24AA5054EA6728416BD43972135B03CC9821`, no passphrase,
public key published to keys.openpgp.org). POM metadata lives in `client/gradle.properties`.

**Daemon → npm** (`@dev-weiqi/sniffer`, from `server/daemon`):

1. Bump `version` in `server/daemon/package.json`. Daemon and SDK version independently —
   sync is not required or implied.
2. `cd server/daemon && npm publish --access public` — `prepack` compiles TS to `dist/`
   and bundles the built web UI into `ui-dist/` automatically.
3. Verify: `npm view @dev-weiqi/sniffer version`, then install the tarball in a temp dir and
   smoke-test `sniffer start` + `curl /api/state`.

npm credentials live in `~/.npmrc` (machine-local): a granular access token scoped to
`@dev-weiqi/sniffer` with bypass-2FA, so publishing is non-interactive. Rotate it at
npmjs.com → Access Tokens when it expires.

The daemon resolves the UI from `../ui/dist` (repo checkout) first, then `ui-dist/`
(published package) — repo first, or a stale `ui-dist/` left by npm pack shadows fresh
builds. `postpack` removes the staging dir; keep both layouts working if you move files.

## Style

Match the surrounding code; comment only non-obvious constraints. Code and docs in English.
