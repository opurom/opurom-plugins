import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  loadRegistry,
  parseBinaryOverrides,
  resolveEntry,
  resolveTimeout,
  validateManifest,
  validateRegistryEntry,
  verifyEntry,
  ROOT,
} from '../lib/host.mjs';

const VALID_ENTRY = {
  name: 'camera',
  version: '0.1.0',
  path: 'plugins/camera',
  capabilities: ['camera.takePhoto'],
};

function withRegistry(plugins, fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-registry-'));
  try {
    writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ version: 1, plugins }));
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('registry.json has the documented shape', () => {
  const { registry, errors } = loadRegistry(ROOT);
  assert.deepEqual(errors, []);
  assert.equal(registry.version, 1);
  assert.ok(Array.isArray(registry.plugins));
  assert.equal(registry.plugins.length, 7);
  const names = registry.plugins.map((entry) => entry.name).sort();
  assert.deepEqual(names, [
    'bluetooth',
    'camera',
    'geolocation',
    'notification',
    'payment',
    'share',
    'storage',
  ]);
  for (const entry of registry.plugins) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.version, 'string');
    assert.equal(typeof entry.path, 'string');
    assert.ok(Array.isArray(entry.capabilities));
    assert.ok(entry.capabilities.length > 0);
    assert.deepEqual(validateRegistryEntry(entry, ROOT), []);
  }
});

