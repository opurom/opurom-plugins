// Shared plugin-host helpers for the OPUROM reference plugins.
// Node builtins only: no third-party dependency.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL = '1.0';
export const DEFAULT_TIMEOUT_MS = 500;
export const MIN_TIMEOUT_MS = 50;
export const MAX_TIMEOUT_MS = 5000;

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CAPABILITY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;

// Parameters used by `verify` when it exercises one capability of a plugin.
// The protocol itself does not define them; these keep the probe meaningful.
const VERIFY_PARAMS = {
  'camera.takePhoto': { quality: 'high' },
  'geolocation.getCurrentPosition': {},
  'bluetooth.scan': {},
  'notification.show': { title: 'verify', message: 'verify' },
  'payment.request': { amount: 100 },
  'share.send': { title: 'verify', text: 'verify' },
  'network.request': { method: 'GET', url: 'https://example.invalid/verify' },
  'storage.put': { key: 'verify', value: 1 },
  'storage.get': { key: 'verify' },
};

export class PluginCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginCrashError';
    this.code = 'ERR_PLUGIN_CRASH';
  }
}

export class PluginProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginProtocolError';
    this.code = 'ERR_PLUGIN_FRAME';
  }
}

export class PluginTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginTimeoutError';
    this.code = 'ERR_PLUGIN_TIMEOUT';
  }
}

export class PluginConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginConfigError';
    this.code = 'ERR_PLUGIN_CONFIG';
  }
}

/** An explicitly configured timeout must be a positive finite number; only the env/default path clamps. */
export function assertConfiguredTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PluginConfigError(`timeoutMs must be a positive finite number, got ${String(value)}`);
  }
}

export function verifyParams(capability) {
  return VERIFY_PARAMS[capability] ?? {};
}

/** Clamp the request timeout into the range the protocol allows (50 ms .. 5000 ms). */
export function resolveTimeout(value) {
  const raw = value ?? process.env.OPR_PLUGIN_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(parsed)));
}

/** `OPR_PLUGIN_BIN="camera=/abs/path,storage=/abs/path"` overrides plugin executables. */
export function parseBinaryOverrides(raw) {
  const overrides = new Map();
  if (!raw) return overrides;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const file = trimmed.slice(eq + 1).trim();
    if (name && file) overrides.set(name, file);
  }
  return overrides;
}

export function loadRegistry(root = ROOT) {
  const file = path.join(root, 'registry.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { registry: null, errors: [`cannot read ${file}: ${err.message}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { registry: null, errors: [`invalid JSON in ${file}: ${err.message}`] };
  }
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('registry must be a JSON object');
    return { registry: null, errors };
  }
  if (parsed.version !== 1) {
    errors.push(`unsupported registry version: ${JSON.stringify(parsed.version)}`);
  }
  if (!Array.isArray(parsed.plugins) || parsed.plugins.length === 0) {
    errors.push('registry.plugins must be a non-empty array');
    return { registry: null, errors };
  }
  // Duplicate names or claims would make a grant resolve to an ambiguous plugin.
  const names = new Set();
  const claims = new Set();
  for (const [index, entry] of parsed.plugins.entries()) {
    for (const message of validateRegistryEntry(entry, root)) {
      errors.push(`plugin ${index}: ${message}`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.name === 'string') {
      if (names.has(entry.name)) errors.push(`duplicate plugin name: ${entry.name}`);
      names.add(entry.name);
    }
    for (const capability of Array.isArray(entry.capabilities) ? entry.capabilities : []) {
      if (claims.has(capability)) errors.push(`duplicate capability declaration: ${capability}`);
      claims.add(capability);
    }
  }
  return { registry: errors.length > 0 ? null : parsed, errors };
}

export function validateRegistryEntry(entry, root = ROOT) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['registry entry must be a JSON object'];
  }
  if (typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) {
    errors.push(`invalid plugin name: ${JSON.stringify(entry.name)}`);
  }
  if (typeof entry.version !== 'string' || !VERSION_PATTERN.test(entry.version)) {
    errors.push(`invalid plugin version: ${JSON.stringify(entry.version)}`);
  }
  if (typeof entry.path !== 'string' || entry.path.length === 0) {
    errors.push('plugin path must be a non-empty string');
  } else {
    const resolved = path.resolve(root, entry.path);
    const inside = resolved === root || resolved.startsWith(root + path.sep);
    if (!inside) errors.push(`plugin path escapes the registry root: ${entry.path}`);
  }
  if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
    errors.push('plugin capabilities must be a non-empty array');
  } else {
    for (const capability of entry.capabilities) {
      if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
        errors.push(`invalid capability: ${JSON.stringify(capability)}`);
      }
    }
  }
  return errors;
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be a JSON object'];
  }
  if (typeof manifest.name !== 'string' || !NAME_PATTERN.test(manifest.name)) {
    errors.push(`invalid name: ${JSON.stringify(manifest.name)}`);
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    errors.push(`invalid version: ${JSON.stringify(manifest.version)}`);
  }
  if (manifest.protocol !== PROTOCOL) {
    errors.push(`invalid protocol: ${JSON.stringify(manifest.protocol)}`);
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    errors.push('capabilities must be a non-empty array');
  } else {
    for (const capability of manifest.capabilities) {
      if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
        errors.push(`invalid capability: ${JSON.stringify(capability)}`);
      }
    }
  }
  if (typeof manifest.entry !== 'string' || manifest.entry.length === 0) {
    errors.push('entry must be a non-empty string');
  }
  if (typeof manifest.description !== 'string' || manifest.description.length === 0) {
    errors.push('description must be a non-empty string');
  }
  return errors;
}

