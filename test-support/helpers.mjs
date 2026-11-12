// Shared test helpers: locate plugin directories and run the CLI.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'bin', 'opurom-plugin.mjs');

const execFileAsync = promisify(execFile);

/** Run the CLI and never throw: the exit code is part of what the tests assert. */
export async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      timeout: 30000,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
