import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  MarketError,
  installMarketPackage,
  listMarket,
  listMarketGithub,
  planInstall,
  resolveMarketPackage,
  searchMarket,
} from '../lib/market.mjs';
import { CapabilityHost } from '../lib/capabilities.mjs';
import { ROOT } from '../lib/host.mjs';
import { runCli } from '../test-support/helpers.mjs';

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A registry layout fixture: registry/<name>/<version>/{opurom-pkg.json, files}. */
function withMarket(build, fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-market-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  let result;
  try {
    build(root);
    result = fn(root);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

function addPackage(root, name, version, files, extra = {}) {
  const dir = path.join(root, name, version);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(dir, file), `${name}@${version}:${file}\n`);
  }
  writeJson(path.join(dir, 'opurom-pkg.json'), {
    name,
    version,
    files,
    ...extra,
  });
}

// A self-contained registry fixture keeps these checks independent of the
// sibling opurom-pkg checkout, which CI does not clone.
function withTwoPackages(fn) {
  return withMarket(
    (root) => {
      addPackage(root, 'opurom-ui', '0.1.0', ['button.opu', 'card.opu', 'opurom-pkg.json']);
      addPackage(root, 'opurom-data', '0.1.0', ['query.opu', 'record.opu', 'opurom-pkg.json']);
    },
    fn,
  );
}

test('listing a registry is deterministic and sorted', () => withTwoPackages((root) => {
  const first = listMarket({ registryRoot: root });
  const second = listMarket({ registryRoot: root });
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  const names = first.map((entry) => `${entry.name}@${entry.version}`);
  assert.deepEqual(names, [...names].sort());
  for (const entry of first) {
    assert.deepEqual(entry.files, [...entry.files].sort());
  }
}));

test('search filters the listing by name substring', () => withTwoPackages((root) => {
  const hits = searchMarket('ui', { registryRoot: root });
  assert.equal(hits.length, 1);
  assert.ok(hits.every((entry) => entry.name.includes('ui')));
  assert.deepEqual(searchMarket('zzz-no-such-package', { registryRoot: root }), []);
}));

test('resolve returns the files with sha256 digests in sorted order', () => withTwoPackages((root) => {
  const resolved = resolveMarketPackage('opurom-ui', '0.1.0', { registryRoot: root });
  assert.equal(resolved.name, 'opurom-ui');
  assert.equal(resolved.version, '0.1.0');
  const paths = resolved.files.map((file) => file.path);
  assert.deepEqual(paths, [...paths].sort());
  for (const file of resolved.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
}));

test('a denied package is refused before any file is read', () => {
  withMarket(
    (root) => addPackage(root, 'blocked', '0.1.0', ['a.opu', 'opurom-pkg.json']),
    (root) => {
      assert.throws(
        () => resolveMarketPackage('blocked', '0.1.0', { registryRoot: root, deny: ['blocked'] }),
        (err) => err instanceof MarketError && err.code === 'ERR_MARKET_DENIED',
      );
      assert.throws(
        () => resolveMarketPackage('blocked', '0.1.0', { registryRoot: root, deny: ['blocked@0.1.0'] }),
        (err) => err instanceof MarketError && err.code === 'ERR_MARKET_DENIED',
      );
    },
  );
});

test('invalid names and versions are rejected', () => {
  assert.throws(
    () => resolveMarketPackage('Bad Name', '0.1.0', { registryRoot: '/' }),
    (err) => err instanceof MarketError && err.code === 'ERR_MARKET_NAME',
  );
  assert.throws(
    () => resolveMarketPackage('opurom-ui', 'latest', { registryRoot: '/' }),
    (err) => err instanceof MarketError && err.code === 'ERR_MARKET_VERSION',
  );
});

test('a missing package directory is a typed manifest error', () => {
  assert.throws(
    () => resolveMarketPackage('ghost', '0.1.0', { registryRoot: '/' }),
    (err) => err instanceof MarketError && err.code === 'ERR_MARKET_MANIFEST',
  );
});

test('a file listed in the manifest but absent on disk is a typed error', () => {
  withMarket(
    (root) => {
      const dir = path.join(root, 'partial', '0.1.0');
      mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, 'opurom-pkg.json'), {
        name: 'partial',
        version: '0.1.0',
        files: ['present.opu', 'absent.opu'],
      });
      writeFileSync(path.join(dir, 'present.opu'), 'present\n');
    },
    (root) => {
      assert.throws(
        () => resolveMarketPackage('partial', '0.1.0', { registryRoot: root }),
        (err) => err instanceof MarketError && err.code === 'ERR_MARKET_MISSING',
      );
    },
  );
});

