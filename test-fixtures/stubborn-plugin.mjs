#!/usr/bin/env node
// Test-only stub: ignores shutdown and stdin EOF, so close() must force-kill it.
import readline from 'node:readline';

setInterval(() => {}, 1000);

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
        result: { name: 'stubborn', version: '0.0.0', capabilities: ['stubborn.never'] },
      })}\n`,
    );
  }
  // Every other request, including shutdown, is deliberately ignored.
});
