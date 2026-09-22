# Sniffer: Working Agreement

Self-hosted Flipper alternative for monitoring and mocking an app's HTTP and Socket traffic.
`client/` is a Kotlin Multiplatform SDK; `server/` is a Node daemon plus a React UI.

## Layout

| Path | What |
|------|------|
| `client/` | KMP SDK. `core` (required) plus `okhttp` / `ktor` / `ktor-ws` / `socketio`, each with a `-noop` release twin. `sample` (Android, all plugins) and `sample-cmp` (Compose Multiplatform, ktor only, Android + iOS). |
| `server/daemon` | Node/TS. WebSocket hub, per-device mock store, `adb reverse`, test endpoints. |
| `server/ui` | React/TS. API / Socket / Mocks tabs. |
| `PROTOCOL.md` | Wire protocol; source of truth for both sides. |

## Golden rules

1. **A protocol change updates `PROTOCOL.md` in the same change.** A new message field lands in `PROTOCOL.md`, `client/core/.../Protocol.kt` and `server/ui/src/state.ts` together. The daemon passes rules and messages through (`normalizeMocks`) without validating new fields.
   A new mock-rule field must also be checked in: the daemon store (`normalizeMocks`, starred split, `~/.sniffer/mocks.json`), device sync (stripped like `starred`, or seen by the SDK?), the UI editors, duplicate detection (`httpSig` / `socketSig`) and `orderForSync`, and export/import (fields re-enter through the PUT path).
2. **Non-trivial logic ships with a test.** Pure logic (mock matching, placeholder expansion, protocol serialization) goes in `client/core/src/commonTest`, in the style of `MockRegistryTest` / `MockPlaceholdersTest`.
3. **The SDK must never affect the host app.** Swallow errors, reconnect silently, cap buffers (1000 messages offline).
4. **Keep `sample` and `sample-cmp` in parity:** same layout, headers and action labels. Only difference: CMP is ktor only.
5. **Commits:** split by feature, end with the `Co-Authored-By` trailer. **Never push without explicit approval for that push.** Local commits are fine.

## Before you say "done"

Report changes split by side:

```
server：<daemon / ui changes, or 無>
client：<SDK / sample changes, or 無>
```

Tests, typecheck and build must pass:

```bash
cd client && ./gradlew :core:jvmTest :okhttp:test \
  :ktor:compileKotlinIosSimulatorArm64 :sample:compileDebugKotlin :sample-cmp:compileDebugKotlinAndroid
cd ../server/daemon && npm run typecheck
cd ../ui && npm run build
```

Cover logic with unit tests in `client/core` / `client/okhttp`, not device runs. For SDK behaviour that cannot be unit tested, add a throwaway `JavaExec` harness in `client/ktor-ws` jvmTest (see `wsDebug` / `sseDebug`), assert against the real daemon, then delete it. Start an emulator or simulator only when nothing else can verify the change (on-device UI, adb reverse, platform glue).

**Traffic transformation is the compatibility risk.** try/catch only stops crashes; code that rewrites traffic (ktor tee and mock rebuild, okhttp tee and mock response, the ws and socketio wrappers) can still be wrong for unknown consumers. Transform only recognized cases and pass anything with an unknown marker (such as an engine-level response adapter) through untouched. Before an SDK release, run every sample button, including both SSE styles; add a button when a real app uses a new consumption style.

## Gotchas