test('plan install never bypasses the permission host', () => {
  withMarket(
    (root) => addPackage(root, 'geo-market', '0.1.0', ['geo.opu', 'opurom-pkg.json'], {
      capability: 'geolocation.getCurrentPosition',
    }),
    async (root) => {
      // Denied by default: the capability is not granted, so no plan is produced.
      const deniedHost = new CapabilityHost({ permissions: { allow: [], deny: [] }, root: ROOT });
      try {
        assert.throws(
          () => planInstall('geo-market', '0.1.0', deniedHost, { registryRoot: root }),
          (err) => err instanceof MarketError && err.code === 'ERR_MARKET_DENIED',
        );
      } finally {
        await deniedHost.close();
      }

      // Explicit deny wins even when it is also granted.
      const denyHost = new CapabilityHost({
        permissions: { allow: ['geolocation.getCurrentPosition'], deny: ['geolocation.getCurrentPosition'] },
        root: ROOT,
      });
      try {
        assert.throws(
          () => planInstall('geo-market', '0.1.0', denyHost, { registryRoot: root }),
          (err) => err instanceof MarketError && err.code === 'ERR_MARKET_DENIED',
        );
      } finally {
        await denyHost.close();
      }

      // Granted: the plan is produced and carries the capability.
      const allowHost = new CapabilityHost({
        permissions: { allow: ['geolocation.getCurrentPosition'], deny: [] },
        root: ROOT,
      });
      try {
        const plan = planInstall('geo-market', '0.1.0', allowHost, { registryRoot: root });
        assert.equal(plan.capability, 'geolocation.getCurrentPosition');
        assert.ok(plan.files.length > 0);
      } finally {
        await allowHost.close();
      }
    },
  );
});

test('a package without a capability needs no permission host', () => {
  withMarket(
    (root) => addPackage(root, 'plain-data', '0.1.0', ['data.opu', 'opurom-pkg.json']),
    (root) => {
      const plan = planInstall('plain-data', '0.1.0', null, { registryRoot: root });
      assert.equal(plan.capability, null);
      assert.ok(plan.files.length > 0);
    },
  );
});

test('a capability-bearing package without a host is refused', () => {
  withMarket(
    (root) => addPackage(root, 'cap-market', '0.1.0', ['cap.opu', 'opurom-pkg.json'], {
      capability: 'camera.takePhoto',
    }),
    (root) => {
      assert.throws(
        () => planInstall('cap-market', '0.1.0', null, { registryRoot: root }),
        (err) => err instanceof MarketError && err.code === 'ERR_MARKET_PERMISSION',
      );
    },
  );
});

test('the CLI market subcommands list, resolve and gate a plan', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-market-cli-'));
  try {
    addPackage(root, 'opurom-ui', '0.1.0', ['button.opu', 'card.opu', 'opurom-pkg.json']);
    const env = { OPR_MARKET_ROOT: root };
    const listed = await runCli(['market', 'list'], { env });
    assert.equal(listed.code, 0, listed.stderr);
    const packages = JSON.parse(listed.stdout);
    assert.ok(packages.some((entry) => entry.name === 'opurom-ui'));

    const resolved = await runCli(['market', 'resolve', 'opurom-ui', '0.1.0'], { env });
    assert.equal(resolved.code, 0, resolved.stderr);
    const plan = JSON.parse(resolved.stdout);
    assert.ok(plan.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));

    const denied = await runCli(
      ['market', 'resolve', 'opurom-ui', '0.1.0', '--deny', 'opurom-ui'], { env },
    );
    assert.equal(denied.code, 1);
    assert.equal(JSON.parse(denied.stdout).error.code, 'ERR_MARKET_DENIED');

    const planned = await runCli(['market', 'plan', 'opurom-ui', '0.1.0'], { env });
    assert.equal(planned.code, 0, planned.stderr);
    assert.equal(JSON.parse(planned.stdout).name, 'opurom-ui');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI market root honours OPR_MARKET_ROOT', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-market-env-'));
  try {
    addPackage(root, 'opurom-only', '0.1.0', ['x.opu', 'opurom-pkg.json']);
    const listed = await runCli(['market', 'list'], { env: { OPR_MARKET_ROOT: root } });
    assert.equal(listed.code, 0, listed.stderr);
    const packages = JSON.parse(listed.stdout);
    assert.deepEqual(packages.map((entry) => entry.name), ['opurom-only']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listing keeps one entry per name at the highest semver version', () => withMarket(
  (root) => {
    addPackage(root, 'multi', '0.1.0', ['a.opu', 'opurom-pkg.json']);
    addPackage(root, 'multi', '0.2.0', ['b.opu', 'opurom-pkg.json'], {
      description: 'newest',
      author: 'Alice',
      repository: 'opurom/multi',
      license: 'MIT',
    });
    addPackage(root, 'multi', '0.10.0', ['c.opu', 'opurom-pkg.json']);
  },
  (root) => {
    const rows = listMarket({ registryRoot: root });
    assert.deepEqual(rows.map((row) => `${row.name}@${row.version}`), ['multi@0.10.0']);
    assert.equal(rows[0].author, null);
    const search = searchMarket('multi', { registryRoot: root });
    assert.equal(search.length, 1);
    assert.equal(search[0].downloads, 'n/a (no telemetry)');
  },
));

