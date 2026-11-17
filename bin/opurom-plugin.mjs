#!/usr/bin/env node
// Opurom plugin CLI: list | verify | invoke. Node builtins only.
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';
import {
  DEFAULT_TIMEOUT_MS,
  ROOT,
  buildPlugins,
  checkProvenanceRecord,
  handshake,
  invokeCapability,
  loadRegistry,
  parseBinaryOverrides,
  resolveManifestEntry,
  resolveLoadOrder,
  resolveTimeout,
  readManifest,
  validateRegistryEntry,
  verifyEntry,
} from '../lib/host.mjs';
import { CapabilityHost } from '../lib/capabilities.mjs';
import {
  MARKET_ROOT,
  installMarketPackage,
  listMarket,
  listMarketGithub,
  planInstall,
  resolveMarketPackage,
  searchMarket,
} from '../lib/market.mjs';

const USAGE = `usage: opurom-plugin <command>

  list                              show the plugins in registry.json
  verify                            check every registry entry (manifest, executable, handshake, invoke)
  invoke <plugin> <capability> [json-params] [--grant csv] [--deny csv]
                                    invoke; --grant/--deny use the permission host
  market list [query]               list (or search) packages in the opurom-pkg registry
  market list --github <owner/repo> [query]
                                    opt-in GitHub discovery; degrades to local order offline
  market resolve <name> <version>   resolve a package to its files and sha256 digests
  market plan <name> <version> [--grant csv] [--deny csv]
                                    resolve an install plan, gated by the permission host
  market install <name> <version> --source owner/repo [--grant csv] [--deny csv]
                                    verify and atomically install a signed package

environment:
  OPR_PLUGIN_BIN      "camera=/abs/path,storage=/abs/path" overrides plugin executables
  OPR_PLUGIN_TIMEOUT_MS  request timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, bounded 50..5000)
  OPR_MARKET_ROOT     directory of the opurom-pkg registry layout (default ${MARKET_ROOT})`;

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function splitList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/** Pull --grant/--deny out of the optional invoke arguments without disturbing JSON params. */
function parseInvokeArgs(parts) {
  const params = [];
  let grants = null;
  let denies = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--grant' || part === '--deny') {
      if (index + 1 >= parts.length) fail(`${part} needs a comma-separated capability list`);
      const list = splitList(parts[index + 1]);
      if (part === '--grant') grants = list;
      else denies = list;
      index += 1;
    } else if (part.startsWith('--grant=')) {
      grants = splitList(part.slice('--grant='.length));
    } else if (part.startsWith('--deny=')) {
      denies = splitList(part.slice('--deny='.length));
    } else {
      params.push(part);
    }
  }
  return { params, grants, denies };
}

function capabilityError(err) {
  const error = { code: err.code ?? 'ERR_UNKNOWN', message: err.message };
  for (const key of ['capability', 'reason', 'plugin', 'retryAfterMs', 'errors']) {
    if (err[key] !== undefined) error[key] = err[key];
  }
  return error;
}

