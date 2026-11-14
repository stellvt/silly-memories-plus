import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactionPlan, createEmptyMemory, deleteMemoryBlock, editMemoryBlock, normalizeMemory, rewriteConversationWithMemory, stageCompactionTransaction, stageManualRollup } from '../lib/core.mjs';
import { changeCheckpoint, getManualMessageHints, listCheckpoints, prepareManualRange, stageManualCompaction } from '../lib/manual-memory.mjs';
import { partitionRawEntries } from '../lib/summarizer.mjs';

// Failure matrix: wrong inclusive boundaries or indices after system messages,
// silently restored hidden history, checkpoints lost on reload or rebound after
// deletion, no split at arc ends, overlap altering memory without consent,
// duplicated coverage, losing progress on failure, committing a stale job,
// and crossing the raw/rollup boundary in either manual direction.
const chat = Array.from({ length: 10 }, (_, index) => ({
  id: `message-${index}`, index, chatIndex: index < 2 ? index : index + 1,
  mes: `Scene ${index}: ${'word '.repeat(20)}`, name: 'Mira',
}));
const counted = messages => messages.map(message => ({ index: message.index, message, tokens: 300 }));
const structured = {
  title: 'Scene', narrative: 'Mira kept the key.', relationships: [], importantItems: [], characterStates: [],
  locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [],
};
const block = (id, from, to, level = 1) => ({
  id, sourceFrom: from, sourceTo: to, level, status: 'active', structured,
  sourceTokens: (to - from + 1) * 300, summaryTokens: 40, children: [],
});
const memoryWith = (...blocks) => ({ ...createEmptyMemory(), blocks });
const pairs = blocks => blocks.map(b => [b.sourceFrom, b.sourceTo]);

test('manual hints use Tavern numbers, skip covered and hidden starts, and end on the latest available message', () => {
  const memory = memoryWith(block('first', 0, 1), block('last', 8, 9));
  const visible = chat.map(m => m.index === 2 || m.index === 9 ? { ...m, extra: { [Symbol.for('ignore')]: true } } : m);
  assert.deepEqual(getManualMessageHints(memory, visible), { from: '4', to: '9', at: '9' });
  assert.deepEqual(getManualMessageHints(memoryWith(), chat), { from: '0', to: '10', at: '10' });
  assert.deepEqual(getManualMessageHints(memoryWith(block('all', 0, 9)), chat), { from: '', to: '10', at: '10' });
  assert.deepEqual(getManualMessageHints(memory, []), { from: '', to: '', at: '' });
});
const partition = entries => partitionRawEntries(entries, 520, text => text.length);
function fixture() {
  const calls = [], saves = [];
  const options = {
    partitionRawSource: partition,
    createBlock: async ({ level, sourceEntries, childBlocks }) => {
      const range = sourceEntries ? [sourceEntries[0].index, sourceEntries.at(-1).index]
        : [childBlocks[0].sourceFrom, childBlocks.at(-1).sourceTo];
      calls.push({ level, range, childIds: childBlocks?.map(b => b.id) });
      return block(`generated-${calls.length}`, ...range, level);
    },
    onCheckpoint: candidate => saves.push(structuredClone(candidate)),
  };
  return { calls, saves, options };
}

test('range uses visible Tavern indices, is inclusive, and can include the newest message', async () => {
  const memory = memoryWith();
  const range = prepareManualRange(memory, chat, '3', '10');
  assert.deepEqual(range.source.map(m => m.index), [2, 3, 4, 5, 6, 7, 8, 9]);
  const { options } = fixture();
  const result = await stageManualCompaction({ memory, rawEntries: counted(range.source), ...options });
  assert.deepEqual(pairs(result.rawBlocks), [[2, 3], [4, 5], [6, 7], [8, 9]]);
  const rewritten = rewriteConversationWithMemory(chat, result.memory, () => ({ summary: true }));
  assert.deepEqual(rewritten.messages.filter(m => !m.summary).map(m => m.index), [0, 1]);
});

test('invalid bounds, non-dialogue endpoints and hidden history never reach compaction', () => {
  const hidden = chat.map(m => m.index === 4 ? { ...m, extra: { [Symbol.for('ignore')]: true } } : m);
  for (const [from, to] of [['', '4'], ['3', undefined], ['2', '5'], ['3.5', '6'], ['7', '6'], ['1', '11']]) {
    assert.throws(() => prepareManualRange(memoryWith(), chat, from, to));
  }
  assert.throws(() => prepareManualRange(memoryWith(), hidden, '3', '6'), /hidden/i);
});

test('arc marks persist, default to the last message, follow stable IDs and ignore deleted sources', () => {
  let memory = changeCheckpoint(memoryWith(), chat, '4', true);
  memory = changeCheckpoint(memory, chat, undefined, true);
  memory = changeCheckpoint(memory, chat, '4', true);
  memory = normalizeMemory(JSON.parse(JSON.stringify(memory)));
  assert.deepEqual(listCheckpoints(memory, chat).map(m => m.chatIndex), [4, 10]);
  assert.deepEqual(listCheckpoints(memory, chat.slice(1, -1).map(m => ({ ...m, index: m.index - 1, chatIndex: m.chatIndex - 1 }))).map(m => m.chatIndex), [3]);
  assert.deepEqual(listCheckpoints(changeCheckpoint(memory, chat, '4', false), chat).map(m => m.chatIndex), [10]);
  const withoutIds = chat.map(({ id, ...m }) => m);
  const unowned = changeCheckpoint(memoryWith(), withoutIds, '4', true);
  assert.deepEqual(listCheckpoints(unowned, withoutIds.filter(m => m.index !== 3)), []);
});