test('github discovery is opt-in and degrades to local order offline', () => withMarket(
  (root) => addPackage(root, 'opurom-ui', '0.1.0', ['button.opu', 'opurom-pkg.json']),
  async (root) => {
    const options = { registryRoot: root };
    const result = await listMarketGithub('opurom/missing', {
      ...options,
      githubModule: { createGithubRegistry: () => ({ search: async () => { throw new Error('offline'); } }) },
    });
    assert.equal(result.degraded, true);
    assert.match(result.notice, /using local deterministic order/);
    assert.deepEqual(result.packages.map((row) => row.name), ['opurom-ui']);

    const online = await listMarketGithub('opurom/plugins', {
      ...options,
      githubClient: {
        search: async () => [
          { name: 'opurom-ui', version: '0.2.0', releaseUrl: 'https://example.invalid/r', signed: true },
        ],
      },
    });
    assert.equal(online.degraded, false);
    assert.equal(online.packages[0].version, '0.2.0');
    assert.equal(online.packages[0].downloads, 'n/a (no telemetry)');
  },
));

// Signed install fixture: a node:test-only Ed25519 signer produces the record
// signature; verification in lib always goes through opurom-pkg's verifyBytes.
function signedInstallFixture(root, registryRoot, { tamperFile = false, tamperSignature = false } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const packageDir = path.join(registryRoot, 'probe', '0.1.0');
  mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  const files = ['bin/probe', 'opurom-pkg.json', 'plugin.json'];
  writeFileSync(path.join(packageDir, 'bin/probe'), '#!/usr/bin/env node\nprocess.stdout.write("ok\\n");\n', { mode: 0o755 });
  writeJson(path.join(packageDir, 'plugin.json'), {
    name: 'probe',
    version: '0.1.0',
    protocol: '1.0',
    capabilities: ['camera.takePhoto'],
    entry: './bin/probe',
    description: 'Install probe',
  });
  writeJson(path.join(packageDir, 'opurom-pkg.json'), {
    name: 'probe',
    version: '0.1.0',
    files,
    capability: 'camera.takePhoto',
  });
  const digests = files.map((file) => ({
    path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(packageDir, file))).digest('hex'),
  }));
  const digest = createHash('sha256')
    .update([...digests].sort((a, b) => (a.path < b.path ? -1 : 1)).map((file) => `${file.path}  ${file.sha256}\n`).join(''))
    .digest('hex');
  const record = { name: 'probe', version: '0.1.0', source: 'opurom/probe', digest, files: digests };
  const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const payload = Buffer.concat([Buffer.from('probe@0.1.0/opurom-install.json\n'), recordBytes]);
  const signature = sign(null, payload, privateKey);
  writeFileSync(path.join(packageDir, 'opurom-install.json'), recordBytes);
  writeFileSync(
    path.join(packageDir, 'opurom-install.json.sig'),
    tamperSignature ? Buffer.from('bad-signature') : signature,
  );
  if (tamperFile) writeFileSync(path.join(packageDir, 'bin/probe'), 'tampered\n');
  writeJson(path.join(root, 'registry.json'), { version: 1, plugins: [] });
  return { publicKey };
}