async function commandList(root) {
  const { registry, errors } = loadRegistry(root);
  if (!registry) {
    for (const err of errors) process.stderr.write(`error: ${err}\n`);
    process.exit(1);
  }
  const rows = [['NAME', 'VERSION', 'CAPABILITIES', 'AUTHOR', 'REPOSITORY', 'LICENSE', 'PATH']];
  for (const entry of registry.plugins) {
    const { manifest } = readManifest(path.resolve(root, entry.path));
    rows.push([
      String(entry.name ?? ''),
      String(entry.version ?? ''),
      (Array.isArray(entry.capabilities) ? entry.capabilities : []).join(','),
      String(manifest?.author ?? ''),
      String(manifest?.repository ?? ''),
      String(manifest?.license ?? ''),
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
  // Spec dependency graph: dependencies verify first, and a plugin whose
  // dependency failed verification is reported without being spawned.
  const plugins = registry.plugins.map((entry) => ({
    ...entry,
    dependencies: readManifest(path.resolve(root, entry.path)).manifest?.dependencies ?? [],
  }));
  const { order, errors: graphErrors } = resolveLoadOrder({ version: registry.version, plugins });
  if (graphErrors.length > 0) {
    for (const err of graphErrors) process.stderr.write(`FAIL  <graph>  ${err.message}\n`);
    process.exit(1);
  }
  const byName = new Map(registry.plugins.map((entry) => [entry.name, entry]));
  const results = [];
  const failedNames = new Set();
  for (const name of order) {
    const entry = byName.get(name);
    if (entry.provenance) {
      try {
        checkProvenanceRecord(entry, root, {});
      } catch (err) {
        results.push({ name, ok: false, capabilities: entry.capabilities ?? [] });
        process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
        failedNames.add(name);
        continue;
      }
    }
    const brokenDependency = (entry.dependencies ?? []).find((dep) => failedNames.has(dep));
    if (brokenDependency) {
      failedNames.add(name);
      results.push({ name, ok: false, capabilities: entry.capabilities ?? [] });
      process.stdout.write(`FAIL  ${name}\n      dependency ${brokenDependency} failed verification\n`);
      continue;
    }
    const result = await verifyEntry(entry, root, options);
    results.push(result);
    if (!result.ok) failedNames.add(name);
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

  if (options.grants !== null || options.denies.length > 0) {
    let host = null;
    let code = 0;
    try {
      host = new CapabilityHost({
        permissions: { allow: options.grants ?? [], deny: options.denies },
        root,
        overrides: options.overrides,
        timeoutMs: options.timeoutMs,
      });
      const result = await host.invoke(capability, params);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: capabilityError(err) })}\n`);
      code = 1;
    }
    if (host) await host.close();
    process.exit(code);
  }

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
    const resolved = resolveManifestEntry(pluginDir, manifest);
    if (resolved.errors.length > 0) fail(resolved.errors.join('; '));
    binary = resolved.file;
    if (!existsSync(binary)) {
      const build = buildPlugins(root);
      if (!build.ok) fail(`cannot build the plugins: ${build.error}`);
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

async function commandMarket(root, rest, options) {
  const registryRoot = process.env.OPR_MARKET_ROOT
    ? path.resolve(process.env.OPR_MARKET_ROOT)
    : MARKET_ROOT;
  const [subcommand, ...args] = rest;
  const marketOptions = { registryRoot, timeoutMs: options.timeoutMs, deny: options.denies };
  if (subcommand === 'list') {
    let query = args[0] ?? null;
    let repository = null;
    if (args[0] === '--github') {
      repository = args[1];
      query = args[2] ?? null;
      if (!repository) fail('market list --github needs <owner/repo>');
    }
    if (repository) {
      const result = await listMarketGithub(repository, { ...marketOptions, query });
      if (result.notice) process.stderr.write(`${result.notice}\n`);
      process.stdout.write(`${JSON.stringify(result.packages)}\n`);
      process.exit(0);
    }
    const rows = query ? searchMarket(query, marketOptions) : listMarket(marketOptions);
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    process.exit(0);
  }
  if (subcommand === 'install') {
    const [name, version] = args;
    const sourceIndex = args.indexOf('--source');
    const source = sourceIndex >= 0 ? args[sourceIndex + 1] : null;
    if (!name || !version || !source) fail('market install needs <name> <version> --source owner/repo');
    let host = null;
    try {
      host = new CapabilityHost({
        permissions: { allow: options.grants ?? [], deny: options.denies },
        root,
        overrides: options.overrides,
        timeoutMs: options.timeoutMs,
      });
      const installed = installMarketPackage(name, version, host, {
        ...marketOptions,
        root,
        source,
      });
      process.stdout.write(`${JSON.stringify(installed)}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: capabilityError(err) })}\n`);
      process.exitCode = 1;
    }
    if (host) await host.close();
    process.exit(process.exitCode ?? 0);
  }
  if (subcommand === 'resolve' || subcommand === 'plan') {
    const [name, version] = args;
    if (!name || !version) fail(`market ${subcommand} needs <name> <version>`);
    let host = null;
    try {
      let plan;
      if (subcommand === 'plan') {
        host = new CapabilityHost({
          permissions: { allow: options.grants ?? [], deny: options.denies },
          root,
          overrides: options.overrides,
          timeoutMs: options.timeoutMs,
        });
        plan = planInstall(name, version, host, marketOptions);
      } else {
        plan = resolveMarketPackage(name, version, marketOptions);
      }
      process.stdout.write(`${JSON.stringify(plan)}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: capabilityError(err) })}\n`);
      process.exitCode = 1;
    }
    if (host) await host.close();
    process.exit(process.exitCode ?? 0);
  }
  fail(`unknown market subcommand: ${subcommand ?? '<none>'}`);
}

async function main(argv) {
  const root = ROOT;
  const overrides = parseBinaryOverrides(process.env.OPR_PLUGIN_BIN);
  const timeoutMs = resolveTimeout(process.env.OPR_PLUGIN_TIMEOUT_MS);
  const options = { overrides, timeoutMs, grants: null, denies: [] };
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
    const [pluginName, capability, ...rawParams] = rest;
    if (!pluginName || !capability) {
      fail('invoke needs <plugin> <capability> [json-params]');
    }
    const { params, grants, denies } = parseInvokeArgs(rawParams);
    await commandInvoke(root, pluginName, capability, params, { ...options, grants, denies });
  }
  if (command === 'market') {
    const { params, grants, denies } = parseInvokeArgs(rest.slice(1));
    await commandMarket(root, [rest[0], ...params], { ...options, grants, denies });
  }
  fail(`unknown command: ${command}\n${USAGE}`, 2);
}

main(process.argv.slice(2)).catch((err) => {
  fail(err?.stack ?? String(err));
});
