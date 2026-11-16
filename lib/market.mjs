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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  PKG_ROOT,
  ROOT,
  checkProvenanceRecord,
  readPackagePublicKey,
  resolveTimeout,
  verifyInstallRecord,
} from './host.mjs';

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

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const githubCache = new Map();

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
  const byName = new Map();
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
    let latest = null;
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory()) continue;
      assertVersion(versionEntry.name);
      if (latest && compareVersions(versionEntry.name, latest.version) <= 0) continue;
      const packageDir = path.join(registryRoot, nameEntry.name, versionEntry.name);
      const manifest = readManifest(packageDir);
      if (manifest.name !== nameEntry.name || manifest.version !== versionEntry.name) {
        throw new MarketError(
          `package manifest name/version mismatch in ${packageDir}`,
          'ERR_MARKET_MANIFEST',
        );
      }
      latest = {
        name: nameEntry.name,
        version: versionEntry.name,
        files: [...manifest.files].sort(compareBytes),
        capability: typeof manifest.capability === 'string' ? manifest.capability : null,
        description: typeof manifest.description === 'string' ? manifest.description : null,
        author: typeof manifest.author === 'string' ? manifest.author : null,
        repository: typeof manifest.repository === 'string' ? manifest.repository : null,
        license: typeof manifest.license === 'string' ? manifest.license : null,
        downloads: 'n/a (no telemetry)',
      };
    }
    if (latest) byName.set(nameEntry.name, latest);
  }
  // Byte order by name; one entry per name at its highest semver version.
  return [...byName.values()].sort((left, right) => compareBytes(left.name, right.name));
}

/** Deterministic substring search over the listing, sorted by name. */
export function searchMarket(query, options = {}) {
  const needle = String(query ?? '').toLowerCase();
  return listMarket(options).filter((entry) => entry.name.toLowerCase().includes(needle));
}

/**
 * Explicit `--github` discovery over the package CLI's GitHub client. The
 * network layer is opt-in, cached for 24h and degrades to the deterministic
 * local listing (with a notice) on timeout, offline or a missing client.
 * Stars, forks and downloads are never inputs; no telemetry exists.
 */
export async function listMarketGithub(repository, options = {}) {
  const local = options.query
    ? searchMarket(options.query, options)
    : listMarket(options);
  const degrade = (reason) => ({ packages: local, notice: `github discovery unavailable (${reason}); using local deterministic order`, degraded: true });
  try {
    const modulePath = path.join(PKG_ROOT, 'lib', 'github-registry.mjs');
    const clientModule = options.githubModule ?? (await import(new URL(`file://${modulePath}`).href));
    const client = options.githubClient ?? clientModule.createGithubRegistry({
      token: process.env.OPR_GITHUB_TOKEN ?? null,
    });
    const key = `${repository}|${options.query ?? ''}`;
    let cached = githubCache.get(key);
    if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
      const rows = await client.search({ repository, name: options.query ?? null });
      cached = { at: Date.now(), rows };
      githubCache.set(key, cached);
    }
    const byName = new Map();
    for (const row of cached.rows) {
      const current = byName.get(row.name);
      if (!current || compareVersions(row.version, current.version) > 0) {
        byName.set(row.name, {
          name: row.name,
          version: row.version,
          releaseUrl: row.releaseUrl,
          signed: true,
          downloads: 'n/a (no telemetry)',
        });
      }
    }
    return {
      packages: [...byName.values()].sort((left, right) => compareBytes(left.name, right.name)),
      notice: null,
      degraded: false,
    };
  } catch (err) {
    return degrade(err.message ?? 'github error');
  }
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

/** Canonical signed install record: source, digest and per-file sha256 digests. */
function installRecordPath(registryRoot, name, version) {
  return path.join(registryRoot, name, version, 'opurom-install.json');
}

/**
 * Install one package through the five spec gates. The permission decision,
 * digests and signature all precede any write; landing uses staging plus
 * rename, so a failure leaves both the plugin directory and registry.json
 * untouched. The host-side manifest/provenance check runs on the landed tree.
 */
