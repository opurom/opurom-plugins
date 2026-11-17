// Shared plugin-host helpers for the Opurom reference plugins.
// Node builtins only: no third-party dependency.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL = '1.0';
export const DEFAULT_TIMEOUT_MS = 500;
export const MIN_TIMEOUT_MS = 50;
export const MAX_TIMEOUT_MS = 5000;

// The signature verifier has a single owner: opurom-pkg's signing library.
// A missing sibling checkout is only fatal when a provenance entry is used.
export const PKG_ROOT = path.resolve(ROOT, '..', 'opurom-pkg');
const SIGNING_FILE = path.join(PKG_ROOT, 'lib', 'signing.mjs');
let signingModule = null;
try {
  signingModule = await import(pathToFileURL(SIGNING_FILE).href);
} catch {
  signingModule = null;
}

/** Verify one signed install record with opurom-pkg's verifyBytes, never a local verifier. */
export function verifyInstallRecord(publicKey, relativePath, bytes, signature) {
  if (!signingModule?.verifyBytes) {
    throw new PluginConfigError(`signature verifier is unavailable: ${SIGNING_FILE}`);
  }
  return signingModule.verifyBytes(publicKey, relativePath, bytes, signature);
}

export function readPackagePublicKey(root = PKG_ROOT) {
  if (!signingModule?.readPublicKey) {
    throw new PluginConfigError(`signature verifier is unavailable: ${SIGNING_FILE}`);
  }
  return signingModule.readPublicKey(root);
}

// A plugin that is still alive this long after `shutdown` is force-killed.
export const SHUTDOWN_GRACE_MS = 500;

// hello takes id 0 and invoke id 1; shutdown is always the last request a host sends.
const SHUTDOWN_ID = 2;

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CAPABILITY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;
const PLATFORM_KEYS = ['android', 'ios', 'linux', 'macos', 'web', 'windows'];
// Stable interface identity replaces the runtime token: an id plus a version.
const INTERFACE_ID_PATTERN = /^[a-z][a-z0-9.-]{1,63}$/;
// Host platform the executable is selected for when a manifest uses platforms.
export const HOST_PLATFORM = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform] ?? null;

/**
 * Validate a stable interface declaration: a lowercase dotted id and a semver
 * version. This static contract replaces the runtime token identity check, so
 * shape is enforced here and cross-plugin consistency at load time.
 */
export function validateInterfaceDeclaration(declaration) {
  const errors = [];
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    return ['interface must be an object with id and version'];
  }
  for (const key of Object.keys(declaration)) {
    if (key !== 'id' && key !== 'version') {
      errors.push(`interface has unknown field: ${JSON.stringify(key)}`);
    }
  }
  if (typeof declaration.id !== 'string' || !INTERFACE_ID_PATTERN.test(declaration.id)) {
    errors.push(`interface id must be a dotted lowercase name: ${JSON.stringify(declaration.id)}`);
  }
  if (typeof declaration.version !== 'string' || !VERSION_PATTERN.test(declaration.version)) {
    errors.push(`interface version must be x.y.z: ${JSON.stringify(declaration.version)}`);
  }
  return errors;
}

/** An error for an inconsistent interface contract across a plugin set. */
export class PluginInterfaceError extends Error {
  constructor(message, code = 'ERR_PLUGIN_INTERFACE') {
    super(message);
    this.name = 'PluginInterfaceError';
    this.code = code;
  }
}

/**
 * Check interface contracts across a whole registry. A plugin whose
 * `implements` names another plugin must declare the same interface id and
 * version as that target; a target without a declaration or a mismatch aborts
 * with a distinct code. Pure: takes already-read manifests.
 *
 * @param {Map<string, object>} manifests plugin name -> manifest
 * @returns {{ok: boolean, errors: Array<{kind: string, message: string}>}}
 */
