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
  PermissionManifestError,
  validatePermissionManifest,
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
    permissions: {
      allow: options.grants ?? ['camera.takePhoto'],
      deny: options.denies ?? [],
    },
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

test('an invalid registry is rejected before any plugin is spawned', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-registry-'));
  try {
    const entry = {
      name: 'camera',
      version: '0.1.0',
      path: 'plugins/camera',
      capabilities: ['camera.takePhoto'],
    };
    writeFileSync(
      path.join(root, 'registry.json'),
      JSON.stringify({ version: 1, plugins: [entry, { ...entry }] }),
    );
    const host = new CapabilityHost({ grants: ['camera.takePhoto'], root });
    try {
      await assert.rejects(
        () => host.invoke('camera.takePhoto'),
        (err) =>
          err instanceof CapabilityUndeclaredError &&
          err.code === 'ERR_CAPABILITY_UNDECLARED',
      );
      assert.equal(host.spawnCount, 0);
    } finally {
      await host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('a capability that is both allowed and denied is denied before any spawn', async () => {
  await withFixtureHost({ schedule: 'ok', denies: ['camera.takePhoto'] }, async ({ host, stateDir }) => {
    assert.deepEqual(host.check('camera.takePhoto'), { allowed: false, reason: 'explicit-deny' });
    await assert.rejects(
      () => host.invoke('camera.takePhoto'),
      (err) => {
        assert.ok(err instanceof CapabilityDeniedError);
        assert.equal(err.code, 'ERR_CAPABILITY_DENIED');
        assert.equal(err.reason, 'explicit-deny');
        assert.match(err.message, /explicitly denied/);
        return true;
      },
    );
    assert.equal(host.spawnCount, 0);
    assert.equal(existsSync(path.join(stateDir, 'started')), false);
  });
});

test('an unrelated deny does not revoke a granted capability', async () => {
  await withFixtureHost({ schedule: 'ok', denies: ['share.send'] }, async ({ host }) => {
    const result = await host.invoke('camera.takePhoto');
    assert.equal(result.mock, true);
    assert.equal(host.spawnCount, 1);
  });
});

test('an undeclared capability is denied by default without spawning', async () => {
  const host = new CapabilityHost({ permissions: { allow: [], deny: [] }, root: ROOT });
  try {
    for (const capability of CAPABILITIES) {
      assert.deepEqual(host.check(capability), { allowed: false, reason: 'not-granted' });
      await assert.rejects(
        () => host.invoke(capability),
        (err) => err instanceof CapabilityDeniedError && err.reason === 'not-granted',
      );
    }
    assert.deepEqual(host.check('camera.nope'), { allowed: false, reason: 'undeclared' });
    await assert.rejects(
      () => host.invoke('camera.nope'),
      (err) => err instanceof CapabilityUndeclaredError && err.code === 'ERR_CAPABILITY_UNDECLARED',
    );
    assert.equal(host.spawnCount, 0);
  } finally {
    await host.close();
  }
});

test('a malformed permission manifest is rejected with a typed, clear error', () => {
  const cases = [
    [null, 'manifest must be a JSON object'],
    [[], 'manifest must be a JSON object'],
    [{ allow: 'camera.takePhoto' }, 'allow must be an array'],
    [{ deny: 7 }, 'deny must be an array'],
    [{ allow: [42] }, 'allow contains an unknown capability'],
    [{ deny: ['camera.nope'] }, 'deny contains an unknown capability'],
    [{ allows: ['camera.takePhoto'] }, 'unknown permission manifest field'],
  ];
  for (const [manifest, needle] of cases) {
    assert.ok(validatePermissionManifest(manifest).join('; ').includes(needle));
    assert.throws(
      () => new CapabilityHost({ permissions: manifest, root: ROOT }),
      (err) => {
        assert.ok(err instanceof PermissionManifestError);
        assert.equal(err.code, 'ERR_PERMISSION_MANIFEST');
        assert.ok(err.message.includes(needle), err.message);
        assert.ok(Array.isArray(err.errors) && err.errors.length > 0);
        return true;
      },
    );
  }
  assert.throws(() => new CapabilityHost({ grants: 'camera.takePhoto' }), PermissionManifestError);
  assert.deepEqual(
    validatePermissionManifest({ allow: ['camera.takePhoto'], deny: ['share.send'] }),
    [],
  );
});

test('permission checks are deterministic under repeated calls', async () => {
  const host = new CapabilityHost({
    permissions: {
      allow: ['camera.takePhoto', 'payment.request'],
      deny: ['payment.request'],
    },
    root: ROOT,
  });
  const decisions = [
    ['camera.takePhoto', { allowed: true, reason: 'granted' }],
    ['payment.request', { allowed: false, reason: 'explicit-deny' }],
    ['share.send', { allowed: false, reason: 'not-granted' }],
    ['camera.nope', { allowed: false, reason: 'undeclared' }],
  ];
  try {
    for (let round = 0; round < 20; round += 1) {
      for (const [capability, expected] of decisions) {
        assert.deepEqual(host.check(capability), expected, `${capability} in round ${round}`);
      }
      await assert.rejects(
        () => host.invoke('payment.request'),
        (err) => err instanceof CapabilityDeniedError && err.reason === 'explicit-deny',
      );
    }
    for (const [capability, expected] of decisions) {
      assert.deepEqual(host.check(capability), expected, `${capability} after repeated denials`);
    }
    assert.equal(host.spawnCount, 0);
  } finally {
    await host.close();
  }
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

test('CLI --deny overrides a matching --grant', async () => {
  const denied = await runCli([
    'invoke',
    'camera',
    'camera.takePhoto',
    '{}',
    '--grant',
    'camera.takePhoto',
    '--deny',
    'camera.takePhoto',
  ]);
  assert.equal(denied.code, 1);
  const body = JSON.parse(denied.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'ERR_CAPABILITY_DENIED');
  assert.equal(body.error.reason, 'explicit-deny');
  assert.equal(body.error.capability, 'camera.takePhoto');

  const denyOnly = await runCli([
    'invoke',
    'camera',
    'camera.takePhoto',
    '{}',
    '--deny',
    'share.send',
  ]);
  assert.equal(denyOnly.code, 1);
  const defaultDeny = JSON.parse(denyOnly.stdout);
  assert.equal(defaultDeny.ok, false);
  assert.equal(defaultDeny.error.code, 'ERR_CAPABILITY_DENIED');
  assert.equal(defaultDeny.error.reason, 'not-granted');
});

test('CLI reports a malformed permission manifest as a typed error', async () => {
  const result = await runCli([
    'invoke',
    'camera',
    'camera.takePhoto',
    '{}',
    '--grant',
    'camera.nope',
  ]);
  assert.equal(result.code, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'ERR_PERMISSION_MANIFEST');
  assert.match(body.error.message, /invalid permission manifest/);
  assert.ok(body.error.errors.some((err) => err.includes('camera.nope')));
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
