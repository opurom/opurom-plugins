#!/usr/bin/env node
// OPUROM plugin CLI: list | verify | invoke. Node builtins only.
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';
import {
  DEFAULT_TIMEOUT_MS,
  ROOT,
  buildPlugins,
  handshake,
  invokeCapability,
  loadRegistry,
  parseBinaryOverrides,
  resolveEntry,
  resolveTimeout,
  readManifest,
  validateRegistryEntry,
  verifyEntry,
} from '../lib/host.mjs';

const USAGE = `usage: opurom-plugin <command>

  list                              show the plugins in registry.json
  verify                            check every registry entry (manifest, executable, handshake, invoke)
  invoke <plugin> <capability> [json-params]
                                    invoke a capability and print the JSON result

environment:
  OPR_PLUGIN_BIN      "camera=/abs/path,storage=/abs/path" overrides plugin executables
  OPR_PLUGIN_TIMEOUT_MS  request timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, bounded 50..5000)`;

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

async function commandList(root) {
  const { registry, errors } = loadRegistry(root);
  if (!registry) {
    for (const err of errors) process.stderr.write(`error: ${err}\n`);
    process.exit(1);
  }
  const rows = [['NAME', 'VERSION', 'CAPABILITIES', 'PATH']];
  for (const entry of registry.plugins) {
    rows.push([
      String(entry.name ?? ''),
      String(entry.version ?? ''),
      (Array.isArray(entry.capabilities) ? entry.capabilities : []).join(','),
      String(entry.path ?? ''),
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    process.stdout.write(
      `${row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()}\n`,
    );
  }
  process.exit(0);
}

async function commandVerify(root, options) {
  const { registry, errors } = loadRegistry(root);
  if (!registry) {
    for (const err of errors) process.stderr.write(`FAIL  <registry>  ${err}\n`);
    process.exit(1);
  }
  const results = [];
  for (const entry of registry.plugins) {
    const result = await verifyEntry(entry, root, options);
    results.push(result);
    const label = result.ok ? 'PASS' : 'FAIL';
    if (result.ok) {
      process.stdout.write(`${label}  ${result.name}  ${result.capabilities.join(', ')}\n`);
    } else {
      process.stdout.write(`${label}  ${result.name}\n`);
      for (const err of result.errors) process.stdout.write(`      ${err}\n`);
    }
  }
  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} plugins verified\n`);
  process.exit(failed === 0 ? 0 : 1);
}

async function commandInvoke(root, pluginName, capability, paramParts, options) {
  const { registry, errors } = loadRegistry(root);
  if (!registry) {
    for (const err of errors) fail(err);
  }
  const entry = registry.plugins.find((item) => item.name === pluginName);
  if (!entry) {
    fail(`unknown plugin: ${pluginName}`);
  }
  const entryErrors = validateRegistryEntry(entry, root);
  if (entryErrors.length > 0) {
    fail(entryErrors.join('; '));
  }
  const pluginDir = path.resolve(root, entry.path);
  const { manifest, errors: manifestErrors } = readManifest(pluginDir);
  if (!manifest) fail(manifestErrors.join('; '));

  const override = options.overrides.get(entry.name);
  let binary;
  if (override) {
    binary = path.resolve(root, override);
  } else {
    const resolved = resolveEntry(pluginDir, manifest.entry);
    if (resolved.errors.length > 0) fail(resolved.errors.join('; '));
    binary = resolved.file;
    if (!existsSync(binary)) {
      const build = buildPlugins(root);
      if (!build.ok) fail(`cannot build the plugins: ${build.error}`);
    }
  }

  let params = {};
  const paramsText = paramParts.join(' ').trim();
  if (paramsText.length > 0) {
    try {
      params = JSON.parse(paramsText);
    } catch (err) {
      fail(`params are not valid JSON: ${err.message}`);
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      fail('params must be a JSON object');
    }
  }

  const result = await invokeCapability(binary, capability, params, options);
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: result.error })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(result.result)}\n`);
  process.exit(0);
}

async function main(argv) {
  const root = ROOT;
  const overrides = parseBinaryOverrides(process.env.OPR_PLUGIN_BIN);
  const timeoutMs = resolveTimeout(process.env.OPR_PLUGIN_TIMEOUT_MS);
  const options = { overrides, timeoutMs };
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(command ? 0 : 2);
  }
  if (command === 'list') {
    await commandList(root);
  }
  if (command === 'verify') {
    await commandVerify(root, options);
  }
  if (command === 'invoke') {
    const [pluginName, capability, ...paramParts] = rest;
    if (!pluginName || !capability) {
      fail('invoke needs <plugin> <capability> [json-params]');
    }
    await commandInvoke(root, pluginName, capability, paramParts, options);
  }
  fail(`unknown command: ${command}\n${USAGE}`, 2);
}

main(process.argv.slice(2)).catch((err) => {
  fail(err?.stack ?? String(err));
});