test('a well-formed registry is returned without errors', () => {
  withRegistry([VALID_ENTRY], (root) => {
    const { registry, errors } = loadRegistry(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(registry.plugins, [VALID_ENTRY]);
  });
});

test('duplicate plugin names invalidate the whole registry', () => {
  withRegistry([VALID_ENTRY, { ...VALID_ENTRY }], (root) => {
    const { registry, errors } = loadRegistry(root);
    assert.equal(registry, null);
    assert.ok(
      errors.some((err) => err.includes('duplicate plugin name: camera')),
      errors.join('; '),
    );
  });
});

test('a capability may be declared by only one plugin', () => {
  const other = {
    name: 'second',
    version: '0.1.0',
    path: 'plugins/second',
    capabilities: ['camera.takePhoto'],
  };
  withRegistry([VALID_ENTRY, other], (root) => {
    const { registry, errors } = loadRegistry(root);
    assert.equal(registry, null);
    assert.ok(
      errors.some((err) => err.includes('duplicate capability declaration: camera.takePhoto')),
      errors.join('; '),
    );
  });
});

test('malformed entries and repeated claims are reported before the registry is used', () => {
  const broken = {
    name: 'Bad Name',
    version: '0.1.0',
    path: 'plugins/bad',
    capabilities: ['camera.takePhoto'],
  };
  const repeated = { ...VALID_ENTRY, capabilities: ['camera.takePhoto', 'camera.takePhoto'] };
  withRegistry([broken, repeated], (root) => {
    const { registry, errors } = loadRegistry(root);
    assert.equal(registry, null);
    assert.ok(
      errors.some((err) => err.includes('plugin 0: invalid plugin name')),
      errors.join('; '),
    );
    assert.ok(
      errors.some((err) => err.includes('duplicate capability declaration')),
      errors.join('; '),
    );
  });
});

test('registry entries declare the expected capabilities', () => {
  const { registry } = loadRegistry(ROOT);
  const byName = Object.fromEntries(registry.plugins.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName.camera.capabilities, ['camera.takePhoto']);
  assert.deepEqual(byName.geolocation.capabilities, ['geolocation.getCurrentPosition']);
  assert.deepEqual(byName.bluetooth.capabilities, ['bluetooth.scan']);
  assert.deepEqual(byName.notification.capabilities, ['notification.show']);
  assert.deepEqual(byName.payment.capabilities, ['payment.request']);
  assert.deepEqual(byName.share.capabilities, ['share.send']);
  assert.deepEqual(byName.storage.capabilities, ['storage.put', 'storage.get']);
});

test('registry entries outside the repository are rejected', () => {
  const errors = validateRegistryEntry(
    { name: 'camera', version: '0.1.0', path: '../escape', capabilities: ['camera.takePhoto'] },
    ROOT,
  );
  assert.ok(errors.some((err) => err.includes('escapes the registry root')), errors.join('; '));
});

test('malformed registry entries are rejected', () => {
  const cases = [
    [{ name: 'Bad Name', version: '0.1.0', path: 'plugins/camera', capabilities: ['a.b'] }, 'name'],
    [{ name: 'ok', version: 'x', path: 'plugins/camera', capabilities: ['a.b'] }, 'version'],
    [{ name: 'ok', version: '0.1.0', path: 'plugins/camera', capabilities: [] }, 'capabilities'],
    [{ name: 'ok', version: '0.1.0', path: 'plugins/camera', capabilities: ['nodot'] }, 'capability'],
    [{ name: 'ok', version: '0.1.0', path: '', capabilities: ['a.b'] }, 'path'],
  ];
  for (const [entry, needle] of cases) {
    const errors = validateRegistryEntry(entry, ROOT);
    assert.ok(errors.length > 0, `expected an error for ${JSON.stringify(entry)}`);
    assert.ok(errors.join('; ').includes(needle), errors.join('; '));
  }
});

test('manifest validation rejects broken manifests', () => {
  const valid = {
    name: 'camera',
    version: '0.1.0',
    protocol: '1.0',
    capabilities: ['camera.takePhoto'],
    entry: './bin/camera',
    description: 'Camera access',
  };
  assert.deepEqual(validateManifest(valid), []);

  const cases = [
    [{ ...valid, name: 'Camera' }, 'name'],
    [{ ...valid, version: '0.1' }, 'version'],
    [{ ...valid, protocol: '2.0' }, 'protocol'],
    [{ ...valid, capabilities: [] }, 'capabilities'],
    [{ ...valid, capabilities: ['nodots'] }, 'capability'],
    [{ ...valid, entry: '' }, 'entry'],
    [{ ...valid, description: '' }, 'description'],
  ];
  for (const [manifest, needle] of cases) {
    const errors = validateManifest(manifest);
    assert.ok(errors.length > 0, `expected an error for ${JSON.stringify(manifest)}`);
    assert.ok(errors.join('; ').includes(needle), errors.join('; '));
  }
});

test('manifest entry may not traverse out of the plugin directory', () => {
  const pluginDir = path.join(ROOT, 'plugins', 'camera');
  const traversal = resolveEntry(pluginDir, '../../bin/evil');
  assert.ok(traversal.errors.length > 0);
  assert.match(traversal.errors.join('; '), /traverse|escapes/);

  const absolute = resolveEntry(pluginDir, '/usr/bin/evil');
  assert.ok(absolute.errors.length > 0);

  const inside = resolveEntry(pluginDir, './bin/camera');
  assert.deepEqual(inside.errors, []);
  assert.equal(inside.file, path.join(pluginDir, 'bin', 'camera'));
});

test('timeout is bounded to the protocol range', () => {
  assert.equal(resolveTimeout(undefined), 500);
  assert.equal(resolveTimeout(10), 50);
  assert.equal(resolveTimeout(999999), 5000);
  assert.equal(resolveTimeout('250'), 250);
  assert.equal(resolveTimeout('nonsense'), 500);
  assert.equal(resolveTimeout(0), 500);
});

test('OPR_PLUGIN_BIN overrides parse into name/path pairs', () => {
  const overrides = parseBinaryOverrides('camera=/tmp/camera, storage=/tmp/storage');
  assert.equal(overrides.get('camera'), '/tmp/camera');
  assert.equal(overrides.get('storage'), '/tmp/storage');
  assert.equal(overrides.size, 2);
  assert.equal(parseBinaryOverrides('').size, 0);
  assert.equal(parseBinaryOverrides('garbage').size, 0);
});

test('verifyEntry rejects a registry entry whose manifest is missing', async () => {
  const result = await verifyEntry(
    { name: 'ghost', version: '0.1.0', path: 'plugins/ghost', capabilities: ['ghost.run'] },
    ROOT,
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /cannot read/);
});
