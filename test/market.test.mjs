import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  MarketError,
  listMarket,
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
