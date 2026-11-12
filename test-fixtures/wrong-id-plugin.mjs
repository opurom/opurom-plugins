#!/usr/bin/env node
// Test-only plugin stub: writes a valid hello response with the wrong id.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      id: request.id + 100,
      ok: true,
      result: { name: 'wrongid', version: '0.0.0', capabilities: [] },
    })}\n`,
  );
});
