import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CapabilityDeniedError,
  CapabilityHost,
  CapabilityHostError,
  CapabilityUndeclaredError,
  CircuitOpenError,
  PermissionManifestError,
  PluginDependencyError,
  loadCapabilityCatalog,
  validatePermissionManifest,
} from '../lib/capabilities.mjs';
import { PluginCrashError, PluginProtocolError, PluginTimeoutError, ROOT, loadRegistry, readManifest } from '../lib/host.mjs';
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

// The six native capabilities; the derived catalog also carries storage.*.
const NATIVE = [
  'camera.takePhoto',
  'geolocation.getCurrentPosition',
  'bluetooth.scan',
  'notification.show',
  'payment.request',
  'share.send',
];

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

test('the derived catalog covers every registry and manifest declaration', () => {
  const catalog = loadCapabilityCatalog(ROOT);
  assert.deepEqual(Object.keys(catalog).sort(), [...NATIVE, 'storage.get', 'storage.put'].sort());
  for (const capability of [...NATIVE, 'storage.put', 'storage.get']) {
    assert.equal(catalog[capability].permission, capability);
  }
});

test('every capability is declared by its registry entry and manifest', () => {
  const catalog = loadCapabilityCatalog(ROOT);
  const { registry, errors } = loadRegistry(ROOT);
  assert.deepEqual(errors, []);
  for (const [capability, meta] of Object.entries(catalog)) {
    const entry = registry.plugins.find((item) => item.name === meta.plugin);
    assert.ok(entry, `missing registry entry for ${meta.plugin}`);
    assert.ok(entry.capabilities.includes(capability));
    const { manifest } = readManifest(path.join(ROOT, entry.path));
    assert.ok(manifest.capabilities.includes(capability));
  }
});

test('a broken registry or manifest fails host construction before any spawn', () => {
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
    assert.throws(
      () => new CapabilityHost({ grants: ['camera.takePhoto'], root }),
      (err) => err instanceof CapabilityHostError && /derive the capability catalog/.test(err.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each capability grants a deterministic reply from a real mock-device process', async () => {
  const host = new CapabilityHost({ grants: NATIVE, root: ROOT, timeoutMs: 1000 });
  try {
    for (const capability of NATIVE) {
      const result = await host.invoke(capability, EXPECTED[capability].amount ? { amount: 100 } : {});
      assert.deepEqual(result, EXPECTED[capability], capability);
    }
    assert.equal(host.spawnCount, NATIVE.length);
  } finally {
    await host.close();
  }
});

test('registry-declared storage capabilities are grantable and health-attributed', async () => {
  const host = new CapabilityHost({
    grants: ['storage.put', 'storage.get'],
    root: ROOT,
    timeoutMs: 1000,
  });
  try {
    const put = await host.invoke('storage.put', { key: 'grant', value: 5 });
    assert.equal(put.stored, true);
    assert.deepEqual(host.check('storage.get'), { allowed: true, reason: 'granted' });
    const got = await host.invoke('storage.get', { key: 'grant' });
    assert.deepEqual(got.value, 5);
    assert.deepEqual(host.health('storage'), {
      plugin: 'storage',
      invocations: 2,
      denials: 0,
      crashes: 0,
      lastErrorCode: null,
    });
  } finally {
    await host.close();
  }
});

// Two-plugin dependency fixture: `a` depends on `b`; both use the mock fixture
// binary through overrides when their real executables should exist.
function writeDependencyFixture(root, { registry, manifests }) {
  writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: registry }));
  for (const manifest of manifests) {
    mkdirSync(path.join(root, 'plugins', manifest.name), { recursive: true });
    writeFileSync(path.join(root, 'plugins', manifest.name, 'plugin.json'), JSON.stringify(manifest));
  }
}

const DEP_MANIFESTS = [
  {
    name: 'alpha',
    version: '0.1.0',
    protocol: '1.0',
    capabilities: ['alpha.cap'],
    entry: './bin/a',
    description: 'Consumer',
    dependencies: ['beta'],
  },
  {
    name: 'beta',
    version: '0.1.0',
    protocol: '1.0',
    capabilities: ['beta.cap'],
    entry: './bin/b',
    description: 'Dependency',
  },
];

const DEP_REGISTRY = [
  { name: 'alpha', version: '0.1.0', path: 'plugins/alpha', capabilities: ['alpha.cap'] },
  { name: 'beta', version: '0.1.0', path: 'plugins/beta', capabilities: ['beta.cap'] },
];

