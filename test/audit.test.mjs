import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUDIT_LIMIT, CapabilityHost, CircuitOpenError } from '../lib/capabilities.mjs';
import { PluginCrashError, ROOT } from '../lib/host.mjs';

const FIXTURE = path.join(ROOT, 'test-fixtures', 'capability-plugin.mjs');

async function withHost(options, fn) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'opurom-audit-'));
  writeFileSync(path.join(stateDir, 'schedule'), `${options.schedule ?? 'ok'}\n`);
  const host = new CapabilityHost({
    permissions: { allow: options.allow ?? ['camera.takePhoto'], deny: options.deny ?? [] },
    root: ROOT,
    overrides: new Map([['camera', FIXTURE]]),
    timeoutMs: 1000,
    threshold: options.threshold ?? 3,
    cooldownMs: options.cooldownMs ?? 1000,
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

test('the audit trail records allowed, denied and error decisions in sequence order', async () => {
  await withHost({ schedule: 'ok,crash,ok', deny: ['share.send'] }, async (host) => {
    assert.equal((await host.invoke('camera.takePhoto')).mock, true);
    for (let index = 0; index < 5; index += 1) host.check('camera.takePhoto');
    await assert.rejects(host.invoke('share.send'), (err) => err.reason === 'explicit-deny');
    await assert.rejects(host.invoke('payment.request'), (err) => err.reason === 'not-granted');
    await assert.rejects(host.invoke('camera.nope'), (err) => err.code === 'ERR_CAPABILITY_UNDECLARED');
    await assert.rejects(host.invoke('camera.takePhoto'), PluginCrashError);
    assert.equal((await host.invoke('camera.takePhoto')).mock, true);

    assert.deepEqual(host.audit(), [
      { seq: 1, capability: 'camera.takePhoto', decision: 'allowed', reason: 'granted' },
      { seq: 2, capability: 'share.send', decision: 'denied', reason: 'explicit-deny' },
      { seq: 3, capability: 'payment.request', decision: 'denied', reason: 'not-granted' },
      { seq: 4, capability: 'camera.nope', decision: 'denied', reason: 'undeclared' },
      { seq: 5, capability: 'camera.takePhoto', decision: 'error', reason: 'ERR_PLUGIN_CRASH' },
      { seq: 6, capability: 'camera.takePhoto', decision: 'allowed', reason: 'granted' },
    ]);
    for (const entry of host.audit()) {
      assert.deepEqual(Object.keys(entry), ['seq', 'capability', 'decision', 'reason']);
      assert.ok(Object.isFrozen(entry));
    }
    const snapshot = host.audit();
    snapshot.pop();
    assert.equal(host.audit().length, 6);
    assert.throws(() => { snapshot[0].seq = 99; }, TypeError);
  });
});

test('the audit trail is bounded and append-only across its limit', async () => {
  await withHost({}, async (host) => {
    for (let index = 0; index < AUDIT_LIMIT + 5; index += 1) {
      await assert.rejects(host.invoke('payment.request'));
    }
    const entries = host.audit();
    assert.equal(entries.length, AUDIT_LIMIT);
    assert.equal(entries[0].seq, 6);
    assert.equal(entries.at(-1).seq, AUDIT_LIMIT + 5);
    assert.ok(entries.every((entry, index) => entry.seq === entries[0].seq + index));
    assert.ok(entries.every((entry) => entry.decision === 'denied' && entry.reason === 'not-granted'));

    assert.equal((await host.invoke('camera.takePhoto')).mock, true);
    const after = host.audit();
    assert.equal(after.length, AUDIT_LIMIT);
    assert.equal(after[0].seq, 7);
    assert.deepEqual(after.at(-1), {
      seq: AUDIT_LIMIT + 6,
      capability: 'camera.takePhoto',
      decision: 'allowed',
      reason: 'granted',
    });
    assert.deepEqual(after.slice(0, -1), entries.slice(1));
  });
});

test('an isolated plugin fault and an open circuit are recorded as errors', async () => {
  await withHost({ schedule: 'crash', threshold: 1, cooldownMs: 60000 }, async (host) => {
    await assert.rejects(host.invoke('camera.takePhoto'), PluginCrashError);
    await assert.rejects(host.invoke('camera.takePhoto'), CircuitOpenError);
    await assert.rejects(host.invoke('camera.takePhoto', []), /params must be a JSON object/);
    assert.equal(host.spawnCount, 1);
    assert.deepEqual(host.audit(), [
      { seq: 1, capability: 'camera.takePhoto', decision: 'error', reason: 'ERR_PLUGIN_CRASH' },
      { seq: 2, capability: 'camera.takePhoto', decision: 'error', reason: 'ERR_CIRCUIT_OPEN' },
      { seq: 3, capability: 'camera.takePhoto', decision: 'error', reason: 'ERR_CAPABILITY_HOST' },
    ]);
  });
});
