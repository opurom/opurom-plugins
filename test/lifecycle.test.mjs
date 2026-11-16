// Graceful shutdown lifecycle: close() sends the protocol `shutdown` request,
// lets a well-behaved plugin exit on its own, and force-kills a stubborn one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Plugin, ROOT, SHUTDOWN_GRACE_MS } from '../lib/host.mjs';

const FIXTURE = path.join(ROOT, 'test-fixtures', 'capability-plugin.mjs');
const STUBBORN = path.join(ROOT, 'test-fixtures', 'stubborn-plugin.mjs');
const CAMERA = path.join(ROOT, 'plugins', 'camera', 'bin', 'camera');

function watchExit(plugin) {
  return new Promise((resolve) => {
    plugin.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('close sends the protocol shutdown request before reaping the process', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'opurom-shutdown-'));
  try {
    const plugin = new Plugin(FIXTURE, 1000, {
      env: {
        ...process.env,
        OPR_TEST_STATE_DIR: stateDir,
        OPR_TEST_PLUGIN: 'camera',
        OPR_TEST_CAPABILITIES: 'camera.takePhoto',
      },
    });
    const exit = watchExit(plugin);
    const hello = await plugin.request({ id: 0, method: 'hello', protocol: '1.0' });
    assert.equal(hello.ok, true);
    await plugin.close();
    const outcome = await exit;
    assert.equal(outcome.signal, null, 'plugin must exit on its own, not be killed');
    assert.equal(outcome.code, 0);
    assert.equal(readFileSync(path.join(stateDir, 'shutdown'), 'utf8').trim(), 'yes');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a real plugin exits on its own after shutdown instead of being killed', async () => {
  const plugin = new Plugin(CAMERA, 2000);
  const exit = watchExit(plugin);
  const hello = await plugin.request({ id: 0, method: 'hello', protocol: '1.0' });
  assert.equal(hello.ok, true, hello.error);
  // close stays idempotent: a second call must not disturb an exiting plugin.
  await plugin.close();
  await plugin.close();
  const outcome = await exit;
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 0);
});

test('a plugin that ignores shutdown is force-killed after the grace period', async () => {
  const plugin = new Plugin(STUBBORN, 5000);
  const exit = watchExit(plugin);
  const hello = await plugin.request({ id: 0, method: 'hello', protocol: '1.0' });
  assert.equal(hello.ok, true, hello.error);
  const started = Date.now();
  await plugin.close();
  const elapsed = Date.now() - started;
  const outcome = await exit;
  assert.equal(outcome.signal, 'SIGKILL');
  // The grace period must elapse first; an immediate kill would drop cleanup time.
  assert.ok(elapsed >= SHUTDOWN_GRACE_MS - 50, `force-kill waited only ${elapsed} ms`);
  assert.ok(elapsed < SHUTDOWN_GRACE_MS + 5000, `force-kill waited ${elapsed} ms`);
});
