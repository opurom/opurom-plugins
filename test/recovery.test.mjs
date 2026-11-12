import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { Plugin, resolveTimeout } from '../lib/host.mjs';
import { ROOT } from '../test-support/helpers.mjs';

const SLOW_STUB = path.join(ROOT, 'test-fixtures', 'slow-plugin.mjs');
const WRONG_ID_STUB = path.join(ROOT, 'test-fixtures', 'wrong-id-plugin.mjs');
const CAMERA = path.join(ROOT, 'plugins', 'camera', 'bin', 'camera');

test('a malformed request line is answered with an error, not a crash', async () => {
  const plugin = new Plugin(CAMERA, 1000);
  try {
    plugin.child.stdin.write('this is not json\n');
    const response = JSON.parse(await plugin.nextLine());
    assert.equal(response.ok, false);
    assert.match(response.error, /malformed JSON/);
    // The plugin is still alive and still serves requests.
    const hello = await plugin.request({ id: 7, method: 'hello', protocol: '1.0' });
    assert.equal(hello.ok, true);
    assert.equal(hello.id, 7);
  } finally {
    plugin.close();
  }
});

test('a malformed request keeps the request id when one can be salvaged', async () => {
  const plugin = new Plugin(CAMERA, 1000);
  try {
    plugin.child.stdin.write('{"id":42,"method":\n');
    const response = JSON.parse(await plugin.nextLine());
    assert.equal(response.ok, false);
    assert.equal(response.id, 42);
  } finally {
    plugin.close();
  }
});

test('an unknown method is reported as an error', async () => {
  const plugin = new Plugin(CAMERA, 1000);
  try {
    const response = await plugin.request({ id: 3, method: 'nonsense' });
    assert.equal(response.ok, false);
    assert.equal(response.id, 3);
    assert.match(response.error, /unknown method/);
  } finally {
    plugin.close();
  }
});

test('a plugin that never answers hits the timeout instead of hanging', async () => {
  const plugin = new Plugin(SLOW_STUB, 120);
  try {
    const hello = await plugin.request({ id: 0, method: 'hello', protocol: '1.0' });
    assert.equal(hello.ok, true);
    await assert.rejects(
      () => plugin.request({ id: 1, method: 'invoke', capability: 'slow.never', params: {} }),
      /timeout after 120 ms/,
    );
  } finally {
    plugin.close();
  }
});

test('the timeout is bounded and never infinite', () => {
  assert.equal(resolveTimeout(1), 50);
  assert.equal(resolveTimeout(100000), 5000);
});

test('a response with the wrong id is a protocol violation', async () => {
  const plugin = new Plugin(WRONG_ID_STUB, 1000);
  try {
    await assert.rejects(
      () => plugin.request({ id: 5, method: 'hello', protocol: '1.0' }),
      /does not match request id/,
    );
  } finally {
    plugin.close();
  }
});

test('a plugin that exits early is reported instead of hanging', async () => {
  const plugin = new Plugin('/bin/echo', 1000);
  try {
    await assert.rejects(
      () => plugin.request({ id: 0, method: 'hello', protocol: '1.0' }),
      /plugin exited|invalid JSON response|does not match request id/,
    );
  } finally {
    plugin.close();
  }
});
