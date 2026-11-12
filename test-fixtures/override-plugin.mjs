#!/usr/bin/env node
// Test-only plugin stub: stands in for the camera plugin via OPR_PLUGIN_BIN.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === 'hello') {
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        ok: true,
        result: { name: 'camera', version: '0.1.0', capabilities: ['camera.takePhoto'] },
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ id: request.id, ok: true, result: { overridden: true } })}\n`,
  );
});