export function checkInterfaceContracts(manifests) {
  const errors = [];
  for (const [name, manifest] of manifests) {
    if (manifest.implements === undefined) continue;
    const target = manifests.get(manifest.implements);
    if (!target) {
      errors.push({ kind: 'missing', message: `plugin ${name} implements missing plugin ${manifest.implements}` });
      continue;
    }
    const own = manifest.interface;
    const theirs = target.interface;
    if (!theirs) {
      errors.push({ kind: 'undeclared', message: `plugin ${manifest.implements} has no interface declaration` });
      continue;
    }
    if (own.id !== theirs.id || own.version !== theirs.version) {
      errors.push({
        kind: 'mismatch',
        message: `plugin ${name} targets ${own.id}@${own.version}, ${manifest.implements} declares ${theirs.id}@${theirs.version}`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}
function checkPlatformEntry(entry) {
  const errors = [];
  if (typeof entry !== 'string' || entry.length === 0) {
    errors.push('entry must be a non-empty string');
  } else if (path.isAbsolute(entry) || entry.startsWith('/')) {
    errors.push(`entry must be relative: ${entry}`);
  } else if (entry.split(/[\\/]/).includes('..')) {
    errors.push(`entry must not traverse out of the plugin directory: ${entry}`);
  }
  return errors;
}

/**
 * Validate an optional `platforms` table. Each key is one of the six platforms;
 * each value declares an inline `entry` or delegates through `default_package`,
 * never both. Fail-closed: an empty table, an unknown platform or an entry with
 * neither is an error.
 */
function validatePlatforms(platforms) {
  const errors = [];
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    return ['platforms must be an object mapping platform names to declarations'];
  }
  const keys = Object.keys(platforms);
  if (keys.length === 0) {
    return ['platforms must declare at least one platform'];
  }
  for (const key of keys) {
    if (!PLATFORM_KEYS.includes(key)) {
      errors.push(`unknown platform: ${JSON.stringify(key)}`);
      continue;
    }
    const declaration = platforms[key];
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
      errors.push(`platform ${key} must be an object`);
      continue;
    }
    const hasEntry = declaration.entry !== undefined;
    const hasDefault = declaration.default_package !== undefined;
    if (!hasEntry && !hasDefault) {
      errors.push(`platform ${key} needs entry or default_package`);
      continue;
    }
    if (hasEntry && hasDefault) {
      errors.push(`platform ${key} cannot provide an entry and a default_package`);
      continue;
    }
    if (hasEntry) errors.push(...checkPlatformEntry(declaration.entry));
    if (hasDefault && (typeof declaration.default_package !== 'string' || !NAME_PATTERN.test(declaration.default_package))) {
      errors.push(`platform ${key} default_package must be a plugin name`);
    }
  }
  return errors;
}

/**
 * Verify a registry entry's optional provenance against its signed install
 * record. The record lives at `<pluginDir>/opurom-install.json` with a detached
 * `.sig` sibling; the signed relative path is `<name>@<version>/opurom-install.json`.
 */
export function checkProvenanceRecord(entry, root, options = {}) {
  if (!entry?.provenance) return;
  const pluginDir = path.resolve(root, entry.path);
  const recordPath = path.join(pluginDir, 'opurom-install.json');
  let bytes;
  let signature;
  try {
    bytes = readFileSync(recordPath);
    signature = readFileSync(`${recordPath}.sig`);
  } catch (err) {
    throw new PluginConfigError(`cannot read the install record for ${entry.name}: ${err.message}`);
  }
  const relativePath = `${entry.name}@${entry.version}/opurom-install.json`;
  const publicKey = options.publicKey ?? readPackagePublicKey(options.pkgRoot);
  let verified;
  try {
    verified = verifyInstallRecord(publicKey, relativePath, bytes, signature);
  } catch (err) {
    throw new PluginConfigError(`install record verification failed for ${entry.name}: ${err.message}`);
  }
  if (!verified) {
    throw new PluginConfigError(`install record signature mismatch for ${entry.name}`);
  }
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new PluginConfigError(`invalid install record for ${entry.name}: ${err.message}`);
  }
  if (record?.source !== entry.provenance.source || record?.digest !== entry.provenance.digest) {
    throw new PluginConfigError(`provenance mismatch for ${entry.name}`);
  }
}

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
  errors.push(...validateProvenance(entry.provenance));
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
  if (manifest.entry !== undefined) {
    if (typeof manifest.entry !== 'string' || manifest.entry.length === 0) {
      errors.push('entry must be a non-empty string');
    }
  }
  // Old (single top-level entry) and new (platforms table) layouts are
  // mutually exclusive; declaring both or neither is rejected, never merged.
  const hasLegacyEntry = manifest.entry !== undefined;
  const hasPlatforms = manifest.platforms !== undefined;
  if (hasLegacyEntry && hasPlatforms) {
    errors.push('entry and platforms cannot be combined in one manifest');
  } else if (!hasLegacyEntry && !hasPlatforms) {
    errors.push('manifest needs entry or platforms');
  }
  if (hasPlatforms) errors.push(...validatePlatforms(manifest.platforms));
  if (manifest.implements !== undefined) {
    if (typeof manifest.implements !== 'string' || !NAME_PATTERN.test(manifest.implements)) {
      errors.push('implements must be a plugin name');
    } else if (manifest.implements === manifest.name) {
      errors.push('a plugin cannot implement itself');
    } else if (manifest.implements.length > 200) {
      errors.push('implements exceeds 200 characters');
    }
  }
  if (manifest.default_package !== undefined) {
    if (typeof manifest.default_package !== 'string' || !NAME_PATTERN.test(manifest.default_package)) {
      errors.push('default_package must be a plugin name');
    } else if (manifest.default_package === manifest.name) {
      errors.push('a plugin cannot be its own default_package');
    }
  }
  if (manifest.interface !== undefined) {
    errors.push(...validateInterfaceDeclaration(manifest.interface));
  }
  // A plugin that implements another package must state the stable interface
  // contract it targets; a missing declaration is rejected, never inferred.
  if (manifest.implements !== undefined && manifest.interface === undefined) {
    errors.push('implements requires an interface declaration');
  }
  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) {
      errors.push('dependencies must be an array of plugin names');
    } else {
      const seen = new Set();
      for (const dependency of manifest.dependencies) {
        if (typeof dependency !== 'string' || !NAME_PATTERN.test(dependency)) {
          errors.push(`invalid dependency: ${JSON.stringify(dependency)}`);
        } else if (seen.has(dependency)) {
          errors.push(`duplicate dependency: ${dependency}`);
        } else {
          seen.add(dependency);
        }
      }
      if (manifest.name && seen.has(manifest.name)) {
        errors.push('a plugin cannot depend on itself');
      }
    }
  }
  if (typeof manifest.description !== 'string' || manifest.description.length === 0) {
    errors.push('description must be a non-empty string');
  }
  for (const [field, limit] of [
    ['author', 200],
    ['repository', 300],
    ['license', 200],
  ]) {
    if (manifest[field] !== undefined) {
      if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
        errors.push(`${field} must be a non-empty string`);
      } else if (manifest[field].length > limit) {
        errors.push(`${field} exceeds ${limit} characters`);
      }
    }
  }
  return errors;
}

