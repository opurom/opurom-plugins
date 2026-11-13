// Invocation timeout enforcement: over-budget invocations are terminated with a
// typed error, the host stays usable, and a bad timeout is rejected at config time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CapabilityHost } from '../lib/capabilities.mjs';
import { Plugin, PluginConfigError, PluginTimeoutError, ROOT } from '../lib/host.mjs';

const FIXTURE = path.join(ROOT, 'test-fixtures', 'capability-plugin.mjs');
const CAMERA = path.join(ROOT, 'plugins', 'camera', 'bin', 'camera');

async function withHost(schedule, timeoutMs, fn) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'opurom-timeout-'));
  writeFileSync(path.join(stateDir, 'schedule'), `${schedule}\n`);
  const host = new CapabilityHost({
    permissions: { allow: ['camera.takePhoto'], deny: [] },
    root: ROOT,
    overrides: new Map([['camera', FIXTURE]]),
    timeoutMs,
    threshold: 3,
    clock: Date.now,
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

test('an invocation that exceeds its budget is terminated and the host stays usable', async () => {
  await withHost('hang,ok', 120, async ({ host, stateDir }) => {
    await assert.rejects(
      () => host.invoke('camera.takePhoto'),
      (err) => {
        assert.ok(err instanceof PluginTimeoutError);
        assert.equal(err.code, 'ERR_PLUGIN_TIMEOUT');
        assert.match(err.message, /timeout after 120 ms/);
        return true;
      },
    );
    // The timeout feeds the same failure accounting as a crash.
    assert.equal(host.consecutiveFailures('camera'), 1);
    // The host keeps serving: the next invocation spawns a fresh process and succeeds.
    const result = await host.invoke('camera.takePhoto');
    assert.equal(result.mock, true);
    assert.equal(host.consecutiveFailures('camera'), 0);
    await host.close();
    // Both spawned children, including the one that hung, were actually terminated.
    const pids = readFileSync(path.join(stateDir, 'pids'), 'utf8')
      .trim()
      .split('\n')
      .map(Number)
      .filter(Boolean);
    assert.equal(pids.length, 2);
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), /ESRCH/, `plugin pid ${pid} is still alive`);
    }
  });
});

test('a zero or negative timeout is rejected when the host is configured', () => {
  for (const bad of [0, -1, -5000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        new CapabilityHost({
          permissions: { allow: ['camera.takePhoto'], deny: [] },
          root: ROOT,
          timeoutMs: bad,
        }),
      (err) => {
        assert.ok(err instanceof PluginConfigError);
        assert.equal(err.code, 'ERR_PLUGIN_CONFIG');
        assert.match(err.message, /timeoutMs must be a positive finite number/);
        return true;
      },
      `timeoutMs ${String(bad)} must be rejected`,
    );
  }
});

test('a positive timeout below the protocol floor still clamps instead of failing', () => {
  const host = new CapabilityHost({
    permissions: { allow: ['camera.takePhoto'], deny: [] },
    root: ROOT,
    timeoutMs: 10,
  });
  assert.equal(host.timeoutMs, 50);
});

test('a zero or negative timeout is rejected when a plugin transport is constructed', () => {
  for (const bad of [0, -1, Number.NaN]) {
    assert.throws(() => new Plugin(CAMERA, bad), PluginConfigError, `timeoutMs ${String(bad)}`);
  }
});
