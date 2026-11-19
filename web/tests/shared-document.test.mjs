import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyChange, selectSharedPlate } from '../src/persist/shared-document.ts';

const document = () => ({
  plateIndex: 1, objects: [{ id: 1, x: 0 }], events: [], selected: { object: 1 },
  projectPlates: [
    { index: 1, objects: [{ id: 1, x: 0 }], events: [] },
    { index: 2, objects: [{ id: 2, x: 10 }], events: [{ z: 5, type: 'pause' }] },
  ],
});

test('restore the sliced plate without losing the other plate', () => {
  const original = document();
  original.objects[0].x = 4;
  const restored = selectSharedPlate(original, 2);
  assert.equal(restored.plateIndex, 2);
  assert.deepEqual(restored.objects, [{ id: 2, x: 10 }]);
  assert.deepEqual(restored.events, [{ z: 5, type: 'pause' }]);
  assert.equal(restored.projectPlates[0].objects[0].x, 4);
  assert.equal(original.plateIndex, 1);
  assert.throws(() => selectSharedPlate(original, 0), /plate information/);
  assert.throws(() => selectSharedPlate(original, 3), /missing/);
});

test('undo and redo plate selection preserve remote object edits', () => {
  const before = document(), after = selectSharedPlate(before, 2);
  const current = structuredClone(after);
  current.objects[0].x = 99;
  const undone = historyChange(after, before, current);
  assert.equal(undone.doc.plateIndex, 1);
  assert.deepEqual(undone.doc.selected, before.selected);
  assert.equal(undone.doc.projectPlates[1].objects[0].x, 99);
  const redone = historyChange(before, after, undone.doc);
  assert.equal(redone.doc.plateIndex, 2);
  assert.equal(redone.doc.objects[0].x, 99);
});

test('undo rejects conflicting edits and a deleted navigation target', () => {
  const before = document(), after = { ...before, objects: [{ id: 1, x: 3 }] };
  assert.equal(historyChange(after, before, after).doc.objects[0].x, 0);
  assert.equal(historyChange(after, before, { ...after, objects: [{ id: 1, x: 4 }] }), null);
  const second = selectSharedPlate(before, 2);
  assert.equal(historyChange(second, before, { ...second, projectPlates: [second.projectPlates[1]] }), null);
});
