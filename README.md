# OPUROM Plugins

Seven reference plugins for the OPUROM plugin protocol v1, a local offline
registry, a zero-dependency Node CLI, and an allow/deny permission-gated
native-capability API. The plugins are **real processes** with **real
handshakes**; all devices behind them are **deterministic mocks**.

- Protocol: `opurom-spec/PLUGIN_PROTOCOL.md` v1 (`"protocol": "1.0"`)
- Native capabilities: camera, geolocation, bluetooth, notifications, payment, share
- Compatibility plugins: `storage`
- Registry: `registry.json` (local, offline)
- CLI: `bin/opurom-plugin.mjs` (Node builtins only)
- Permission host: `lib/capabilities.mjs` (Node builtins only)

## Capability set and permission model

The six native capabilities are exactly:

| Capability | Plugin | Deterministic mock reply |
| --- | --- | --- |
| `camera.takePhoto` | `camera` | fixed PNG path, quality, width and height |
| `geolocation.getCurrentPosition` | `geolocation` | fixed latitude, longitude and accuracy |
| `bluetooth.scan` | `bluetooth` | one fixed beacon with a fixed RSSI |
| `notification.show` | `notification` | a simulated delivery record with the title and message |
| `payment.request` | `payment` | a fixed approved transaction with the requested amount |
| `share.send` | `share` | a fixed share-sheet target with the title and text |

Every plugin declares its capability in both `registry.json` and its
`plugins/<name>/plugin.json` manifest. The app supplies a **permission
manifest** to `CapabilityHost`: `permissions: { allow: [...], deny: [...] }`
(the `grants` option is a shorthand for `allow`). A capability runs only when
it is in `allow` and not in `deny`. **Deny wins.** Anything absent from the
manifest is denied by default; there is no ambient or implicit permission.
The manifest is validated at construction: wrong types, unknown capabilities
and unknown fields raise `PermissionManifestError` with the offending field.
`check(capability)` is a pure, deterministic decision over those lists. Before
any process is spawned the host also checks the catalog, the registry entry,
the plugin manifest and the executable. A denied or undeclared capability
returns a typed error and never executes the plugin.

`loadRegistry` validates the whole index: every entry satisfies the
registry-entry rules, plugin names are unique and each capability is claimed by
one plugin only. Duplicate names or claims would make a grant resolve
ambiguously. An invalid registry is rejected before use: `list`, `verify` and
legacy `invoke` report the errors and exit nonzero, while the permission host
raises `ERR_CAPABILITY_UNDECLARED` without spawning a process.

```js
import { CapabilityHost } from './lib/capabilities.mjs';

const host = new CapabilityHost({
  permissions: { allow: ['camera.takePhoto', 'share.send'], deny: ['share.send'] },
});
const photo = await host.invoke('camera.takePhoto', { quality: 'high' });
// host.invoke('share.send') rejects: allow and deny both list it, and deny wins.
await host.close();
```

| Typed error | `code` | Meaning |
| --- | --- | --- |
| `CapabilityDeniedError` | `ERR_CAPABILITY_DENIED` | the app did not grant the capability (`not-granted`) or explicitly denied it (`explicit-deny`) |
| `CapabilityUndeclaredError` | `ERR_CAPABILITY_UNDECLARED` | no registry entry and manifest declare the capability |
| `PermissionManifestError` | `ERR_PERMISSION_MANIFEST` | the permission manifest is malformed; `errors` names every offending field |
| `PluginCrashError` | `ERR_PLUGIN_CRASH` | the plugin exited abruptly or its pipe broke |
| `PluginProtocolError` | `ERR_PLUGIN_FRAME` | a response line is malformed or invalid |
| `PluginTimeoutError` | `ERR_PLUGIN_TIMEOUT` | no response arrived within the request timeout |
| `PluginConfigError` | `ERR_PLUGIN_CONFIG` | a zero, negative or non-finite timeout was passed at configuration time |
| `CircuitOpenError` | `ERR_CIRCUIT_OPEN` | the breaker is open; `retryAfterMs` reports the cooldown |

