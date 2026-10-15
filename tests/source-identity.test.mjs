import test from 'node:test';
import assert from 'node:assert/strict';
import { blockSourceMatches, buildSourceHash, fingerprintMessage, reconcileMemorySources, findCurrentMessage } from '../lib/source-identity.mjs';
import { normalizeMemory, parseStructuredSummary, commitSummaryRollup, editMemoryBlock } from '../lib/core.mjs';

const chat = Array.from({ length: 8 }, (_, index) => ({ index, name: 'Mira', mes: `Original ${index}`, is_user: index % 2 === 1 }));
const structured = parseStructuredSummary({ narrative: 'Valid summary', relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
function block(id, from, to, extra = {}) {
  const sourceFingerprints = chat.slice(from, to + 1).map(fingerprintMessage);
  return { id, sourceFrom: from, sourceTo: to, sourceFingerprints, sourceHash: buildSourceHash(sourceFingerprints), status: 'active', children: [], structured, ...extra };
}
const memory = blocks => normalizeMemory({ schemaVersion: 3, blocks });

test('one edited source invalidates its block, preserving unrelated memory and fingerprints', () => {
  const stored = memory([block('a', 0, 1), block('b', 2, 3), block('c', 4, 5)]);
  const edited = structuredClone(chat); edited[2].mes = 'Changed';
  const result = reconcileMemorySources(stored, edited);
  assert.deepEqual(result.changedIds, ['b']);
  assert.deepEqual(result.memory.blocks.map(item => item.status), ['active', 'stale', 'active']);
  assert.equal(result.memory.blocks[1].sourceFingerprints.length, 2);
});

test('legacy blanket invalidation recovers identical ranges from retained aggregate hashes', () => {
  const stored = memory([block('a', 0, 1, { status: 'stale', sourceFingerprints: [] }), block('b', 2, 3, { status: 'stale', sourceFingerprints: [] })]);
  const before = JSON.stringify(stored.blocks.map(item => item.structured));
  const result = reconcileMemorySources(stored, chat);
  assert.deepEqual(result.recoveredIds, ['a', 'b']);
  assert.ok(result.memory.blocks.every(item => item.status === 'active' && item.sourceFingerprints.length === 2));
  assert.equal(JSON.stringify(stored.blocks.map(item => item.structured)), before);
  assert.deepEqual(reconcileMemorySources(stored, chat).recoveredIds, []);
});

test('changed, missing and unverifiable legacy sources stay archived', () => {
  for (const source of [chat.map((item, i) => i === 1 ? { ...item, mes: 'Edited' } : item), chat.slice(2)]) {
    const result = reconcileMemorySources(memory([block('a', 0, 1, { status: 'stale', sourceFingerprints: [] })]), source);
    assert.deepEqual(result.recoveredIds, []);
  }
  const result = reconcileMemorySources(memory([block('a', 0, 1, { status: 'stale', sourceFingerprints: [], sourceHash: '' })]), chat);
  assert.deepEqual(result.recoveredIds, []);
});

test('a removed stable ID cannot match an unrelated message at the same index', () => {
  assert.equal(findCurrentMessage(chat, { id: 'deleted-id', index: 0 }), undefined);
});

test('rollup recovery does not resurrect overlapping obsolete summaries or its children', () => {
  const stored = memory([block('a', 0, 1, { status: 'retired', sourceFingerprints: [] }), block('b', 2, 3, { status: 'retired', sourceFingerprints: [] }), block('ab', 0, 3, { level: 2, status: 'stale', sourceFingerprints: [], children: ['a', 'b'] }), block('obsolete', 0, 1, { status: 'stale', sourceFingerprints: [] })]);
  const result = reconcileMemorySources(stored, chat);
  assert.deepEqual(result.recoveredIds, ['ab']);
  assert.deepEqual(result.memory.blocks.map(item => item.status), ['retired', 'retired', 'active', 'stale']);
});

test('intentionally invalidated rollups remain archived after a summary edit', () => {
  const stored = memory([block('a', 0, 1), block('b', 2, 3)]);
  const merged = commitSummaryRollup(stored, block('ab', 0, 3, { level: 2 }), ['a', 'b']);
  const edited = editMemoryBlock(merged, 'a', { ...structured, narrative: 'Edited summary' });
  const result = reconcileMemorySources(edited.memory, chat);
  assert.deepEqual(result.recoveredIds, []);
  assert.equal(result.memory.blocks.find(item => item.id === 'ab').status, 'stale');
});

test('legacy rollup with active children is ambiguous and stays archived', () => {
  const result = reconcileMemorySources(memory([block('a', 0, 1), block('b', 2, 3), block('ab', 0, 3, { level: 2, status: 'stale', sourceFingerprints: [], children: ['a', 'b'] })]), chat);
  assert.deepEqual(result.recoveredIds, []);
});

test('retirement preserves source evidence for independent child validation', () => {
  const merged = commitSummaryRollup(memory([block('a', 0, 1), block('b', 2, 3)]), block('ab', 0, 3, { level: 2 }), ['a', 'b']);
  assert.ok(blockSourceMatches(merged.blocks[0], chat));
  const edited = structuredClone(chat); edited[2].mes = 'Changed';
  const result = reconcileMemorySources(merged, edited);
  assert.deepEqual(result.changedIds, ['ab']);
  assert.equal(result.memory.blocks.find(item => item.id === 'a').status, 'active');
  assert.equal(result.memory.blocks.find(item => item.id === 'b').status, 'retired');
});


test('incomplete legacy fingerprints cannot prove recovery of an entire source range', () => {
  const partial = block('partial', 0, 3, { status: 'stale', sourceFingerprints: [fingerprintMessage(chat[0])], sourceHash: buildSourceHash([fingerprintMessage(chat[0])]) });
  assert.deepEqual(reconcileMemorySources(memory([partial]), chat).recoveredIds, []);
});

test('an empty historical rollup hash does not invalidate otherwise active legacy memory', () => {
  const legacy = block('legacy', 0, 3, { sourceFingerprints: [], sourceHash: buildSourceHash([]) });
  const result = reconcileMemorySources(memory([legacy]), chat);
  assert.deepEqual(result.changedIds, []);
  assert.equal(result.memory.blocks[0].status, 'active');
});