/** Optional provenance on a registry entry: source/repo and a sha256 digest. */
export function validateProvenance(provenance) {
  if (provenance === undefined) return [];
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return ['provenance must be a JSON object'];
  }
  const errors = [];
  if (typeof provenance.source !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(provenance.source)) {
    errors.push('provenance.source must be an owner/repo string');
  }
  if (typeof provenance.digest !== 'string' || !/^[0-9a-f]{64}$/.test(provenance.digest)) {
    errors.push('provenance.digest must be a sha256 hex string');
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

/**
 * Resolve the executable for a manifest: the top-level `entry` for the legacy
 * layout, or the host platform's declaration from `platforms`. A platform that
 * only delegates through `default_package` has no local executable.
 */
export function resolveManifestEntry(pluginDir, manifest) {
  if (manifest.entry !== undefined) return resolveEntry(pluginDir, manifest.entry);
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    return { file: null, errors: ['manifest has no entry and no platforms'] };
  }
  if (!HOST_PLATFORM) {
    return { file: null, errors: ['host platform has no plugin executable convention'] };
  }
  const declaration = platforms[HOST_PLATFORM];
  if (!declaration) {
    return { file: null, errors: [`manifest has no implementation for host platform ${HOST_PLATFORM}`] };
  }
  if (declaration.default_package !== undefined) {
    return {
      file: null,
      errors: [`platform ${HOST_PLATFORM} delegates to default_package ${declaration.default_package}`],
    };
  }
  return resolveEntry(pluginDir, declaration.entry);
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

  /**
   * Send `shutdown`, close stdin and wait for the plugin to leave; a plugin
   * still alive after SHUTDOWN_GRACE_MS is force-killed. No reply wait: the
   * exit (or the grace kill) is the confirmation.
   */
  async close() {
    if (!this.failure) {
      try {
        this.child.stdin.write(`${JSON.stringify({ id: SHUTDOWN_ID, method: 'shutdown' })}\n`);
      } catch {
        /* already gone */
      }
    }
    try {
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    const forceKill = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, SHUTDOWN_GRACE_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(forceKill);
    }
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
 * Spec dependency graph: every declared dependency must exist in the registry,
 * cycles and duplicates are rejected, and the returned order puts dependencies
 * before their consumers. Each error carries a machine-readable `kind`
 * (`missing`, `cycle` or `duplicate`) plus its diagnostic message. Entries are
 * augmented with their `dependencies` arrays from the plugin manifests.
 */
export function resolveLoadOrder(registry) {
  const errors = [];
  const fail = (kind, message) => errors.push({ kind, message });
  const byName = new Map();
  for (const entry of registry.plugins) byName.set(entry.name, entry);
  const depsOf = (name) => {
    const entry = byName.get(name);
    return Array.isArray(entry?.dependencies) ? entry.dependencies : [];
  };
  const order = [];
  const state = new Map();
  const visit = (name, chain) => {
    const status = state.get(name);
    if (status === 'done') return;
    if (status === 'visiting') {
      const start = chain.indexOf(name);
      fail('cycle', `dependency cycle: ${chain.slice(start).concat(name).join(' -> ')}`);
      return;
    }
    state.set(name, 'visiting');
    const seen = new Set();
    for (const dependency of depsOf(name)) {
      if (seen.has(dependency)) {
        fail('duplicate', `duplicate dependency: ${dependency} in plugin ${name}`);
      }
      seen.add(dependency);
      if (!byName.has(dependency)) {
        fail('missing', `plugin ${name} depends on missing plugin ${dependency}`);
        continue;
      }
      visit(dependency, [...chain, name]);
    }
    state.set(name, 'done');
    order.push(name);
  };
  for (const entry of registry.plugins) visit(entry.name, []);
  return { order, errors };
}

/**
 * Check one registry entry end to end: manifest, executable, handshake, one invoke.
 * The probe runs with empty params; every mock device answers `{}` deterministically.
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
    const { file, errors: entryErrors } = resolveManifestEntry(pluginDir, manifest);
    errors.push(...entryErrors);
    binary = file;
    if (!entryErrors.length && !isExecutable(file)) {
      if (options.build !== false) {
        const build = buildPlugins(root);
        if (!build.ok) errors.push(`build failed: ${build.error}`);
      }
      if (!isExecutable(file)) {
        errors.push(`entry is not an executable file: ${manifest.entry ?? HOST_PLATFORM}`);
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
  const invoked = await invokeCapability(binary, capability, {}, options);
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
