# OPUROM Plugins (R10)

Seven reference plugins for the OPUROM plugin protocol v1, a local offline
registry, a zero-dependency Node CLI, and an explicitly granted native-capability
API. The plugins are **real processes** with **real handshakes**; all devices
behind them are **deterministic mocks**.

- Protocol: `opurom-spec/PLUGIN_PROTOCOL.md` v1 (`"protocol": "1.0"`)
- R10 capabilities: camera, geolocation, bluetooth, notifications, payment, share
- Compatibility plugins: `storage`
- Registry: `registry.json` (local, offline)
- CLI: `bin/opurom-plugin.mjs` (Node builtins only)
- Permission host: `lib/capabilities.mjs` (Node builtins only)

## Capability set and permission model

The six R10 capabilities are exactly:

| Capability | Plugin | Deterministic mock reply |
| --- | --- | --- |
| `camera.takePhoto` | `camera` | fixed PNG path, quality, width and height |
| `geolocation.getCurrentPosition` | `geolocation` | fixed latitude, longitude and accuracy |
| `bluetooth.scan` | `bluetooth` | one fixed beacon with a fixed RSSI |
| `notification.show` | `notification` | a simulated delivery record with the title and message |
| `payment.request` | `payment` | a fixed approved transaction with the requested amount |
| `share.send` | `share` | a fixed share-sheet target with the title and text |

Every plugin declares its capability in both `registry.json` and its
`plugins/<name>/plugin.json` manifest. `CapabilityHost` receives an explicit
set of grants; there is no ambient or implicit permission. Before any process is
spawned it checks the catalog, the grant, the registry entry, the manifest, and
the executable. A denied or undeclared capability returns a typed error and
never executes the plugin.

```js
import { CapabilityHost } from './lib/capabilities.mjs';

const host = new CapabilityHost({ grants: ['camera.takePhoto'] });
const photo = await host.invoke('camera.takePhoto', { quality: 'high' });
await host.close();
```

| Typed error | `code` | Meaning |
| --- | --- | --- |
| `CapabilityDeniedError` | `ERR_CAPABILITY_DENIED` | the app did not explicitly grant the capability |
| `CapabilityUndeclaredError` | `ERR_CAPABILITY_UNDECLARED` | no registry entry and manifest declare the capability |
| `PluginCrashError` | `ERR_PLUGIN_CRASH` | the plugin exited abruptly or its pipe broke |
| `PluginProtocolError` | `ERR_PLUGIN_FRAME` | a response line is malformed or invalid |
| `PluginTimeoutError` | `ERR_PLUGIN_TIMEOUT` | no response arrived within the request timeout |
| `CircuitOpenError` | `ERR_CIRCUIT_OPEN` | the breaker is open; `retryAfterMs` reports the cooldown |

This is an **application-level permission sandbox**, not an OS sandbox. There
are no OS permission prompts, no real camera or Bluetooth hardware, no real
payment provider, and no real share sheet. Real devices, OS permission prompts,
platform bindings and a security-grade process sandbox remain R11+ work.

## Layout

```
plugins/<name>/plugin.json    manifest (name, version, protocol, capabilities, entry, description)
plugins/<name>/src/main.rs    plugin implementation (Rust, no dependencies)
plugins/<name>/bin/<name>     built executable (gitignored, rebuilt by scripts/build.sh)
rust/json.rs                  shared minimal JSON reader/writer
rust/protocol.rs              shared request loop for the four new mock-device plugins
registry.json                 local offline index of the seven plugins
bin/opurom-plugin.mjs         CLI: list | verify | invoke
lib/host.mjs                  host helpers (spawn, handshake, manifest validation)
lib/capabilities.mjs          explicit grants, declarations, breaker, isolated dispatch
test/capabilities.test.mjs    real process tests for grants, denials, faults and reaping
test/                         node:test conformance suite
test-fixtures/                test-only plugin stubs
scripts/build.sh              builds all seven plugins with cargo
```

## Protocol summary

One JSON object per line on stdin, one JSON object per line on stdout. Logs go
to stderr only; stdout carries nothing but responses.

```json
{"id":0,"method":"hello","protocol":"1.0"}
{"id":0,"ok":true,"result":{"name":"camera","version":"0.1.0","capabilities":["camera.takePhoto"]}}
{"id":1,"method":"invoke","capability":"camera.takePhoto","params":{"quality":"high"}}
{"id":1,"ok":true,"result":{"path":"/tmp/opurom-photo.png","quality":"high","width":640,"height":480}}
{"id":2,"method":"invoke","capability":"camera.nope","params":{}}
{"id":2,"ok":false,"error":"unknown capability: camera.nope"}
```

Every plugin in this repo answers `hello` with its name, version and declared
capabilities; answers `invoke` for declared capabilities only; returns a typed
error for an unknown capability; recovers from a malformed request line; echoes
the request `id`; and writes logs to stderr only.

## Build

Requires Rust (1.99.1 used here) and Node (v26 used here).

```bash
./scripts/build.sh
```

The script runs `cargo build --release --manifest-path` for each plugin and copies
the executable to `plugins/<name>/bin/<name>`. `bin/` and `target/` are
gitignored. `node bin/opurom-plugin.mjs verify` also rebuilds plugins when an
executable is missing, so a fresh clone works without a manual build step.

## Usage

