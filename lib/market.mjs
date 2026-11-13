// Plugin market client over an opurom-pkg registry layout.
//
// The layout is the one opurom-pkg serves: registry/<name>/<version>/ holds the
// package files and an opurom-pkg.json manifest ({ name, version, files }). This
// client lists and resolves that layout deterministically (byte-sorted, no clock,
// no network) and keeps every install behind the permission host: a package that
// declares a native capability is only installed when the host grants it.
//
// Node builtins only: no third-party dependency.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, resolveTimeout } from './host.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// Sibling checkout of opurom-pkg; a local, offline registry, not a remote market.
export const MARKET_ROOT = path.resolve(ROOT, '..', 'opurom-pkg', 'registry');

export class MarketError extends Error {
  constructor(message, code = 'ERR_MARKET') {
    super(message);
    this.name = 'MarketError';
    this.code = code;
  }
}

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new MarketError(`invalid package name: ${JSON.stringify(name)}`, 'ERR_MARKET_NAME');
  }
}

function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new MarketError(`invalid package version: ${JSON.stringify(version)}`, 'ERR_MARKET_VERSION');
  }
}

/** Byte-sorted directory entries; a non-directory entry is an error, not skipped silently. */
function sortedDir(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((left, right) => compareBytes(left.name, right.name));
  return entries;
}

function readManifest(packageDir) {
  const file = path.join(packageDir, 'opurom-pkg.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new MarketError(`cannot read package manifest ${file}: ${err.message}`, 'ERR_MARKET_MANIFEST');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MarketError(`package manifest is not a JSON object: ${file}`, 'ERR_MARKET_MANIFEST');
  }
  if (!Array.isArray(parsed.files) || parsed.files.some((name) => typeof name !== 'string')) {
    throw new MarketError(`package manifest files must be a string array: ${file}`, 'ERR_MARKET_MANIFEST');
  }
  return parsed;
}

/**
 * Deterministic listing of every package the registry layout holds.
 * The order is byte-sorted by name then version; repeat runs are identical.
 */
export function listMarket(options = {}) {
  const registryRoot = path.resolve(options.registryRoot ?? MARKET_ROOT);
  const packages = [];
  let names;
  try {
    names = sortedDir(registryRoot);
  } catch (err) {
    throw new MarketError(`cannot read market registry ${registryRoot}: ${err.message}`, 'ERR_MARKET_ROOT');
  }
  for (const nameEntry of names) {
    if (!nameEntry.isDirectory()) continue;
    assertName(nameEntry.name);
    const versionEntries = sortedDir(path.join(registryRoot, nameEntry.name));
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory()) continue;
      assertVersion(versionEntry.name);
      const packageDir = path.join(registryRoot, nameEntry.name, versionEntry.name);
      const manifest = readManifest(packageDir);
      if (manifest.name !== nameEntry.name || manifest.version !== versionEntry.name) {
        throw new MarketError(
          `package manifest name/version mismatch in ${packageDir}`,
          'ERR_MARKET_MANIFEST',
        );
      }
      packages.push({
        name: nameEntry.name,
        version: versionEntry.name,
        files: [...manifest.files].sort(compareBytes),
        capability: typeof manifest.capability === 'string' ? manifest.capability : null,
      });
    }
  }
  return packages;
}

/** Deterministic substring search over the listing, sorted by name then version. */
export function searchMarket(query, options = {}) {
  const needle = String(query ?? '').toLowerCase();
  return listMarket(options).filter((entry) => entry.name.toLowerCase().includes(needle));
}

/**
 * Resolve one package to its files with sha256 digests, reading the registry
 * layout directly. The work is bounded: a package with more files than the
 * timeout allows is refused instead of looping unbounded. A `deny` list of
 * package names (or `name@version`) is honoured before any file is read.
 */
export function resolveMarketPackage(name, version, options = {}) {
  assertName(name);
  assertVersion(version);
  const deny = new Set(options.deny ?? []);
  if (deny.has(name) || deny.has(`${name}@${version}`)) {
    throw new MarketError(`package ${name}@${version} is denied`, 'ERR_MARKET_DENIED');
  }
  const registryRoot = path.resolve(options.registryRoot ?? MARKET_ROOT);
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const packageDir = path.join(registryRoot, name, version);
  const manifest = readManifest(packageDir);
  if (manifest.name !== name || manifest.version !== version) {
    throw new MarketError(
      `package manifest name/version mismatch in ${packageDir}`,
      'ERR_MARKET_MANIFEST',
    );
  }
  const started = Date.now();
  const files = [];
  for (const relative of [...manifest.files].sort(compareBytes)) {
    if (relative.includes('..') || path.isAbsolute(relative)) {
      throw new MarketError(`unsafe package file path: ${relative}`, 'ERR_MARKET_PATH');
    }
    const absolute = path.join(packageDir, relative);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      throw new MarketError(`package file is missing: ${relative}`, 'ERR_MARKET_MISSING');
    }
    if (!stat.isFile()) {
      throw new MarketError(`package file is not a regular file: ${relative}`, 'ERR_MARKET_PATH');
    }
    files.push({ path: relative, sha256: sha256(readFileSync(absolute)) });
    if (Date.now() - started > timeoutMs) {
      throw new MarketError(`resolving ${name}@${version} exceeded ${timeoutMs} ms`, 'ERR_MARKET_TIMEOUT');
    }
  }
  const capability = typeof manifest.capability === 'string' ? manifest.capability : null;
  return { name, version, files, capability };
}

/**
 * Resolve an install plan for one package. When the package declares a native
 * capability, the permission host decides: an ungranted or explicitly denied
 * capability is refused before the plan is returned, so the market can never
 * install around the host's allow/deny manifest.
 */
export function planInstall(name, version, host, options = {}) {
  const resolved = resolveMarketPackage(name, version, options);
  const capability = resolved.capability ?? null;
  if (capability !== null) {
    if (!host || typeof host.check !== 'function') {
      throw new MarketError(
        `package ${name}@${version} provides ${capability} and needs a permission host`,
        'ERR_MARKET_PERMISSION',
      );
    }
    const decision = host.check(capability);
    if (!decision.allowed) {
      throw new MarketError(
        `package ${name}@${version} provides ${capability}, denied by the host (${decision.reason})`,
        'ERR_MARKET_DENIED',
      );
    }
  }
  return { ...resolved, capability };
}
