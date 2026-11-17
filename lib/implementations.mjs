// Federated implementation selection helpers.
//
// The rules mirror the reference tool's resolver: pick one implementation per
// interface by priority (unique candidate, direct dependency, default package,
// otherwise fail), then order the chosen plugins by dependency topology.
// Everything here is pure: no I/O, no clock, no process spawn, byte-sorted
// tie-breaks, so the same input always produces the same output.

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Select one implementation for an interface from its candidate plugin names.
 *
 * Priority:
 *   1. a single candidate wins;
 *   2. a single candidate marked as a direct dependency wins;
 *   3. the declared default package wins when it is among the candidates;
 *   4. otherwise the choice is ambiguous and must be reported.
 * More than one direct dependency is a conflict, never an arbitrary pick.
 *
 * @param {string} interfaceName diagnostic name of the interface
 * @param {Iterable<string>} candidates plugin names implementing the interface
 * @param {{direct?: Iterable<string>, defaultPackage?: string|null}} options
 * @returns {{selected: string|null, reason: string|null, error: {kind: string, message: string}|null}}
 */
export function selectImplementation(interfaceName, candidates, options = {}) {
  const list = [...new Set(candidates)].sort(byteCompare);
  const direct = new Set(options.direct ?? []);
  const fallback = options.defaultPackage ?? null;

  if (list.length === 0) {
    return { selected: null, reason: 'none', error: null };
  }
  if (list.length === 1) {
    return { selected: list[0], reason: 'unique', error: null };
  }

  const directHits = list.filter((name) => direct.has(name));
  if (directHits.length === 1) {
    return { selected: directHits[0], reason: 'direct', error: null };
  }
  if (directHits.length > 1) {
    return {
      selected: null,
      reason: null,
      error: {
        kind: 'conflict',
        message: `${interfaceName} has conflicting direct implementations: ${directHits.join(', ')}`,
      },
    };
  }
  if (fallback !== null && list.includes(fallback)) {
    return { selected: fallback, reason: 'default', error: null };
  }
  return {
    selected: null,
    reason: null,
    error: {
      kind: 'ambiguous',
      message: `${interfaceName} has multiple implementations and no default: ${list.join(', ')}`,
    },
  };
}

/**
 * Order plugins so dependencies come before their consumers. Independent
 * entries are ordered by name. When the remaining entries form a cycle, the
 * one with the smallest in-degree (name as tie-break) is placed next, so a
 * cyclic input still yields one predictable order.
 *
 * @param {Iterable<{name: string, dependencies?: Iterable<string>}>} items
 * @returns {string[]} plugin names in load order
 */
export function orderImplementations(items) {
  const byName = new Map();
  for (const item of items) byName.set(item.name, item);
  const names = [...byName.keys()].sort(byteCompare);
  if (names.length === 0) return [];

  const inDegree = new Map();
  const dependents = new Map();
  for (const name of names) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }
  for (const name of names) {
    const dependencies = [...new Set(byName.get(name).dependencies ?? [])]
      .filter((dependency) => dependency !== name && byName.has(dependency))
      .sort(byteCompare);
    inDegree.set(name, dependencies.length);
    for (const dependency of dependencies) dependents.get(dependency).push(name);
  }

  const ready = names.filter((name) => inDegree.get(name) === 0);
  const order = [];
  const placed = new Set();
  while (placed.size < names.length) {
    if (ready.length === 0) {
      const remaining = names
        .filter((name) => !placed.has(name))
        .sort((left, right) => inDegree.get(left) - inDegree.get(right) || byteCompare(left, right));
      ready.push(remaining[0]);
    }
    const current = ready.shift();
    if (placed.has(current)) continue;
    placed.add(current);
    order.push(current);
    for (const dependent of dependents.get(current)) {
      const left = inDegree.get(dependent) - 1;
      inDegree.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
    ready.sort(byteCompare);
  }
  return order;
}