```bash
node bin/opurom-plugin.mjs list
node bin/opurom-plugin.mjs verify
node bin/opurom-plugin.mjs invoke camera camera.takePhoto '{"quality":"high"}'
node bin/opurom-plugin.mjs invoke geolocation geolocation.getCurrentPosition
node bin/opurom-plugin.mjs invoke storage storage.put '{"key":"theme","value":"dark"}'
node bin/opurom-plugin.mjs invoke storage storage.get '{"key":"theme"}'
```

`verify` parses every manifest, validates its fields, checks that its entry is
an executable inside the plugin directory, spawns the plugin, performs a real
`hello` handshake and one real `invoke`, and prints `PASS`/`FAIL` per plugin.

The legacy `invoke` command is retained for protocol compatibility. Add
`--grant <capability>[,<capability>...]` to use the explicit permission host:

```bash
node bin/opurom-plugin.mjs invoke camera camera.takePhoto '{"quality":"high"}' --grant camera.takePhoto
# {"path":"/tmp/opurom-photo.png","quality":"high","width":640,"height":480}

node bin/opurom-plugin.mjs invoke camera camera.takePhoto '{}' --grant notification.show
# {"ok":false,"error":{"code":"ERR_CAPABILITY_DENIED", ... }}
```

Without a matching grant, the second command does not spawn the camera process.
An undeclared capability returns `ERR_CAPABILITY_UNDECLARED` before any spawn.

### Environment

| Variable | Meaning |
| --- | --- |
| `OPR_PLUGIN_BIN` | `name=/abs/path,other=/abs/path` — overrides plugin executables |
| `OPR_PLUGIN_TIMEOUT_MS` | request timeout in milliseconds (default `500`, bounded to 50..5000) |

## Crash isolation and circuit breaker

`CapabilityHost` spawns a fresh process per granted call, validates its hello
frame and its invocation response, and always waits for process exit on close.
An abrupt exit, broken pipe, timeout or malformed JSON-lines frame becomes a
typed error; the host stays alive and the next call gets a fresh process.

The breaker mirrors the R9 scheduler concept: states are `closed`,
`half-open` and `open`. A configurable number of consecutive faults opens it;
`CircuitOpenError.retryAfterMs` reports the remaining cooldown; one trial after
cooldown closes the circuit on success or reopens it on failure. Defaults are
three faults and 1000 ms, and an injected `clock` makes cooldown tests
deterministic. `CapabilityHost.close()` reaps every active process; the suite
checks that no child PIDs survive crashes, malformed frames and shutdown.

## Tests

```bash
node --test
node --check <every tracked .js and .mjs file>
./scripts/build.sh
```

`node --test` runs **44 tests**: all 35 pre-existing R2/R9 tests remain green and
9 new real-process tests cover the capability catalog, registry declarations,
every capability's deterministic reply, the permission matrix, CLI grant/deny,
crash recovery, malformed-frame recovery, breaker states with cooldown, and no
leftover child processes. `node --test` output includes test names containing
`capability`, `permission` and `deny`. Rust plugin builds and Node checks report
zero warnings.

## Add a plugin

1. Create `plugins/<name>/plugin.json` with `name`, `version`, `protocol`, a
   `capabilities` array, `entry` and `description`.
2. Create `plugins/<name>/Cargo.toml` (a `[[bin]]` named `<name>` with no
   dependencies) and `plugins/<name>/src/main.rs`. New mock devices can call
   `protocol::run` from `rust/protocol.rs`; original plugins use `rust/json.rs`.
3. Add the plugin name to `scripts/build.sh`, register it in `registry.json`,
   and add its capability to `CAPABILITY_CATALOG` only if it is an R10 native
   capability. A new catalog entry also needs an explicit app grant.
4. Check it: `node bin/opurom-plugin.mjs verify`.

`name` matches `[a-z][a-z0-9-]{1,31}`, `version` is `x.y.z`, `protocol` is
`"1.0"`, capabilities are non-empty dotted names, and `entry` resolves to an
executable file inside the plugin directory (no `..`).

## Integration with `opurom-core`

`opurom-core plugins <pluginDir> <capability>` loads a plugin from this repo,
performs the handshake and invokes the capability with empty params. Its R10
`CapabilityHost` also enforces explicit grants before lazy loading, so denial
never starts the plugin process.

```bash
../opurom-core/target/release/opurom-core plugins plugins/camera camera.takePhoto
../opurom-core/target/release/opurom-core plugins plugins/geolocation geolocation.getCurrentPosition
```

## Status (honest)

What this repo does:

- seven real, separately built plugin processes speaking protocol v1;
- six explicitly granted native capabilities with deterministic **mock** replies;
- typed denial for ungranted or undeclared capabilities before any spawn;
- process isolation for crashes and malformed frames, with a configurable
  breaker, cooldown recovery and verified child-process reaping;
- a local **offline** registry and a CLI that really spawns and handshakes.

What it does **not** do (R11+):

- no real OS hardware bindings, camera, Bluetooth, geolocation, payment or
  share sheet, and no OS permission prompts;
- no OS-level sandbox — no seatbelt, landlock, seccomp, filesystem or network
  namespace restriction, or resource limits for the child;
- no plugin signing, publisher identity, trust chain, remote marketplace,
  package download, plugin updates, or dependency/vulnerability scanning;
- no multi-host concurrency guarantee for the storage file;
- no cross-process breaker sharing: each `CapabilityHost` owns its own state.
