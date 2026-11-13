// Explicit capability grants, mock-device declarations and crash-isolated dispatch.
// Node builtins only: no third-party dependency.
import path from 'node:path';
import {
  PROTOCOL,
  ROOT,
  Plugin,
  PluginCrashError,
  PluginProtocolError,
  PluginTimeoutError,
  buildPlugins,
  isExecutable,
  loadRegistry,
  readManifest,
  resolveEntry,
  resolveTimeout,
  validateManifest,
  validateRegistryEntry,
} from './host.mjs';

/** The six native capabilities. A grant is always one of these exact strings. */
export const CAPABILITY_CATALOG = Object.freeze({
  'camera.takePhoto': Object.freeze({ plugin: 'camera', permission: 'camera.takePhoto' }),
  'geolocation.getCurrentPosition': Object.freeze({
    plugin: 'geolocation',
    permission: 'geolocation.getCurrentPosition',
  }),
  'bluetooth.scan': Object.freeze({ plugin: 'bluetooth', permission: 'bluetooth.scan' }),
  'notification.show': Object.freeze({ plugin: 'notification', permission: 'notification.show' }),
  'payment.request': Object.freeze({ plugin: 'payment', permission: 'payment.request' }),
  'share.send': Object.freeze({ plugin: 'share', permission: 'share.send' }),
});

export const CAPABILITIES = Object.freeze(Object.keys(CAPABILITY_CATALOG));

export class CapabilityHostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapabilityHostError';
    this.code = 'ERR_CAPABILITY_HOST';
  }
}

export class CapabilityDeniedError extends CapabilityHostError {
  constructor(capability) {
    super(`capability ${capability} is not explicitly granted`);
    this.name = 'CapabilityDeniedError';
    this.code = 'ERR_CAPABILITY_DENIED';
    this.capability = capability;
    this.reason = 'not-granted';
  }
}

export class CapabilityUndeclaredError extends CapabilityHostError {
  constructor(capability, reason = 'not declared by the registry and manifest') {
    super(`unknown capability: ${capability} (${reason})`);
    this.name = 'CapabilityUndeclaredError';
    this.code = 'ERR_CAPABILITY_UNDECLARED';
    this.capability = capability;
    this.reason = reason;
  }
}