/** The entry must resolve to an executable file inside the plugin directory. */
export function resolveEntry(pluginDir, entry) {
  const errors = [];
  if (typeof entry !== 'string' || entry.length === 0) {
    return { file: null, errors: ['entry must be a non-empty string'] };
  }
  if (path.isAbsolute(entry)) {
    errors.push(`entry must be relative: ${entry}`);
  }
  if (entry.split(/[\\/]/).includes('..')) {
    errors.push(`entry must not traverse out of the plugin directory: ${entry}`);
  }
  const file = path.resolve(pluginDir, entry);
  const inside = file === pluginDir || file.startsWith(pluginDir + path.sep);
  if (!inside) errors.push(`entry escapes the plugin directory: ${entry}`);
  if (errors.length > 0) return { file: null, errors };
  return { file, errors };
}

export function readManifest(pluginDir) {
  const file = path.join(pluginDir, 'plugin.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { manifest: null, errors: [`cannot read ${file}: ${err.message}`] };
  }
  try {
    return { manifest: JSON.parse(text), errors: [] };
  } catch (err) {
    return { manifest: null, errors: [`invalid JSON in ${file}: ${err.message}`] };
  }
}

/** A plugin process speaking the line-delimited JSON protocol. */
export class Plugin {
  constructor(binary, timeoutMs, options = {}) {
    assertConfiguredTimeout(timeoutMs);
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.stderr = '';
    this.lines = [];
    this.waiters = [];
    this.failure = null;
    const spawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    };
    if (options.cwd) spawnOptions.cwd = options.cwd;
    this.child = spawn(binary, [], spawnOptions);
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => resolve());
    });
    this.child.stdin.on('error', (err) => this.die(new PluginCrashError(`stdin error: ${err.message}`)));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.child.stdout.setEncoding('utf8');
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    });
    this.child.on('error', (err) => this.die(new PluginCrashError(`spawn failed: ${err.message}`)));
    this.child.on('exit', (code, signal) => {
      this.die(new PluginCrashError(`plugin exited (code ${code}, signal ${signal ?? 'none'})`));
    });
  }

  die(err) {
    if (this.failure) return;
    this.failure = err;
    while (this.waiters.length > 0) this.waiters.shift().reject(err);
  }

  nextLine() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = {
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new PluginTimeoutError(`timeout after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async request(payload) {
    if (this.failure) throw this.failure;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      throw new PluginCrashError(`stdin error: ${err.message}`);
    }
    const line = await this.nextLine();
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new PluginProtocolError(`invalid JSON response: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PluginProtocolError('response is not a JSON object');
    }
    if (parsed.id !== payload.id) {
      throw new PluginProtocolError(
        `response id ${JSON.stringify(parsed.id)} does not match request id ${payload.id}`,
      );
    }
    if (typeof parsed.ok !== 'boolean') {
      throw new PluginProtocolError('response is missing the ok field');
    }
    if (parsed.ok && !Object.hasOwn(parsed, 'result')) {
      throw new PluginProtocolError('successful response needs result');
    }
    if (!parsed.ok && typeof parsed.error !== 'string') {
      throw new PluginProtocolError('failed response needs a string error');
    }
    return parsed;
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return this.exited;
  }
}

export async function withPlugin(binary, fn, timeoutMs = resolveTimeout()) {
  const plugin = new Plugin(binary, timeoutMs);
  try {
    return await fn(plugin);
  } finally {
    await plugin.close();
  }
}

