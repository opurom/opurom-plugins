import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { statSync } from 'node:fs';
import { ROOT, handshake, invokeCapability, resolveEntry, readManifest } from '../lib/host.mjs';

// The full suite runs several test files concurrently; keep process handshakes
// comfortably above the production 500 ms default under that load.
process.env.OPR_PLUGIN_TIMEOUT_MS ??= '2000';

const PLUGINS = [
  {
    name: 'camera',
    dir: 'plugins/camera',
    binary: 'plugins/camera/bin/camera',
    capability: 'camera.takePhoto',
    params: { quality: 'high' },
  },
  {
    name: 'geolocation',
    dir: 'plugins/geolocation',
    binary: 'plugins/geolocation/bin/geolocation',
    capability: 'geolocation.getCurrentPosition',
    params: {},
  },
  {
    name: 'bluetooth',
    dir: 'plugins/bluetooth',
    binary: 'plugins/bluetooth/bin/bluetooth',
    capability: 'bluetooth.scan',
    params: {},
  },
  {
    name: 'notification',
    dir: 'plugins/notification',
    binary: 'plugins/notification/bin/notification',
    capability: 'notification.show',
    params: { title: 'hi', message: 'yo' },
  },
  {
    name: 'payment',
    dir: 'plugins/payment',
    binary: 'plugins/payment/bin/payment',
    capability: 'payment.request',
    params: { amount: 100 },
  },
  {
    name: 'share',
    dir: 'plugins/share',
    binary: 'plugins/share/bin/share',
    capability: 'share.send',
    params: { title: 'hi', text: 'yo' },
  },
  {
    name: 'storage',
    dir: 'plugins/storage',
    binary: 'plugins/storage/bin/storage',
    capability: 'storage.put',
    params: { key: 'test', value: 7 },
  },
];

function binaryOf(relative) {
  return path.join(ROOT, relative);
}

test('every plugin completes a real hello handshake', async () => {
  for (const plugin of PLUGINS) {
    const result = await handshake(binaryOf(plugin.binary));
    assert.equal(result.ok, true, `${plugin.name}: ${result.error}`);
    assert.equal(result.result.name, plugin.name);
    assert.equal(result.result.version, '0.1.0');
    assert.ok(Array.isArray(result.result.capabilities));
    assert.ok(result.result.capabilities.includes(plugin.capability));
  }
});

test('every declared capability can be invoked', async () => {
  const cases = [
    ...PLUGINS,
    {
      name: 'storage.get',
      dir: 'plugins/storage',
      binary: 'plugins/storage/bin/storage',
      capability: 'storage.get',
      params: { key: 'test' },
    },
  ];
  for (const plugin of cases) {
    const result = await invokeCapability(binaryOf(plugin.binary), plugin.capability, plugin.params);
    assert.equal(result.ok, true, `${plugin.capability}: ${result.error}`);
    assert.ok(result.result && typeof result.result === 'object');
  }
});

test('camera.takePhoto returns a deterministic simulated path', async () => {
  const first = await invokeCapability(binaryOf(PLUGINS[0].binary), 'camera.takePhoto', {
    quality: 'high',
  });
  const second = await invokeCapability(binaryOf(PLUGINS[0].binary), 'camera.takePhoto', {
    quality: 'high',
  });
  assert.equal(first.result.path, '/tmp/opurom-photo.png');
  assert.deepEqual(first.result, second.result);
});

test('storage round-trips a value through its persisted map', async () => {
  const binary = binaryOf(PLUGINS[6].binary);
  const put = await invokeCapability(binary, 'storage.put', { key: 'roundtrip', value: { n: 1 } });
  assert.equal(put.ok, true);
  assert.equal(put.result.stored, true);
  const get = await invokeCapability(binary, 'storage.get', { key: 'roundtrip' });
  assert.equal(get.ok, true);
  assert.equal(get.result.found, true);
  assert.deepEqual(get.result.value, { n: 1 });
});

test('a plugin works with empty params, as opurom-core invokes it', async () => {
  // opurom-core calls `invoke` with `{}`; every capability must answer without params.
  const cases = PLUGINS.map(({ binary, capability }) => ({ binary, capability }));
  cases.push({ binary: 'plugins/storage/bin/storage', capability: 'storage.get' });
  for (const plugin of cases) {
    const result = await invokeCapability(binaryOf(plugin.binary), plugin.capability, {});
    assert.equal(result.ok, true, `${plugin.capability}: ${result.error}`);
  }
});

test('an unknown capability is rejected with the documented error', async () => {
  for (const plugin of PLUGINS) {
    const result = await invokeCapability(binaryOf(plugin.binary), `${plugin.name}.nope`, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, `unknown capability: ${plugin.name}.nope`);
    assert.equal(result.response.ok, false);
    assert.equal(result.response.id, 1);
  }
});

test('the plugin advertises exactly the manifest capabilities', async () => {
  for (const plugin of PLUGINS) {
    const { manifest } = readManifest(path.join(ROOT, plugin.dir));
    assert.ok(manifest, `missing manifest for ${plugin.name}`);
    const result = await handshake(binaryOf(plugin.binary));
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result.capabilities, manifest.capabilities);
  }
});

test('manifest entries resolve to an executable inside the plugin directory', async () => {
  for (const plugin of PLUGINS) {
    const pluginDir = path.join(ROOT, plugin.dir);
    const { manifest } = readManifest(pluginDir);
    assert.ok(manifest, `missing manifest for ${plugin.name}`);
    const resolved = resolveEntry(pluginDir, manifest.entry);
    assert.deepEqual(resolved.errors, []);
    const stat = statSync(resolved.file);
    assert.ok(stat.isFile());
    assert.ok((stat.mode & 0o111) !== 0, 'entry must be executable');
  }
});