test('install passes permission, digest, signature, atomic landing and host gates', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-install-root-'));
  const registryRoot = mkdtempSync(path.join(tmpdir(), 'opurom-install-reg-'));
  try {
    const { publicKey } = signedInstallFixture(root, registryRoot);
    const host = new CapabilityHost({
      permissions: { allow: ['camera.takePhoto'], deny: [] },
      root: ROOT,
    });
    try {
      const installed = installMarketPackage('probe', '0.1.0', host, {
        root,
        registryRoot,
        source: 'opurom/probe',
        publicKey,
      });
      assert.equal(installed.name, 'probe');
      assert.match(installed.digest, /^[0-9a-f]{64}$/);
      const registry = JSON.parse(readFileSync(path.join(root, 'registry.json'), 'utf8'));
      assert.equal(registry.plugins.length, 1);
      assert.deepEqual(registry.plugins[0].provenance, {
        source: 'opurom/probe',
        digest: installed.digest,
      });
      assert.ok(existsSync(path.join(root, 'plugins', 'probe', 'bin', 'probe')));
      // Gate 5: a host accepts the landed provenance with the matching key.
      const loaded = new CapabilityHost({
        permissions: { allow: ['camera.takePhoto'], deny: [] },
        root,
        publicKey,
      });
      await loaded.close();
    } finally {
      await host.close();
    }

    // A tampered signature is rejected before the registry changes.
    const badRoot = mkdtempSync(path.join(tmpdir(), 'opurom-install-bad-'));
    const badRegistry = mkdtempSync(path.join(tmpdir(), 'opurom-install-badreg-'));
    try {
      const bad = signedInstallFixture(badRoot, badRegistry, { tamperSignature: true });
      const host2 = new CapabilityHost({
        permissions: { allow: ['camera.takePhoto'], deny: [] },
        root: ROOT,
      });
      try {
        assert.throws(
          () => installMarketPackage('probe', '0.1.0', host2, {
            root: badRoot,
            registryRoot: badRegistry,
            source: 'opurom/probe',
            publicKey: bad.publicKey,
          }),
          (err) => err instanceof MarketError && err.code === 'ERR_MARKET_SIGNATURE',
        );
        assert.deepEqual(JSON.parse(readFileSync(path.join(badRoot, 'registry.json'), 'utf8')).plugins, []);
      } finally {
        await host2.close();
      }
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
      rmSync(badRegistry, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(registryRoot, { recursive: true, force: true });
  }
});

test('a tampered package file fails digest integrity and a tampered registry provenance fails host construction', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-tamper-root-'));
  const registryRoot = mkdtempSync(path.join(tmpdir(), 'opurom-tamper-reg-'));
  try {
    const { publicKey } = signedInstallFixture(root, registryRoot, { tamperFile: true });
    const host = new CapabilityHost({
      permissions: { allow: ['camera.takePhoto'], deny: [] },
      root: ROOT,
    });
    try {
      assert.throws(
        () => installMarketPackage('probe', '0.1.0', host, {
          root,
          registryRoot,
          source: 'opurom/probe',
          publicKey,
        }),
        (err) => err instanceof MarketError && err.code === 'ERR_MARKET_INTEGRITY',
      );
    } finally {
      await host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(registryRoot, { recursive: true, force: true });
  }

  const badRoot = mkdtempSync(path.join(tmpdir(), 'opurom-provenance-root-'));
  const badRegistry = mkdtempSync(path.join(tmpdir(), 'opurom-provenance-reg-'));
  try {
    const { publicKey } = signedInstallFixture(badRoot, badRegistry);
    const host = new CapabilityHost({
      permissions: { allow: ['camera.takePhoto'], deny: [] },
      root: ROOT,
    });
    try {
      installMarketPackage('probe', '0.1.0', host, {
        root: badRoot,
        registryRoot: badRegistry,
        source: 'opurom/probe',
        publicKey,
      });
      const registryFile = path.join(badRoot, 'registry.json');
      const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
      registry.plugins[0].provenance.source = 'evil/fork';
      writeFileSync(registryFile, JSON.stringify(registry));
      assert.throws(
        () => new CapabilityHost({
          permissions: { allow: ['camera.takePhoto'], deny: [] },
          root: badRoot,
          publicKey,
        }),
        /provenance mismatch for probe/,
      );
    } finally {
      await host.close();
    }
  } finally {
    rmSync(badRoot, { recursive: true, force: true });
    rmSync(badRegistry, { recursive: true, force: true });
  }
});

test('the CLI market list --github degrades with a visible notice', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-market-github-cli-'));
  try {
    addPackage(root, 'opurom-ui', '0.1.0', ['button.opu', 'opurom-pkg.json']);
    const result = await runCli(['market', 'list', '--github', 'opurom/plugins'], {
      env: {
        OPR_MARKET_ROOT: root,
        Opurom_GITHUB_API_URL: 'http://127.0.0.1:1',
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /github discovery unavailable/);
    assert.equal(JSON.parse(result.stdout)[0].name, 'opurom-ui');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