test('a missing or cyclic dependency fails host construction', () => {
  const missing = mkdtempSync(path.join(tmpdir(), 'opurom-deps-'));
  try {
    writeDependencyFixture(missing, { registry: [DEP_REGISTRY[0]], manifests: DEP_MANIFESTS });
    assert.throws(
      () => new CapabilityHost({ grants: ['alpha.cap'], root: missing }),
      (err) =>
        err instanceof PluginDependencyError &&
        err.code === 'ERR_DEPENDENCY_MISSING' &&
        /depends on missing plugin beta/.test(err.message),
    );
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }

  const cyclic = mkdtempSync(path.join(tmpdir(), 'opurom-deps-'));
  try {
    const cyclicManifests = [
      DEP_MANIFESTS[0],
      { ...DEP_MANIFESTS[1], dependencies: ['alpha'] },
    ];
    writeDependencyFixture(cyclic, { registry: DEP_REGISTRY, manifests: cyclicManifests });
    assert.throws(
      () => new CapabilityHost({ grants: ['alpha.cap'], root: cyclic }),
      (err) =>
        err instanceof PluginDependencyError &&
        err.code === 'ERR_DEPENDENCY_CYCLE' &&
        /dependency cycle: alpha -> beta -> alpha/.test(err.message),
    );
  } finally {
    rmSync(cyclic, { recursive: true, force: true });
  }
});

test('a consumer is not spawned when its dependency cannot load', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-deps-'));
  try {
    writeDependencyFixture(root, { registry: DEP_REGISTRY, manifests: DEP_MANIFESTS });
    const host = new CapabilityHost({
      grants: ['alpha.cap'],
      root,
      overrides: new Map([['alpha', FIXTURE]]),
      timeoutMs: 1000,
      env: { OPR_TEST_PLUGIN: 'alpha', OPR_TEST_CAPABILITIES: 'alpha.cap' },
    });
    try {
      await assert.rejects(
        () => host.invoke('alpha.cap'),
        (err) => {
          assert.ok(err instanceof PluginDependencyError);
          assert.equal(err.code, 'ERR_PLUGIN_DEPENDENCY');
          assert.match(err.message, /dependency beta of alpha cannot load/);
          return true;
        },
      );
      assert.equal(host.spawnCount, 0);
    } finally {
      await host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a resolvable dependency chain serves the consumer', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-deps-'));
  try {
    writeDependencyFixture(root, { registry: DEP_REGISTRY, manifests: DEP_MANIFESTS });
    const host = new CapabilityHost({
      grants: ['alpha.cap'],
      root,
      overrides: new Map([
        ['alpha', FIXTURE],
        ['beta', FIXTURE],
      ]),
      timeoutMs: 1000,
      env: { OPR_TEST_PLUGIN: 'alpha', OPR_TEST_CAPABILITIES: 'alpha.cap' },
    });
    try {
      const result = await host.invoke('alpha.cap');
      assert.equal(result.mock, true);
      assert.equal(host.spawnCount, 1, 'only the consumer process runs per invocation');
    } finally {
      await host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('permission matrix denies ungranted and undeclared capabilities without spawning', async () => {
  await withFixtureHost({ schedule: 'ok' }, async ({ host, stateDir }) => {
    for (const capability of NATIVE.slice(1)) {
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
    for (const capability of NATIVE) {
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
    assert.ok(validatePermissionManifest(manifest, loadCapabilityCatalog(ROOT)).join('; ').includes(needle));
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
    validatePermissionManifest(
      { allow: ['camera.takePhoto'], deny: ['share.send'] },
      loadCapabilityCatalog(ROOT),
    ),
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

test('a crash keeps its breaker count even after a later success', async () => {
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
    // Spec fault policy: success never resets a count that holds a crash.
    const result = await host.invoke('camera.takePhoto');
    assert.equal(result.mock, true);
    assert.equal(host.breakerState('camera'), 'half-open');
    assert.equal(host.consecutiveFailures('camera'), 1);
    assert.equal(host.spawnCount, 2);
  });
});

test('a frame violation keeps its breaker count even after a later success', async () => {
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
    assert.equal(host.consecutiveFailures('camera'), 1);
  });
});

test('a circuit opened by crashes stays disabled with no cooldown trial', async () => {
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

      // Past the cooldown a crash-opened circuit still refuses to serve.
      now = 5;
      await assert.rejects(
        () => host.invoke('camera.takePhoto'),
        (err) => err instanceof CircuitOpenError && err.retryAfterMs === 0,
      );
      assert.equal(host.breakerState('camera'), 'open');
      assert.equal(host.consecutiveFailures('camera'), 2);
      assert.equal(host.spawnCount, 2);
    },
  );
});

test('a circuit opened by timeouts still recovers after cooldown', async () => {
  let now = 0;
  await withFixtureHost(
    { schedule: 'hang,hang,ok', threshold: 2, cooldownMs: 5, clock: () => now },
    async ({ host }) => {
      for (let index = 0; index < 2; index += 1) {
        await assert.rejects(() => host.invoke('camera.takePhoto'), PluginTimeoutError);
      }
      assert.equal(host.breakerState('camera'), 'open');
      now = 5;
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
