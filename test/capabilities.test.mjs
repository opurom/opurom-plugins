import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CAPABILITIES,
  CAPABILITY_CATALOG,
  CapabilityDeniedError,
  CapabilityHost,
  CapabilityUndeclaredError,
  CircuitOpenError,
} from '../lib/capabilities.mjs';
import { PluginCrashError, PluginProtocolError, ROOT, loadRegistry, readManifest } from '../lib/host.mjs';
import { runCli } from '../test-support/helpers.mjs';

const FIXTURE = path.join(ROOT, 'test-fixtures', 'capability-plugin.mjs');
const EXPECTED = {
  'camera.takePhoto': { path: '/tmp/opurom-photo.png', quality: 'high', width: 640, height: 480 },
  'geolocation.getCurrentPosition': { latitude: 37.7749, longitude: -122.4194, accuracy: 5, mock: true },
  'bluetooth.scan': { devices: [{ id: 'mock-beacon-1', rssi: -42 }], mock: true },
  'notification.show': { shown: true, title: '', message: '' },
  'payment.request': {
    approved: true,
    transaction: 'mock-payment-1',
    amount: 100,
    currency: 'USD',
    mock: true,
  },
  'share.send': { shared: true, target: 'mock-share-sheet', title: '', text: '', mock: true },
};

function fixtureOverrides() {
  return new Map(
    ['camera', 'geolocation', 'bluetooth', 'notification', 'payment', 'share'].map((name) => [
      name,
      FIXTURE,
    ]),
  );
}

