import assert from 'node:assert/strict';
import test from 'node:test';
import { orderImplementations, selectImplementation } from '../lib/implementations.mjs';

test('a single candidate is selected without needing a direct or default hint', () => {
  assert.deepEqual(selectImplementation('camera', ['camera-native']), {
    selected: 'camera-native',
    reason: 'unique',
    error: null,
  });
  assert.deepEqual(selectImplementation('camera', []), {
    selected: null,
    reason: 'none',
    error: null,
  });
});

test('a single direct dependency wins over a default package', () => {
  assert.deepEqual(
    selectImplementation('camera', ['camera-flutter', 'camera-native'], {
      direct: ['camera-native'],
      defaultPackage: 'camera-flutter',
    }),
    { selected: 'camera-native', reason: 'direct', error: null },
  );
});

test('the default package is used when no candidate is a direct dependency', () => {
  assert.deepEqual(
    selectImplementation('camera', ['camera-a', 'camera-b'], { defaultPackage: 'camera-b' }),
    { selected: 'camera-b', reason: 'default', error: null },
  );
  // A default outside the candidate set cannot force a choice.
  assert.equal(
    selectImplementation('camera', ['camera-a', 'camera-b'], { defaultPackage: 'camera-z' }).error.kind,
    'ambiguous',
  );
});

test('ambiguous choices and conflicting direct dependencies report errors', () => {
  const ambiguous = selectImplementation('camera', ['b', 'a']);
  assert.equal(ambiguous.selected, null);
  assert.equal(ambiguous.error.kind, 'ambiguous');
  assert.match(ambiguous.error.message, /a, b/, 'candidate order is byte-sorted');

  const conflict = selectImplementation('camera', ['b', 'a'], { direct: ['a', 'b'] });
  assert.equal(conflict.selected, null);
  assert.equal(conflict.error.kind, 'conflict');
  assert.match(conflict.error.message, /a, b/);
});

test('dependency order puts providers first and breaks ties by name', () => {
  const items = [
    { name: 'zeta', dependencies: ['alpha'] },
    { name: 'alpha' },
    { name: 'beta' },
  ];
  const first = orderImplementations(items);
  assert.deepEqual(first, ['alpha', 'beta', 'zeta']);
  assert.deepEqual(orderImplementations(items), first, 'repeated runs are identical');
});

test('a dependency cycle still yields one predictable order', () => {
  const items = [
    { name: 'c', dependencies: ['a'] },
    { name: 'a', dependencies: ['b'] },
    { name: 'b', dependencies: ['c'] },
  ];
  const first = orderImplementations(items);
  assert.equal(first.length, 3);
  assert.deepEqual([...first].sort(), ['a', 'b', 'c']);
  assert.deepEqual(orderImplementations(items), first, 'cycle handling is deterministic');
});

test('selection and ordering ignore duplicates and unknown dependency names', () => {
  const selected = selectImplementation('camera', ['b', 'a', 'b'], { direct: ['b', 'b'] });
  assert.deepEqual(selected, { selected: 'b', reason: 'direct', error: null });

  const order = orderImplementations([
    { name: 'a', dependencies: ['ghost', 'ghost'] },
    { name: 'b' },
  ]);
  assert.deepEqual(order, ['a', 'b']);
  assert.deepEqual(orderImplementations([{ name: 'a', dependencies: ['ghost'] }, { name: 'b' }]), order);
});
