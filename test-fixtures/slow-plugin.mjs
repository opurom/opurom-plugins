#!/usr/bin/env node
// Test-only plugin stub: answers hello but never replies to invoke.
// Used to exercise the host timeout path. Never shipped as a real plugin.
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
        result: { name: 'slow', version: '0.0.0', capabilities: ['slow.never'] },
      })}\n`,
    );
  }
  // Every other request is deliberately ignored so the host hits its timeout.
});