export class CircuitOpenError extends CapabilityHostError {
  constructor(plugin, retryAfterMs) {
    super(`plugin ${plugin} circuit is open; retry after ${retryAfterMs} ms`);
    this.name = 'CircuitOpenError';
    this.code = 'ERR_CIRCUIT_OPEN';
    this.plugin = plugin;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PluginResponseError extends CapabilityHostError {
  constructor(message, response) {
    super(message);
    this.name = 'PluginResponseError';
    this.code = 'ERR_PLUGIN_RESPONSE';
    this.response = response;
  }
}

class CircuitBreaker {
  constructor(threshold, cooldownMs, clock) {
    this.threshold = Math.max(1, Math.trunc(threshold));
    this.cooldownMs = Math.max(0, Math.trunc(cooldownMs));
    this.clock = clock;
    this.failures = 0;
    this.openedAt = null;
    this.trial = false;
  }

  get state() {
    if (this.openedAt !== null) return 'open';
    if (this.trial || this.failures > 0) return 'half-open';
    return 'closed';
  }

  check(plugin) {
    if (this.openedAt === null) return;
    const retryAfterMs = Math.max(0, this.cooldownMs - (this.clock() - this.openedAt));
    if (retryAfterMs > 0) throw new CircuitOpenError(plugin, retryAfterMs);
    // One half-open trial starts a fresh process; success closes, failure reopens.
    this.failures = 0;
    this.openedAt = null;
    this.trial = true;
  }

  success() {
    this.failures = 0;
    this.openedAt = null;
    this.trial = false;
  }

  failure() {
    if (this.trial) {
      this.trial = false;
      this.failures = this.threshold;
      this.openedAt = this.clock();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = this.clock();
      this.trial = false;
    }
  }
}

const builtRoots = new Set();

/** An application-level permission gate in front of real JSON-lines processes. */
export class CapabilityHost {
  constructor(options = {}) {
    const {
      grants = [],
      root = ROOT,
      threshold = 3,
      cooldownMs = 1000,
      clock = Date.now,
      timeoutMs = resolveTimeout(),
      overrides = new Map(),
      env = null,
    } = options;
    this.root = root;
    this.grants = new Set(grants);
    for (const grant of this.grants) {
      if (!Object.hasOwn(CAPABILITY_CATALOG, grant)) {
        throw new CapabilityUndeclaredError(grant, 'unknown grant');
      }
    }
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.clock = clock;
    this.timeoutMs = resolveTimeout(timeoutMs);
    this.overrides = overrides;
    this.env = env;
    this.breakers = new Map();
    this.active = new Set();
    this.spawnCount = 0;
    this.spawnedPids = new Set();
  }

  breakerFor(plugin) {
    if (!this.breakers.has(plugin)) {
      this.breakers.set(
        plugin,
        new CircuitBreaker(this.threshold, this.cooldownMs, this.clock),
      );
    }
    return this.breakers.get(plugin);
  }

  breakerState(plugin) {
    return this.breakerFor(plugin).state;
  }

  consecutiveFailures(plugin) {
    return this.breakerFor(plugin).failures;
  }

  circuitOpen(plugin) {
    return this.breakerFor(plugin).state === 'open';
  }

  /** Validates the registry and manifest before any executable is allowed to spawn. */
  resolve(capability) {
    const meta = CAPABILITY_CATALOG[capability];
    const { registry, errors } = loadRegistry(this.root);
    if (!registry || errors.length > 0) return null;
    const entry = registry.plugins.find((item) => item.name === meta.plugin);
    if (!entry || validateRegistryEntry(entry, this.root).length > 0) return null;
    if (!Array.isArray(entry.capabilities) || !entry.capabilities.includes(capability)) return null;
    const pluginDir = path.resolve(this.root, entry.path);
    const { manifest, errors: manifestErrors } = readManifest(pluginDir);
    if (!manifest || manifestErrors.length > 0 || validateManifest(manifest).length > 0) return null;
    if (manifest.name !== entry.name || manifest.version !== entry.version) return null;
    if (JSON.stringify(manifest.capabilities) !== JSON.stringify(entry.capabilities)) return null;
    const resolved = resolveEntry(pluginDir, manifest.entry);
    if (resolved.errors.length > 0 || !resolved.file) return null;
    const override = this.overrides.get(meta.plugin);
    const binary = override ? path.resolve(this.root, override) : resolved.file;
    if (!isExecutable(binary)) {
      if (!override && !builtRoots.has(this.root)) {
        const build = buildPlugins(this.root);
        if (!build.ok) throw new CapabilityHostError(`cannot build plugins: ${build.error}`);
        builtRoots.add(this.root);
      }
      if (!isExecutable(binary)) return null;
    }
    return {
      binary,
      pluginDir,
      name: entry.name,
      version: entry.version,
      declared: [...entry.capabilities],
    };
  }

  /** Denied and undeclared capabilities return before resolve/spawn; no process runs. */
  async invoke(capability, params = {}) {
    if (!Object.hasOwn(CAPABILITY_CATALOG, capability)) {
      throw new CapabilityUndeclaredError(capability, 'not in the capability catalog');
    }
    if (!this.grants.has(capability)) throw new CapabilityDeniedError(capability);
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new CapabilityHostError('params must be a JSON object');
    }
    const resolved = this.resolve(capability);
    if (!resolved) {
      throw new CapabilityUndeclaredError(capability, 'not declared by the registry and manifest');
    }
    const { plugin } = CAPABILITY_CATALOG[capability];
    const breaker = this.breakerFor(plugin);
    breaker.check(plugin);
    const spawnOptions = { cwd: resolved.pluginDir };
    if (this.env) spawnOptions.env = { ...process.env, ...this.env };
    const child = new Plugin(resolved.binary, this.timeoutMs, spawnOptions);
    this.active.add(child);
    this.spawnCount += 1;
    if (child.child.pid) this.spawnedPids.add(child.child.pid);
    try {
      const hello = await child.request({ id: 0, method: 'hello', protocol: PROTOCOL });
      if (!hello.ok) throw new PluginProtocolError(`hello failed: ${hello.error}`);
      const info = hello.result;
      if (!info || typeof info !== 'object' || info.name !== resolved.name || info.version !== resolved.version) {
        throw new PluginProtocolError('hello result does not match the manifest');
      }
      if (
        !Array.isArray(info.capabilities) ||
        !info.capabilities.includes(capability) ||
        info.capabilities.some((item) => !resolved.declared.includes(item))
      ) {
        throw new PluginProtocolError('hello capabilities do not match the declaration');
      }
      const response = await child.request({ id: 1, method: 'invoke', capability, params });
      if (!response.ok) throw new PluginResponseError(response.error, response);
      breaker.success();
      return response.result;
    } catch (err) {
      if (
        err instanceof PluginCrashError ||
        err instanceof PluginProtocolError ||
        err instanceof PluginTimeoutError
      ) {
        breaker.failure();
      }
      throw err;
    } finally {
      this.active.delete(child);
      await child.close();
    }
  }

  /** Waits for all active plugin processes to be reaped. */
  async close() {
    const children = [...this.active];
    await Promise.all(children.map((child) => child.close()));
  }
}