/** Real handshake against a spawned plugin process. */
export async function handshake(binary, options = {}) {
  const timeoutMs = resolveTimeout(options.timeoutMs);
  try {
    return await withPlugin(
      binary,
      async (plugin) => {
        const response = await plugin.request({ id: 0, method: 'hello', protocol: PROTOCOL });
        if (!response.ok) {
          return { ok: false, error: `hello failed: ${response.error ?? 'unknown error'}` };
        }
        const result = response.result;
        if (!result || typeof result !== 'object') {
          return { ok: false, error: 'hello result is missing' };
        }
        return { ok: true, result };
      },
      timeoutMs,
    );
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Handshake, then one real invoke. */
export async function invokeCapability(binary, capability, params = {}, options = {}) {
  const timeoutMs = resolveTimeout(options.timeoutMs);
  try {
    return await withPlugin(
      binary,
      async (plugin) => {
        const hello = await plugin.request({ id: 0, method: 'hello', protocol: PROTOCOL });
        if (!hello.ok) {
          return { ok: false, error: `hello failed: ${hello.error ?? 'unknown error'}` };
        }
        const response = await plugin.request({
          id: 1,
          method: 'invoke',
          capability,
          params,
        });
        if (!response.ok) {
          return { ok: false, error: response.error ?? 'unknown error', response };
        }
        return { ok: true, result: response.result, response };
      },
      timeoutMs,
    );
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Build the reference plugins when their executables are missing. */
export function buildPlugins(root = ROOT) {
  const script = path.join(root, 'scripts', 'build.sh');
  const result = spawnSync('bash', [script], { cwd: root, encoding: 'utf8' });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || '').trim() || `build failed (code ${result.status})` };
  }
  return { ok: true, error: null };
}

/**
 * Check one registry entry end to end: manifest, executable, handshake, one invoke.
 */
export async function verifyEntry(entry, root = ROOT, options = {}) {
  const errors = [];
  errors.push(...validateRegistryEntry(entry, root));
  if (errors.length > 0) {
    return { name: entry?.name ?? '<invalid>', ok: false, errors, capabilities: [] };
  }
  const pluginDir = path.resolve(root, entry.path);
  const { manifest, errors: manifestErrors } = readManifest(pluginDir);
  errors.push(...manifestErrors);
  if (!manifest) {
    return { name: entry.name, ok: false, errors, capabilities: [] };
  }
  errors.push(...validateManifest(manifest));
  if (manifest.name !== entry.name) {
    errors.push(`manifest name ${manifest.name} does not match registry name ${entry.name}`);
  }
  if (manifest.version !== entry.version) {
    errors.push(`manifest version ${manifest.version} does not match registry version ${entry.version}`);
  }
  const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (JSON.stringify(declared) !== JSON.stringify(entry.capabilities)) {
    errors.push('manifest capabilities do not match the registry entry');
  }
  if (errors.length > 0) {
    return { name: entry.name, ok: false, errors, capabilities: declared };
  }

  const override = options.overrides?.get(entry.name);
  let binary;
  if (override) {
    binary = path.resolve(root, override);
    const overrideErrors = checkExecutable(binary);
    errors.push(...overrideErrors);
  } else {
    const { file, errors: entryErrors } = resolveEntry(pluginDir, manifest.entry);
    errors.push(...entryErrors);
    binary = file;
    if (!entryErrors.length && !isExecutable(file)) {
      if (options.build !== false) {
        const build = buildPlugins(root);
        if (!build.ok) errors.push(`build failed: ${build.error}`);
      }
      if (!isExecutable(file)) {
        errors.push(`entry is not an executable file: ${manifest.entry}`);
      }
    }
  }
  if (errors.length > 0) {
    return { name: entry.name, ok: false, errors, capabilities: declared };
  }

  const hello = await handshake(binary, options);
  if (!hello.ok) {
    errors.push(`handshake failed: ${hello.error}`);
    return { name: entry.name, ok: false, errors, capabilities: declared };
  }
  if (hello.result.name !== manifest.name) {
    errors.push(`plugin reports name ${hello.result.name}, manifest says ${manifest.name}`);
  }
  if (hello.result.version !== manifest.version) {
    errors.push(`plugin reports version ${hello.result.version}, manifest says ${manifest.version}`);
  }
  const advertised = Array.isArray(hello.result.capabilities) ? hello.result.capabilities : [];
  for (const capability of advertised) {
    if (!declared.includes(capability)) {
      errors.push(`plugin advertises undeclared capability: ${capability}`);
    }
  }
  if (errors.length > 0) {
    return { name: entry.name, ok: false, errors, capabilities: declared };
  }

  const capability = declared[0];
  const invoked = await invokeCapability(binary, capability, verifyParams(capability), options);
  if (!invoked.ok) {
    errors.push(`invoke ${capability} failed: ${invoked.error}`);
  }
  return { name: entry.name, ok: errors.length === 0, errors, capabilities: declared };
}

export function isExecutable(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function checkExecutable(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return [`override is not a file: ${file}`];
    if ((stat.mode & 0o111) === 0) return [`override is not executable: ${file}`];
    return [];
  } catch (err) {
    return [`override is not usable: ${err.message}`];
  }
}
