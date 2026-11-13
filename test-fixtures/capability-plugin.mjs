#!/usr/bin/env node
// Test-only mock-device plugin: deterministic replies, scheduled crashes/frames.
// It writes a marker and its PID on startup so permission denial is observable.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const stateDir = process.env.OPR_TEST_STATE_DIR ?? process.cwd();
const pluginName = process.env.OPR_TEST_PLUGIN ?? 'camera';
const capabilities = (process.env.OPR_TEST_CAPABILITIES ?? [
  'camera.takePhoto',
  'geolocation.getCurrentPosition',
  'bluetooth.scan',
  'notification.show',
  'payment.request',
  'share.send',
].join(',')).split(',').filter(Boolean);
const results = {
  'camera.takePhoto': { path: '/mock/camera/photo.png', quality: 'high', width: 640, height: 480, mock: true },
  'geolocation.getCurrentPosition': { latitude: 37.7749, longitude: -122.4194, accuracy: 5, mock: true },
  'bluetooth.scan': { devices: [{ id: 'mock-beacon-1', rssi: -42 }], mock: true },
  'notification.show': { delivered: true, id: 'mock-notification-1', mock: true },
  'payment.request': { approved: true, transaction: 'mock-payment-1', mock: true },
  'share.send': { shared: true, target: 'mock-share-sheet', mock: true },
};

writeFileSync(path.join(stateDir, 'started'), 'yes\n');
appendFileSync(path.join(stateDir, 'pids'), `${process.pid}\n`);

function nextCount() {
  const file = path.join(stateDir, 'count');
  const count = existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) + 1 : 1;
  writeFileSync(file, `${count}\n`);
  return count;
}

function behavior(index) {
  const file = path.join(stateDir, 'schedule');
  const schedule = existsSync(file) ? readFileSync(file, 'utf8').trim().split(',') : ['ok'];
  return schedule[Math.min(index, schedule.length) - 1] ?? 'ok';
}

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === 'hello') {
    reply({ id: request.id, ok: true, result: { name: pluginName, version: '0.1.0', capabilities } });
    return;
  }
  if (request.method !== 'invoke') {
    reply({ id: request.id, ok: false, error: 'unknown method' });
    return;
  }
  switch (behavior(nextCount())) {
    case 'crash':
      process.exit(7);
      break;
    case 'garbage':
      process.stdout.write(`{"id":${request.id},"ok":\n`);
      return;
    case 'hang':
      // Deliberately never replies so the host exercises its invocation timeout.
      return;
    default:
      break;
  }
  const result = results[request.capability];
  if (!result) {
    reply({ id: request.id, ok: false, error: `unknown capability: ${request.capability}` });
  } else {
    reply({ id: request.id, ok: true, result });
  }
});