async function withFixtureHost(options, fn) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'opurom-capability-'));
  writeFileSync(path.join(stateDir, 'schedule'), `${options.schedule}\n`);
  const host = new CapabilityHost({
    grants: options.grants ?? ['camera.takePhoto'],
    root: ROOT,
    overrides: fixtureOverrides(),
    timeoutMs: 1000,
    threshold: options.threshold ?? 3,
    cooldownMs: options.cooldownMs ?? 1000,
    clock: options.clock ?? Date.now,
    env: {
      OPR_TEST_STATE_DIR: stateDir,
      OPR_TEST_PLUGIN: 'camera',
      OPR_TEST_CAPABILITIES: 'camera.takePhoto',
    },
  });
  try {
    return await fn({ host, stateDir });
  } finally {
    await host.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test('capability catalog declares the six native permissions', () => {
  assert.deepEqual(CAPABILITIES, [
    'camera.takePhoto',
    'geolocation.getCurrentPosition',
    'bluetooth.scan',
    'notification.show',
    'payment.request',
    'share.send',
  ]);
  for (const capability of CAPABILITIES) {
    assert.equal(CAPABILITY_CATALOG[capability].permission, capability);
  }
});

test('every capability is declared by its registry entry and manifest', () => {
  const { registry, errors } = loadRegistry(ROOT);
  assert.deepEqual(errors, []);
  for (const capability of CAPABILITIES) {
    const name = CAPABILITY_CATALOG[capability].plugin;
    const entry = registry.plugins.find((item) => item.name === name);
    assert.ok(entry, `missing registry entry for ${name}`);
    assert.ok(entry.capabilities.includes(capability));
    const { manifest } = readManifest(path.join(ROOT, entry.path));
    assert.ok(manifest.capabilities.includes(capability));
  }
});

test('each capability grants a deterministic reply from a real mock-device process', async () => {
  const host = new CapabilityHost({ grants: CAPABILITIES, root: ROOT, timeoutMs: 1000 });
  try {
    for (const capability of CAPABILITIES) {
      const result = await host.invoke(capability, EXPECTED[capability].amount ? { amount: 100 } : {});
      assert.deepEqual(result, EXPECTED[capability], capability);
    }
    assert.equal(host.spawnCount, CAPABILITIES.length);
  } finally {
    await host.close();
  }
});

test('permission matrix denies ungranted and undeclared capabilities without spawning', async () => {
  await withFixtureHost({ schedule: 'ok' }, async ({ host, stateDir }) => {
    for (const capability of CAPABILITIES.slice(1)) {
      await assert.rejects(
        () => host.invoke(capability),
        (err) => {
          assert.ok(err instanceof CapabilityDeniedError);
          assert.equal(err.code, 'ERR_CAPABILITY_DENIED');
          assert.equal(err.reason, 'not-granted');
          return true;
        },
      );
    }
    await assert.rejects(
      () => host.invoke('camera.nope'),
      (err) => {
        assert.ok(err instanceof CapabilityUndeclaredError);
        assert.equal(err.code, 'ERR_CAPABILITY_UNDECLARED');
        return true;
      },
    );
    assert.equal(host.spawnCount, 0);
    assert.equal(existsSync(path.join(stateDir, 'started')), false);

    const result = await host.invoke('camera.takePhoto');
    assert.equal(result.mock, true);
    assert.equal(host.spawnCount, 1);
    assert.equal(existsSync(path.join(stateDir, 'started')), true);
  });
});

test('CLI --grant allows a capability and deny is a typed error', async () => {
  const granted = await runCli([
    'invoke',
    'camera',
    'camera.takePhoto',
    '{"quality":"high"}',
    '--grant',
    'camera.takePhoto',
  ]);
  assert.equal(granted.code, 0, granted.stdout + granted.stderr);
  assert.equal(JSON.parse(granted.stdout).path, '/tmp/opurom-photo.png');

  const denied = await runCli([
    'invoke',
    'camera',
    'camera.takePhoto',
    '{}',
    '--grant',
    'notification.show',
  ]);
  assert.equal(denied.code, 1);
  const body = JSON.parse(denied.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'ERR_CAPABILITY_DENIED');
  assert.equal(body.error.capability, 'camera.takePhoto');
});

test('a crashing plugin process is isolated and the next call recovers', async () => {
  await withFixtureHost({ schedule: 'crash,ok' }, async ({ host }) => {
    await assert.rejects(
      () => host.invoke('camera.takePhoto'),
      (err) => {
        assert.ok(err instanceof PluginCrashError);
        assert.equal(err.code, 'ERR_PLUGIN_CRASH');
        return true;
      },
    );
    assert.equal(host.breakerState('camera'), 'half-open');
    const result = await host.invoke('camera.takePhoto');
    assert.equal(result.mock, true);
    assert.equal(host.breakerState('camera'), 'closed');
    assert.equal(host.spawnCount, 2);
  });
});

test('a malformed JSON-lines frame is isolated and the next call recovers', async () => {
  await withFixtureHost({ schedule: 'garbage,ok' }, async ({ host }) => {
    await assert.rejects(
      () => host.invoke('camera.takePhoto'),
      (err) => {
        assert.ok(err instanceof PluginProtocolError);
        assert.equal(err.code, 'ERR_PLUGIN_FRAME');
        return true;
      },
    );
    assert.equal(host.consecutiveFailures('camera'), 1);
    const result = await host.invoke('camera.takePhoto');
    assert.equal(result.mock, true);
    assert.equal(host.consecutiveFailures('camera'), 0);
  });
});

test('circuit breaker states trip after configured failures and recover after cooldown', async () => {
  let now = 0;
  await withFixtureHost(
    { schedule: 'crash,crash,ok', threshold: 2, cooldownMs: 5, clock: () => now },
    async ({ host }) => {
      for (let index = 0; index < 2; index += 1) {
        await assert.rejects(() => host.invoke('camera.takePhoto'), PluginCrashError);
      }
      assert.equal(host.breakerState('camera'), 'open');
      assert.equal(host.circuitOpen('camera'), true);
      assert.equal(host.consecutiveFailures('camera'), 2);
      await assert.rejects(
        () => host.invoke('camera.takePhoto'),
        (err) => {
          assert.ok(err instanceof CircuitOpenError);
          assert.equal(err.code, 'ERR_CIRCUIT_OPEN');
          assert.equal(err.retryAfterMs, 5);
          return true;
        },
      );
      assert.equal(host.spawnCount, 2);

      now = 4;
      await assert.rejects(
        () => host.invoke('camera.takePhoto'),
        (err) => err instanceof CircuitOpenError && err.retryAfterMs === 1,
      );
      assert.equal(host.spawnCount, 2);

      now = 5;
      assert.equal(host.breakerState('camera'), 'open');
      const result = await host.invoke('camera.takePhoto');
      assert.equal(result.mock, true);
      assert.equal(host.breakerState('camera'), 'closed');
      assert.equal(host.circuitOpen('camera'), false);
      assert.equal(host.consecutiveFailures('camera'), 0);
      assert.equal(host.spawnCount, 3);
    },
  );
});

test('no child plugin processes remain after crashes, malformed frames and close', async () => {
  await withFixtureHost({ schedule: 'crash,garbage,ok' }, async ({ host, stateDir }) => {
    await assert.rejects(() => host.invoke('camera.takePhoto'), PluginCrashError);
    await assert.rejects(() => host.invoke('camera.takePhoto'), PluginProtocolError);
    assert.equal((await host.invoke('camera.takePhoto')).mock, true);
    await host.close();
    const pids = readFileSync(path.join(stateDir, 'pids'), 'utf8')
      .trim()
      .split('\n')
      .map(Number)
      .filter(Boolean);
    assert.equal(pids.length, 3);
    assert.deepEqual([...host.spawnedPids].sort(), [...pids].sort());
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), /ESRCH/, `plugin pid ${pid} is still alive`);
    }
  });
});
