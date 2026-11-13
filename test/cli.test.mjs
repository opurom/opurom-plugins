import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { runCli, ROOT } from '../test-support/helpers.mjs';

const OVERRIDE_STUB = path.join(ROOT, 'test-fixtures', 'override-plugin.mjs');

test('list prints one row per registry plugin', async () => {
  const { code, stdout } = await runCli(['list']);
  assert.equal(code, 0);
  for (const name of ['camera', 'geolocation', 'bluetooth', 'notification', 'payment', 'share', 'storage']) {
    assert.match(stdout, new RegExp(`^${name}\\s`, 'm'));
  }
  assert.match(stdout, /camera\.takePhoto/);
  assert.match(stdout, /storage\.put,storage\.get/);
});

test('verify passes for all seven built plugins and exits 0', async () => {
  const { code, stdout } = await runCli(['verify']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /PASS {2}camera {2}camera\.takePhoto/);
  assert.match(stdout, /PASS {2}geolocation {2}geolocation\.getCurrentPosition/);
  assert.match(stdout, /PASS {2}bluetooth {2}bluetooth\.scan/);
  assert.match(stdout, /PASS {2}notification {2}notification\.show/);
  assert.match(stdout, /PASS {2}payment {2}payment\.request/);
  assert.match(stdout, /PASS {2}share {2}share\.send/);
  assert.match(stdout, /PASS {2}storage {2}storage\.put, storage\.get/);
  assert.match(stdout, /7\/7 plugins verified/);
});

test('verify fails and exits nonzero when a plugin executable is broken', async () => {
  const { code, stdout } = await runCli(['verify'], {
    env: { OPR_PLUGIN_BIN: `camera=${path.join(ROOT, 'test-fixtures', 'missing-plugin.mjs')}` },
  });
  assert.equal(code, 1);
  assert.match(stdout, /FAIL {2}camera/);
  assert.match(stdout, /PASS {2}notification/);
  assert.match(stdout, /6\/7 plugins verified/);
});

test('invoke runs a capability and prints the JSON result', async () => {
  const { code, stdout } = await runCli([
    'invoke',
    'camera',
    'camera.takePhoto',
    JSON.stringify({ quality: 'high' }),
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.path, '/tmp/opurom-photo.png');
});

test('invoke with OPR_PLUGIN_BIN uses the overridden executable', async () => {
  const { code, stdout, stderr } = await runCli(['invoke', 'camera', 'camera.takePhoto'], {
    env: { OPR_PLUGIN_BIN: `camera=${OVERRIDE_STUB}` },
  });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { overridden: true });
});

test('invoke of an unknown capability exits nonzero', async () => {
  const { code, stdout } = await runCli(['invoke', 'camera', 'camera.nope', '{}']);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).ok, false);
  assert.match(JSON.parse(stdout).error, /unknown capability/);
});

test('invoke of an unknown plugin exits nonzero', async () => {
  const { code, stderr } = await runCli(['invoke', 'ghost', 'ghost.run', '{}']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown plugin/);
});

test('invoke rejects params that are not a JSON object', async () => {
  const { code, stderr } = await runCli(['invoke', 'camera', 'camera.takePhoto', '[1,2]']);
  assert.equal(code, 1);
  assert.match(stderr, /params must be a JSON object/);
});

test('invoke rejects params that are not valid JSON', async () => {
  const { code, stderr } = await runCli(['invoke', 'camera', 'camera.takePhoto', '{oops']);
  assert.equal(code, 1);
  assert.match(stderr, /params are not valid JSON/);
});

test('an unknown command exits 2 and prints the usage', async () => {
  const { code, stderr } = await runCli(['frobnicate']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown command/);
});

test('no arguments exits 2 and prints the usage', async () => {
  const { code, stdout } = await runCli([]);
  assert.equal(code, 2);
  assert.match(stdout, /usage: opurom-plugin/);
});
