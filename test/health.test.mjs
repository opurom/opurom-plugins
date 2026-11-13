import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUDIT_LIMIT, CapabilityHost } from '../lib/capabilities.mjs';
import { PluginCrashError, PluginTimeoutError, ROOT } from '../lib/host.mjs';

const FIXTURE = path.join(ROOT, 'test-fixtures', 'capability-plugin.mjs');

async function withHost(options, fn) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'opurom-health-'));
  writeFileSync(path.join(stateDir, 'schedule'), `${options.schedule ?? 'ok'}\n`);
  const host = new CapabilityHost({
    permissions: { allow: options.allow ?? ['camera.takePhoto'], deny: options.deny ?? [] },
    root: ROOT,
    overrides: new Map([['camera', FIXTURE]]),
    timeoutMs: options.timeoutMs ?? 250,
    threshold: options.threshold ?? 3,
    cooldownMs: 1000,
    env: {
      OPR_TEST_STATE_DIR: stateDir,
      OPR_TEST_PLUGIN: 'camera',
      OPR_TEST_CAPABILITIES: 'camera.takePhoto',
    },
  });
  try {
    return await fn(host);
  } finally {
    await host.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const ZERO = (plugin) => ({
  plugin,
  invocations: 0,
  denials: 0,
  crashes: 0,
  lastErrorCode: null,
});

test('health stays zero and frozen until the plugin is actually invoked', async () => {
  await withHost({}, async (host) => {
    const first = host.health('camera');
    assert.deepEqual(first, ZERO('camera'));
    assert.ok(Object.isFrozen(first));
    assert.throws(() => {
      first.invocations = 9;
    }, TypeError);

    for (let index = 0; index < 5; index += 1) host.check('camera.takePhoto');
    assert.deepEqual(host.health('camera'), first, 'a pure check records nothing');

    await assert.rejects(host.invoke('camera.nope'), /unknown capability/);
    assert.deepEqual(host.health('camera'), first, 'an unknown capability belongs to no plugin');
    assert.deepEqual(host.health('not-a-plugin'), ZERO('not-a-plugin'));
  });
});

test('health counts invocations and denials per plugin with their error codes', async () => {
  await withHost({ deny: ['share.send'] }, async (host) => {
    assert.equal((await host.invoke('camera.takePhoto')).mock, true);
    assert.deepEqual(host.health('camera'), {
      plugin: 'camera',
      invocations: 1,
      denials: 0,
      crashes: 0,
      lastErrorCode: null,
    });

    await assert.rejects(host.invoke('share.send'), (err) => err.reason === 'explicit-deny');
    await assert.rejects(host.invoke('payment.request'), (err) => err.reason === 'not-granted');
    await assert.rejects(host.invoke('share.send'), (err) => err.reason === 'explicit-deny');
    assert.deepEqual(host.health('share'), {
      plugin: 'share',
      invocations: 2,
      denials: 2,
      crashes: 0,
      lastErrorCode: 'ERR_CAPABILITY_DENIED',
    });
    assert.deepEqual(host.health('payment'), {
      plugin: 'payment',
      invocations: 1,
      denials: 1,
      crashes: 0,
      lastErrorCode: 'ERR_CAPABILITY_DENIED',
    });
    assert.deepEqual(
      host.health('camera'),
      { plugin: 'camera', invocations: 1, denials: 0, crashes: 0, lastErrorCode: null },
      'counters never leak between plugins',
    );

    // Counters cover the whole lifetime while the audit trail stays bounded.
    for (let index = 0; index < AUDIT_LIMIT + 5; index += 1) {
      await assert.rejects(host.invoke('payment.request'));
    }
    assert.equal(host.audit().length, AUDIT_LIMIT);
    assert.equal(host.health('payment').invocations, AUDIT_LIMIT + 6);
    assert.equal(host.health('payment').denials, AUDIT_LIMIT + 6);
  });
});

test('health counts crashes separately from timeouts', async () => {
  await withHost({ schedule: 'crash,hang' }, async (host) => {
    await assert.rejects(host.invoke('camera.takePhoto'), PluginCrashError);
    assert.deepEqual(host.health('camera'), {
      plugin: 'camera',
      invocations: 1,
      denials: 0,
      crashes: 1,
      lastErrorCode: 'ERR_PLUGIN_CRASH',
    });

    await assert.rejects(host.invoke('camera.takePhoto'), PluginTimeoutError);
    assert.deepEqual(host.health('camera'), {
      plugin: 'camera',
      invocations: 2,
      denials: 0,
      crashes: 1,
      lastErrorCode: 'ERR_PLUGIN_TIMEOUT',
    });
    assert.equal(host.spawnCount, 2, 'each attempt ran its own plugin process');
  });
});