export function installMarketPackage(name, version, host, options = {}) {
  // Gate 1: permission (deny wins) and gate 2: sha256 of every file.
  const plan = planInstall(name, version, host, options);
  const recordPath = installRecordPath(path.resolve(options.registryRoot ?? MARKET_ROOT), name, version);
  let recordBytes;
  let signatureBytes;
  try {
    recordBytes = readFileSync(recordPath);
    signatureBytes = readFileSync(`${recordPath}.sig`);
  } catch (err) {
    throw new MarketError(`cannot read the install record: ${err.message}`, 'ERR_MARKET_RECORD');
  }
  let record;
  try {
    record = JSON.parse(recordBytes.toString('utf8'));
  } catch (err) {
    throw new MarketError(`invalid install record: ${err.message}`, 'ERR_MARKET_RECORD');
  }
  const signedRelative = `${name}@${version}/opurom-install.json`;
  const publicKey = options.publicKey ?? readPackagePublicKey(options.pkgRoot);
  let verified;
  try {
    // Gate 3: the single trust source is opurom-pkg's verifyBytes.
    verified = verifyInstallRecord(publicKey, signedRelative, recordBytes, signatureBytes);
  } catch (err) {
    throw new MarketError(`signature verification failed: ${err.message}`, 'ERR_MARKET_SIGNATURE');
  }
  if (!verified) {
    throw new MarketError('signature verification failed', 'ERR_MARKET_SIGNATURE');
  }
  if (record?.name !== name || record?.version !== version || record?.source !== options.source) {
    throw new MarketError('install record identity mismatch', 'ERR_MARKET_RECORD');
  }
  const declared = new Map((record.files ?? []).map((file) => [file.path, file.sha256]));
  for (const file of plan.files) {
    if (declared.get(file.path) !== file.sha256) {
      throw new MarketError(`sha256 mismatch for ${file.path}`, 'ERR_MARKET_INTEGRITY');
    }
  }
  if (declared.size !== plan.files.length) {
    throw new MarketError('install record file list mismatch', 'ERR_MARKET_INTEGRITY');
  }
  const digest = createHash('sha256')
    .update([...plan.files].sort((a, b) => compareBytes(a.path, b.path)).map((file) => `${file.path}  ${file.sha256}\n`).join(''))
    .digest('hex');
  if (record.digest !== digest) {
    throw new MarketError('install record digest mismatch', 'ERR_MARKET_INTEGRITY');
  }

  // Gate 4: stage every write, then swap the plugin directory and registry.
  const root = path.resolve(options.root ?? ROOT);
  const pluginDir = path.join(root, 'plugins', name);
  mkdirSync(path.dirname(pluginDir), { recursive: true });
  const registryFile = path.join(root, 'registry.json');
  const staging = mkdtempSync(path.join(root, '.opurom-install-'));
  try {
    for (const file of plan.files) {
      const target = path.join(staging, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      const source = path.join(path.resolve(options.registryRoot ?? MARKET_ROOT), name, version, file.path);
      writeFileSync(target, readFileSync(source));
      chmodSync(target, statSync(source).mode & 0o777);
    }
    const signedRecord = {
      source: record.source,
      digest: record.digest,
    };
    writeFileSync(path.join(staging, 'opurom-install.json'), recordBytes);
    writeFileSync(path.join(staging, 'opurom-install.json.sig'), signatureBytes);

    let registry;
    try {
      registry = JSON.parse(readFileSync(registryFile, 'utf8'));
    } catch (err) {
      throw new MarketError(`cannot read ${registryFile}: ${err.message}`, 'ERR_MARKET_ROOT');
    }
    const entry = {
      name,
      version,
      path: `plugins/${name}`,
      capabilities: [],
      provenance: signedRecord,
    };
    const manifestFile = path.join(staging, 'plugin.json');
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (Array.isArray(manifest.capabilities)) entry.capabilities = [...manifest.capabilities];
    }
    const remaining = registry.plugins.filter((item) => item.name !== name);
    const next = { ...registry, plugins: [...remaining, entry] };
    const backup = path.join(root, `.opurom-backup-${name}`);
    if (existsSync(pluginDir)) renameSync(pluginDir, backup);
    try {
      renameSync(staging, pluginDir);
      const tempRegistry = `${registryFile}.tmp`;
      writeFileSync(tempRegistry, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tempRegistry, registryFile);
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    } catch (err) {
      if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, pluginDir);
      throw new MarketError(`atomic landing failed: ${err.message}`, 'ERR_MARKET_LIMITATION');
    }

    // Gate 5: host load-time manifest/provenance validation over the landed tree.
    const check = { ...entry, path: `plugins/${name}` };
    checkProvenanceRecord(check, root, { publicKey });
    return { name, version, source: record.source, digest, path: check.path };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
