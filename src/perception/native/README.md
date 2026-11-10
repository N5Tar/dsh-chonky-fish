# macOS activity collector

The plugin starts this thin executable only after explicit user start. It emits one bounded JSON line immediately and every five seconds after the preceding sample completes. No backlog is replayed. It reads only foreground application bundle identity/name and aggregate seconds since any system input; it never reads titles, URLs, contents or individual input events. Lock state is intentionally `unknown`.

`mach_continuous_time` includes sleep. A gap over ten seconds, non-increasing clock or wall-clock discrepancy marks a continuity break. stdin EOF, SIGTERM and broken stdout terminate the executable. stdin is not a command channel.

## Build

```sh
node src/perception/build-native.mjs
node src/perception/build-native.mjs --all
# Optional explicit locally installed SDK when the default CLT SDK is incompatible:
SDKROOT=/path/to/MacOSX.sdk node src/perception/build-native.mjs --all
```

On a CLT installation containing **identical** `usr/include/swift/module.modulemap` and `bridging.modulemap` declarations, compilation can fail with `redefinition of module SwiftBridging` (and cascading misleading SDK-version errors). An explicit opt-in workaround is available:

```sh
node src/perception/build-native.mjs --all --clt-modulemap-workaround
```

This validates that both declaration bodies match and generates a compiler-private Swift/Clang VFS overlay and module cache in ignored `native/.build/`. Only the redundant map is hidden from that compilation; no SDK/toolchain/system file is edited. Normal builds do not enable this workaround. Generated overlays are developer-only artifacts and should not be packaged.

Outputs are `macos/arm64/activity-collector` and `macos/x64/activity-collector`, executable mode 0755. `--all` cross-compiles both architectures using the installed macOS SDK. Deployment target is macOS 11.0, not a claim of validation on every OS version. Release signing/notarization and installed/quarantined execution require distribution-level verification.

## Privacy-safe tests

```sh
node src/perception/tests/run-collector.mjs
node src/perception/tests/run-collector.mjs --native
```

Default tests use fake processes only. `--native` always passes `--self-test`, which emits a fixed synthetic application without accessing NSWorkspace or CGEventSource. It verifies the five-second timer, EOF and TERM exits. Routine automated tests must use `--self-test`: the normal entry point reads real foreground activity. The separate opt-in live comparison below is intentionally excluded from `npm test` and requires an explicit observation duration.

## Verified development build (2026-11-09)

Host: Apple Silicon, macOS 14.7.6 (23H626), Node 24.17.0; CLT Swift 6.0.3 (`swiftlang-6.0.3.1.10`), default macOS 15.2 SDK. Successful command:

```sh
node src/perception/build-native.mjs --all --clt-modulemap-workaround
node src/perception/tests/run-collector.mjs --native
node src/perception/tests/run-collector.mjs --native --native-arch=x64
```

Both builds exited 0. `file` identified arm64 and x86_64 Mach-O executables. Each test invocation passed eight fake-process/schema groups plus native synthetic five-second sampling/stdin-EOF and SIGTERM checks (10 groups total). x86_64 was executed on this Apple Silicon machine through its translation support; this is not an Intel-hardware validation. No real foreground application or idle signal was read during tests.

The normal build and an explicit macOS 14.5 SDK build failed on this host's duplicate SwiftBridging module maps. Passing only Clang `-ivfsoverlay` was insufficient for Swift SDK submodules. Passing both Swift `-vfsoverlay` and Clang `-ivfsoverlay`, with a private `-module-cache-path`, succeeded using the default SDK. System files were not modified. These failures are documented to avoid silently claiming the default local toolchain is healthy.

The documented any-input event sentinel `CGEventType(rawValue: UInt32.max)` is constructed with `guard let` during shared startup, including `--self-test`; failure exits 70 with a short diagnostic instead of force-unwrapping. Both architectures were rebuilt and the same 10-group synthetic suites passed again after adding this guard. This verifies constant construction only and does not call the idle-time API.

Not verified: normal real-signal API/permission behavior (intentionally excluded), physical Intel hardware, other macOS releases, release notarization/quarantine, installed-update replacement or a long-duration production monitoring session.

## Foreground refresh repair (2026-11-10)

The initial GCD-only `dispatchMain()` lifecycle left NSWorkspace's application state frozen in the installed long-running collector. A fresh process reported Chrome/Terminal while that collector continued reporting DSH. Synthetic timing tests could not detect this real API lifecycle issue.

The collector now runs `RunLoop.main.run()` on the actual main thread and schedules nonrepeating common-mode `Timer` callbacks. Every sample asserts `Thread.isMainThread`; AppKit can service its state updates between samples. The five-second policy, EOF/TERM handling, single process and privacy scope are unchanged.

Explicit live validation:

```sh
npm run test:perception:live -- --observe=120
# Optional A/B comparison with a preserved old executable:
node src/perception/tests/run-live.mjs --observe=120 --baseline=/absolute/old-collector
```

This briefly reads application identities from the collector and independent fresh NSWorkspace queries. It never activates windows, accesses window content or writes to the user's activity database. Manually switch between apps, remaining in each for at least ten seconds. Exit 0 requires at least two distinct system app identities and matching collector readings; exit 2 means no natural switch occurred and is **not** a successful switch test. Outputs contain application identities and timestamps, so treat them as diagnostic metadata.

### Repair validation result

On 2026-11-10, a 120-second time-bracketed A/B test observed real Codex → DSH → Codex switching without activating windows automatically. All 23 stable before/after comparisons matched the corrected collector; one transition-overlap sample was marked inconclusive rather than forced into pass/fail. The preserved original collector stayed at Codex while DSH held focus. This verifies foreground refresh on the current machine. Terminal was not observed during this final window, and other hardware/macOS versions remain unverified. Both architecture synthetic lifecycle suites also passed after the RunLoop change.

The first live checker queried twice after the sample and reported one startup mismatch during a real switch; that diagnostic log is retained. The checker was corrected to bracket the sample in time, not to ignore stable mismatches. Two earlier windows without any app switch exited 2 and were not counted as passes.

## JavaScript contract

`createCollector({ binaryPath, supported, onSample, onState, onError })` does not spawn during construction. `start()` resolves `{runId}` after the first validated sample has synchronously persisted through `onSample`. The callback receives `runId` and `receivedAtMs` as well as the projected wire fields. Promise-returning persistence is rejected; use a synchronous database transaction. Throwing stops collection.

`getStatus()` returns `{state,runId,lastSampleAt,error}`. States are stopped, starting, running, stale, stopping, error, unsupported and disposed. Startup has a 20-second deadline. Subsequent 20-second silence marks stale without restarting; the first resumed sample marks a continuity break. Host owns detailed unsupported-platform reasons.

`stop()` and `dispose()` wait for process close. TERM escalates to KILL after three seconds. New starts cannot overlap the retiring process; dispose is permanent. A process that cannot be killed is deliberately not treated as closed. Errors are bounded generic diagnostics, never raw activity lines. The parser enforces 16 KiB per line, valid UTF-8, known enums, finite nonnegative numbers and bounded identity strings. Missing optional facts become null/unknown and are explicitly marked missing.