- **adb reverse** lets devices reach `localhost:9091`. The daemon reruns it every 5 s; a fresh emulator needs about 6 s to connect.
- **iOS over USB is reversed:** usbmuxd can only dial into a device port, so the SDK listens on `127.0.0.1:9092` (`USB_PORT`, real devices only) and the daemon connects through `/var/run/usbmuxd` as the WebSocket client (`src/usbmux.ts`, polled every 5 s). After the handshake the `/device` handler is shared. A Mutex in `Sniffer` keeps one live session; a USB dial-in during a wifi or simulator session is closed unanswered.
- **Never `save()` / `peekBody()` a 101 upgrade or a `text/event-stream` response:** it freezes the stream and kills the socket. Upgrades pass through; SSE is teed (`teeEventStream`) so the body is captured as the app reads it.
- **Never touch ktor's SSE plugin calls:** `client.sse { }` responses carry an `SSESession` body, not bytes, so teeing or rebuilding them breaks every SSE request ("Expected SSESession content but was ByteChannel"). Requests with `SSERequestFlag` pass through; the tee applies only to raw `bodyAsChannel()` reads. The sample SSE button covers the plugin; `:ktor-ws:sseDebug` covers raw reads.
- **Ktor response status is captured in `onResponse`**, not from the caught exception: a downstream `HttpResponseValidator` (such as Eden's) can rethrow a custom exception with no `cause`. The status is kept in a per-call attribute holder.
- **Mocks are per device** (`mockStore.devices[deviceId]`); `PUT /api/mocks` requires `deviceId`. Rules persist to `~/.sniffer/mocks.json`; traffic is in memory only.
- **`delayOnly` rules** run the real request and only add latency. The timer starts before the delay, so the reported duration includes it.
- **Runtime host/port override** without rebuilding: Android `adb shell setprop debug.sniffer.port <n>` / `debug.sniffer.host <ip>`; iOS `SNIFFER_HOST` / `SNIFFER_PORT`; JVM `-Dsniffer.port`. Precedence: override > `Sniffer.start(...)` args > default.
- **`core` must not bundle a ktor engine.** All engines register for `HttpClient()` auto-discovery at the same priority, so a bundled CIO could become the host's default (CIO has no TLS on iOS). `Sniffer` uses `HttpClient()` and borrows the host's engine; tests add CIO themselves. On Android that engine obeys the network security policy, so the host must allow cleartext to the daemon (CIO used to bypass it). The samples set `usesCleartextTraffic`.
- **KMP `commonMain` has no reflection and no host APIs** like `Date.now()` / `Math.random()`; use `expect` / `actual` (see `Platform.kt`).
- **Android's ICU regex is stricter than the JVM's:** a bare `}` compiles on the JVM but throws `PatternSyntaxException` at class init on Android (`ExceptionInInitializerError` in the host). jvmTest cannot catch it; escape every literal brace and keep regexes out of hot init paths.
- **Clearing traffic must survive buffer replay:** a reconnecting SDK dumps up to 1000 buffered messages. The daemon keeps per-kind clear watermarks (`clearedAt` in `server.ts`) and drops messages older than the last clear (5 s skew tolerance).
- The UI version comes from `server/daemon/package.json` at build time (`__APP_VERSION__` in `vite.config.ts`); do not hardcode it.

## Releasing

**Never publish (Maven / npm) or bump a version on your own.** Maven Central is immutable and version numbers belong to the maintainer. If a task seems to need a release, stop, explain why, and wait for a go-ahead naming the version.

Credentials never live in the repo.

**SDK to Maven Central** (`io.github.dev-weiqi.sniffer:*`, vanniktech maven-publish):

1. Bump `VERSION_NAME` in `client/gradle.properties` (the only version to touch) and `snifferVersion` in README.
2. `cd client && ./gradlew publishAndReleaseToMavenCentral` builds, signs, uploads and releases the library modules (samples excluded).
3. Verify after about 5 to 10 minutes: `curl -sI https://repo1.maven.org/maven2/io/github/dev-weiqi/sniffer/core/<v>/core-<v>.pom` returns 200.

Credentials in `~/.gradle/gradle.properties`: `mavenCentralUsername` / `mavenCentralPassword` (Sonatype user token, GitHub login `dev-weiqi`) and `signingInMemoryKey` (GPG key `D16D24AA5054EA6728416BD43972135B03CC9821`, no passphrase, public key on keys.openpgp.org). POM metadata is in `client/gradle.properties`.

**Daemon to npm** (`@dev-weiqi/sniffer`, from `server/daemon`):

1. Bump `version` in `server/daemon/package.json` (independent of the SDK version) and the pinned example `npm install -g @dev-weiqi/sniffer@<v>` in README. Badges update themselves; body text does not.
2. `cd server/daemon && npm publish --access public`. `prepack` compiles to `dist/` and bundles the UI into `ui-dist/`.
3. Verify with `npm view @dev-weiqi/sniffer version`, then install the tarball in a temp dir and smoke test `sniffer start` plus `curl /api/state`.

npm credentials are in `~/.npmrc`: a granular token scoped to `@dev-weiqi/sniffer` with bypass 2FA. Rotate it at npmjs.com when it expires.

The daemon loads the UI from `../ui/dist` first, then `ui-dist/`, so a stale `ui-dist/` never shadows a fresh build. `postpack` removes the staging dir; keep both layouts working if files move.

## Style

Match the surrounding code; comment only non-obvious constraints. Code and docs in English.