test('manual blocks end on arc messages before budget partitioning, without running rollup', async () => {
  let memory = memoryWith(block('a', 0, 0), block('b', 1, 1));
  memory = changeCheckpoint(memory, chat, '3', true);
  memory = changeCheckpoint(memory, chat, '6', true);
  const { options, calls, saves } = fixture();
  const result = await stageManualCompaction({
    memory, rawEntries: counted(chat.slice(2)), checkpointIndices: listCheckpoints(memory, chat).map(m => m.index), ...options,
  });
  assert.deepEqual(pairs(result.rawBlocks), [[2, 2], [3, 4], [5, 5], [6, 7], [8, 9]]);
  assert.ok(calls.every(call => call.level === 1));
  assert.ok(result.memory.blocks.slice(0, 2).every(b => b.status === 'active'));
  assert.equal(saves.length, calls.length);
});

test('overlap requires consent and archives only affected coverage on success', async () => {
  const memory = memoryWith(block('overridden', 0, 3, 2), block('untouched', 7, 8));
  const range = prepareManualRange(memory, chat, '3', '5');
  assert.deepEqual(range.overlaps.map(b => b.id), ['overridden']);
  const { calls, saves, options } = fixture();
  const input = { memory, rawEntries: counted(range.source), ...options };
  await assert.rejects(stageManualCompaction(input), /overlap|covered/i);
  assert.equal(calls.length, 0);
  assert.equal(saves.length, 0);
  const result = await stageManualCompaction({ ...input, replaceOverlaps: true });
  assert.deepEqual(pairs(result.rawBlocks), [[2, 3], [4, 4]]);
  assert.equal(result.memory.blocks.find(b => b.id === 'overridden').status, 'retired');
  assert.equal(result.memory.blocks.find(b => b.id === 'untouched').status, 'active');
  assert.equal(memory.blocks[0].status, 'active');
  const revised = rewriteConversationWithMemory(chat, result.memory, () => ({ summary: true }));
  assert.deepEqual(revised.messages.filter(m => !m.summary).map(m => m.index), [0, 1, 5, 6, 9]);
});

test('failed or stale batches cannot retire a block; prior completed batches remain saved', async () => {
  const memory = memoryWith(block('existing', 2, 3));
  const { options, saves } = fixture();
  const input = { memory, rawEntries: counted(chat.slice(0, 4)), replaceOverlaps: true, ...options };
  await assert.rejects(stageManualCompaction({ ...input, validateBlock: () => { throw new Error('Changed chat'); } }), /Changed chat/);
  assert.equal(saves.length, 0);
  await assert.rejects(stageManualCompaction({ ...input, createBlock: args => {
    if (args.sourceEntries[0].index === 2) throw new Error('Provider failed');
    return options.createBlock(args);
  } }), /Provider failed/);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].blocks[0].status, 'active');
  assert.deepEqual(pairs(saves[0].blocks.slice(1)), [[0, 1]]);
});

test('manual merge only combines adjacent selected same-level blocks', async () => {
  const memory = memoryWith(block('a', 0, 0, 2), block('b', 1, 1, 2), block('c', 2, 2, 2));
  const { options, calls } = fixture();
  const result = await stageManualRollup({ memory, childIds: ['b', 'a'], ...options });
  assert.deepEqual(calls, [{ level: 3, range: [0, 1], childIds: ['a', 'b'] }]);
  assert.deepEqual(result.memory.blocks.map(b => b.status), ['retired', 'retired', 'active', 'active']);
});

test('history compaction stops when a summary would cost more than its source', async () => {
  const { options, saves } = fixture();
  await assert.rejects(stageManualCompaction({
    ...options, memory: memoryWith(), rawEntries: counted(chat.slice(0, 2)), requireReduction: true,
    createBlock: () => ({ ...block('expanded', 0, 1), summaryTokens: 601 }),
  }), /did not reduce/);
  assert.equal(saves.length, 0);
});

test('editing or removing an archived rollup cannot restore a child over newer range coverage', async () => {
  const memory = memoryWith(
    { ...block('child-a', 0, 0), status: 'retired' },
    { ...block('child-b', 1, 3), status: 'retired' },
    { ...block('parent', 0, 3, 2), children: ['child-a', 'child-b'] },
  );
  const { options } = fixture();
  const result = await stageManualCompaction({ ...options, memory, rawEntries: counted(chat.slice(2, 4)), replaceOverlaps: true });
  for (const revised of [
    editMemoryBlock(result.memory, 'child-a', structured, 40),
    deleteMemoryBlock(result.memory, 'parent'),
  ]) {
    assert.equal(revised.memory.blocks.find(b => b.id === 'generated-1').status, 'active');
    assert.notEqual(revised.memory.blocks.find(b => b.id === 'child-b').status, 'active');
  }
});

test('automatic replanning still works and never lets an L1 cross an arc end', async () => {
  const memory = memoryWith();
  const { options } = fixture();
  const planOptions = { contextBudget: 2300, rawEntries: counted(chat), checkpointIndices: [1, 4], settings: { blockTargetTokens: 256, minimumSourceTokens: 512 } };
  const result = await stageCompactionTransaction({ ...options, ...planOptions, plan: buildCompactionPlan(planOptions), memory });
  assert.deepEqual(pairs(result.rawBlocks), [[0, 1], [2, 4]]);
  assert.equal(result.finalPlan.kind, 'none');
});
