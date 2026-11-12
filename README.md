# OPUROM Plugins (R2)

Three reference plugins for the OPUROM plugin protocol v1, plus a local offline
registry and a zero-dependency Node CLI.

The plugins are **real processes** with **real handshakes** — not mocks. The
hardware behind them is **simulated**: every result is deterministic.

- Protocol: `opurom-spec/PLUGIN_PROTOCOL.md` v1 (`"protocol": "1.0"`)
- Plugins: `camera`, `notification`, `storage`
- Registry: `registry.json` (local, offline)
- CLI: `bin/opurom-plugin.mjs` (Node builtins only)

## Layout

```
plugins/<name>/plugin.json    manifest (name, version, protocol, capabilities, entry, description)
plugins/<name>/src/main.rs    the plugin implementation (Rust, no dependencies)
plugins/<name>/bin/<name>     built executable (gitignored, rebuilt by scripts/build.sh)
rust/json.rs                  shared minimal JSON reader/writer used by all three plugins
registry.json                 local offline index of the plugins
bin/opurom-plugin.mjs         CLI: list | verify | invoke
lib/host.mjs                  host helpers (spawn, handshake, manifest validation)
test/                         node:test conformance suite
test-fixtures/                test-only plugin stubs (slow, wrong id, override)
scripts/build.sh              builds all three plugins with cargo
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

Every plugin in this repo:

- answers `hello` with its name, version and capability list;
- answers `invoke` for its declared capabilities only;
- answers any other capability with `{"id":N,"ok":false,"error":"unknown capability: X"}`;
- recovers from a malformed request line with an error response and keeps running;
- echoes the request `id` in every response;
- writes logs to stderr only.

## Build

Requires Rust (1.99.1 used here) and Node (v26 used here).

```bash
./scripts/build.sh
```

The script runs `cargo build --release --manifest-path` for each plugin and copies
the executable to `plugins/<name>/bin/<name>`. `bin/` and `target/` are
gitignored.

`node bin/opurom-plugin.mjs verify` also rebuilds the plugins when their
executables are missing, so a fresh clone works without a manual build step.

## Usage

```bash
node bin/opurom-plugin.mjs list
node bin/opurom-plugin.mjs verify
node bin/opurom-plugin.mjs invoke camera camera.takePhoto '{"quality":"high"}'
node bin/opurom-plugin.mjs invoke storage storage.put '{"key":"theme","value":"dark"}'
node bin/opurom-plugin.mjs invoke storage storage.get '{"key":"theme"}'
```

`verify` parses every manifest, validates its fields, checks that the entry is
an executable file inside the plugin directory, spawns the plugin, performs a
real `hello` handshake and one real `invoke`, and prints `PASS`/`FAIL` per
plugin. It exits nonzero if any plugin fails.

`invoke` spawns the plugin, performs the handshake, performs the invocation and
prints the JSON result. It exits nonzero when the plugin reports an error.

### Environment

| Variable | Meaning |
| --- | --- |
| `OPR_PLUGIN_BIN` | `name=/abs/path,other=/abs/path` — overrides the executable of a plugin |
| `OPR_PLUGIN_TIMEOUT_MS` | request timeout in milliseconds (default `500`, bounded to 50..5000) |

```bash
OPR_PLUGIN_BIN="camera=/tmp/my-camera" node bin/opurom-plugin.mjs invoke camera camera.takePhoto
```

## Tests

```bash
node --test
```

The suite covers the registry shape, manifest validation, a real handshake for
all three built plugins, every declared capability, the unknown-capability
error, malformed-request recovery, timeout behaviour (using a test-only slow
stub in `test-fixtures/`), traversal rejection and the CLI exit codes.

## Add a plugin

1. Create `plugins/<name>/plugin.json`:

   ```json
   {
     "name": "<name>",
     "version": "0.1.0",
     "protocol": "1.0",
     "capabilities": ["<namespace>.<action>"],
     "entry": "./bin/<name>",
     "description": "<one line>"
   }
   ```

   `name` matches `[a-z][a-z0-9-]{1,31}`, `version` is `x.y.z`, `protocol` is
   `"1.0"`, capabilities are non-empty dotted names, and `entry` must resolve
   to an executable file inside the plugin directory (no `..`).

2. Create `plugins/<name>/Cargo.toml` (a `[[bin]]` named `<name>` with no
   dependencies) and `plugins/<name>/src/main.rs`. Copy the request loop from an
   existing plugin; `rust/json.rs` is shared source, included with
   `#[path = "../../../rust/json.rs"] mod json;`.

3. Build it:

   ```bash
   cargo build --release --manifest-path plugins/<name>/Cargo.toml
   mkdir -p plugins/<name>/bin && cp plugins/<name>/target/release/<name> plugins/<name>/bin/
   ```

   Or add the plugin to `scripts/build.sh`.

4. Register it in `registry.json`:

   ```json
   { "name": "<name>", "version": "0.1.0", "path": "plugins/<name>", "capabilities": ["<namespace>.<action>"] }
   ```

5. Check it: `node bin/opurom-plugin.mjs verify`.

## Status (honest)

What this repo does:

- three real, separately built plugin processes speaking protocol v1;
- deterministic **simulated** hardware (the camera returns a fixed path, the
  notification is never shown on screen, storage keeps a JSON map in
  `plugins/storage/tmp/state.json`);
- a local **offline** registry — no network access anywhere in this repo;
- a CLI that really spawns the plugins and really performs the handshake.

What it does **not** do (R3+):

- no OS hardware bindings — the camera and the notification are simulations;
- no plugin signing, no publisher identity, no trust chain;
- no sandboxing — no seatbelt, no landlock, no resource limits; a plugin can
  touch the whole filesystem;
- no remote marketplace, no package download, no plugin updates;
- no dependency or vulnerability scanning of plugin binaries;
- no multi-host concurrency guarantee for the storage file (the whole map is
  rewritten without locking);
- the timeout applies to the CLI's own requests only — the `opurom-core` plugin
  host keeps its own 500 ms default.