This is an **application-level permission sandbox**: the allow/deny check
happens in the host process, before the plugin is spawned. `check()` never
mutates the host, so repeated calls return the same decision. The devices
behind the plugins are deterministic mocks, so the capability calls are
reproducible offline.

## Layout

```
plugins/<name>/plugin.json    manifest (name, version, protocol, capabilities, entry, description)
plugins/<name>/src/main.rs    plugin implementation (Rust, no dependencies)
plugins/<name>/bin/<name>     built executable (gitignored, rebuilt by scripts/build.sh)
rust/json.rs                  shared minimal JSON reader/writer
rust/protocol.rs              shared request loop for the four new mock-device plugins
registry.json                 local offline index of the seven plugins
bin/opurom-plugin.mjs         CLI: list | verify | invoke
lib/host.mjs                  host helpers (spawn, handshake, manifest and registry validation)
lib/capabilities.mjs          allow/deny manifests, declarations, breaker, isolated dispatch
test/capabilities.test.mjs    permission and real process tests for grants, denials, faults and reaping
test/audit.test.mjs           bounded invocation audit-trail tests
test/health.test.mjs          per-plugin health snapshot tests
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
`--grant <capability>[,<capability>...]` and
`--deny <capability>[,<capability>...]` to use the permission host; both feed
the permission manifest:

```bash
node bin/opurom-plugin.mjs invoke camera camera.takePhoto '{"quality":"high"}' --grant camera.takePhoto
# {"path":"/tmp/opurom-photo.png","quality":"high","width":640,"height":480}

node bin/opurom-plugin.mjs invoke camera camera.takePhoto '{}' --grant notification.show
# {"ok":false,"error":{"code":"ERR_CAPABILITY_DENIED", ... }}

node bin/opurom-plugin.mjs invoke camera camera.takePhoto '{}' --grant camera.takePhoto --deny camera.takePhoto
# {"ok":false,"error":{"code":"ERR_CAPABILITY_DENIED","reason":"explicit-deny", ... }}
```

Without a matching grant, the second command does not spawn the camera process.
`--deny` wins over `--grant` for the same capability, and a malformed manifest
returns `ERR_PERMISSION_MANIFEST`. An undeclared capability returns
`ERR_CAPABILITY_UNDECLARED` before any spawn.

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

The breaker states are `closed`,
`half-open` and `open`. A configurable number of consecutive faults opens it;
`CircuitOpenError.retryAfterMs` reports the remaining cooldown; one trial after
cooldown closes the circuit on success or reopens it on failure. Defaults are
three faults and 1000 ms, and an injected `clock` makes cooldown tests
deterministic. `CapabilityHost.close()` reaps every active process; the suite
checks that no child PIDs survive crashes, malformed frames and shutdown.

## Invocation audit trail

`CapabilityHost` appends one immutable entry to an in-memory trail for every
`invoke` attempt. Each entry holds a monotonically increasing sequence number,
the capability, the decision (`allowed`, `denied` or `error`) and its reason:
`granted`, a deny reason (`explicit-deny`, `not-granted` or `undeclared`), or
the typed error code of a fault. Entries carry no timestamps or process data,
so the same call sequence produces the same trail.

`host.audit()` returns a snapshot. Entries are frozen, the returned array is a
copy, and the host retains the most recent `AUDIT_LIMIT` (100) entries when
that limit is reached. `check()` stays pure and appends nothing. Denials,
circuit rejections, crashes and timeouts all appear in the trail, so the
decisions behind an isolated plugin remain inspectable.

```js
const host = new CapabilityHost({ permissions: { allow: [], deny: [] } });
await host.invoke('camera.takePhoto').catch(() => {});
host.audit();
// [{ seq: 1, capability: 'camera.takePhoto', decision: 'denied', reason: 'not-granted' }]
await host.close();
```

## Per-plugin health

`CapabilityHost.health(plugin)` returns one frozen snapshot of the counters that
belong to a single plugin: `invocations`, `denials`, `crashes` and
`lastErrorCode`. Every `invoke` attempt for one of that plugin's catalog
capabilities is counted once, a permission or declaration denial adds to
`denials`, a dead plugin process adds to `crashes`, and `lastErrorCode` keeps
the code of the most recent fault (`null` before the first one).

The counters are keyed by the six-capability catalog, so the host tracks at most
six plugins no matter how many attempts run, and they cover the whole lifetime
while the audit trail stays bounded at `AUDIT_LIMIT`. `check()` stays pure and
records nothing.

```js
const host = new CapabilityHost({ permissions: { allow: [], deny: [] } });
await host.invoke('camera.takePhoto').catch(() => {});
host.health('camera');
// { plugin: 'camera', invocations: 1, denials: 1, crashes: 0, lastErrorCode: 'ERR_CAPABILITY_DENIED' }
await host.close();
```

## Tests

```bash
npm test
node --check <every tracked .js and .mjs file>
./scripts/build.sh
```

`npm test` runs **66 tests**: 39 protocol, CLI, registry and recovery tests, 17
capability-host tests, 4 timeout-configuration tests, 3 audit-trail tests and 3
health-snapshot tests.
They cover the capability catalog, registry declarations, whole-registry
validation of entries, names and capability claims, every capability's
deterministic reply, the permission matrix, deny precedence and default deny,
manifest validation, deterministic permission checks, CLI grant/deny, crash
recovery, malformed-frame recovery, breaker states with cooldown, timeout
bounds, no leftover child processes, a bounded append-only audit trail
over allowed, denied and failed invocations, and exact per-plugin health
counters for invocations, denials, crashes and the last error code. `npm test`
output includes test names containing `capability`, `permission` and `deny`.

## Add a plugin

1. Create `plugins/<name>/plugin.json` with `name`, `version`, `protocol`, a
   `capabilities` array, `entry` and `description`.
2. Create `plugins/<name>/Cargo.toml` (a `[[bin]]` named `<name>` with no
   dependencies) and `plugins/<name>/src/main.rs`. New mock devices can call
   `protocol::run` from `rust/protocol.rs`; original plugins use `rust/json.rs`.
3. Add the plugin name to `scripts/build.sh`, register it in `registry.json`,
   and add its capability to `CAPABILITY_CATALOG` only if it is a native
   capability. A new catalog entry also needs an entry in the app's `allow` list.
4. Check it: `node bin/opurom-plugin.mjs verify`.

`name` matches `[a-z][a-z0-9-]{1,31}`, `version` is `x.y.z`, `protocol` is
`"1.0"`, capabilities are non-empty dotted names, and `entry` resolves to an
executable file inside the plugin directory (no `..`).

## Integration with `opurom-core`

`opurom-core plugins <pluginDir> <capability>` loads a plugin from this repo,
performs the handshake and invokes the capability with empty params. Its
`CapabilityHost` also enforces explicit grants before lazy loading, so denial
never starts the plugin process.

```bash
../opurom-core/target/release/opurom-core plugins plugins/camera camera.takePhoto
../opurom-core/target/release/opurom-core plugins plugins/geolocation geolocation.getCurrentPosition
```

## Status

- seven real, separately built plugin processes speaking protocol v1;
- six permission-gated native capabilities with deterministic **mock** replies;
- an allow/deny permission manifest with deny precedence, default deny and
  strict validation, checked deterministically before any spawn;
- typed denial for ungranted, explicitly denied or undeclared capabilities
  before any spawn;
- whole-registry validation of entries, unique plugin names and unique
  capability claims, applied before any entry is used;
- process isolation for crashes and malformed frames, with a configurable
  breaker, cooldown recovery and child-process reaping;
- a bounded, append-only invocation audit trail of allowed, denied and failed
  decisions, exposed through `host.audit()`;
- per-plugin health counters for invocations, denials, crashes and the last
  error code, exposed through `host.health(plugin)`;
- a local **offline** registry and a CLI that really spawns and handshakes.

The devices behind the plugins are deterministic mocks: the camera, Bluetooth,
geolocation, payment and share replies are fixed values, not hardware. The
permission model lives in the host process, so the allow/deny check happens before
the plugin is spawned.
