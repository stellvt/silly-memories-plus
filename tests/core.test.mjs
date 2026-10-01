import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompactionPlan,
  chunkByTokenBudget,
  commitRawBlock,
  commitSummaryRollup,
  createEmptyMemory,
  DEFAULT_PROMPTS,
  deleteMemoryBlock,
  editMemoryBlock,
  getActiveBlocks,
  getActiveFrontier,
  getBlockAncestorIds,
  getCoveredThrough,
  getManualRollupBlocks,
  getSummaryRequestBudget,
  normalizeMemory,
  normalizeSettings,
  parseStructuredSummary,
  renderActiveMemory,
  renderSummaryPrompt,
  rewriteConversationWithMemory,
  selectTail,
  setBlockUseRaw,
  splitTextByTokenBudget,
  stageBlockRegeneration,
  stageManualRollup,
} from '../lib/core.mjs';

function entries(tokens) {
  return tokens.map((value, index) => ({ index, tokens: value }));
}

function summary(narrative, overrides = {}) {
  return {
    narrative,
    relationships: [],
    importantItems: [],
    characterStates: [],
    locations: [],
    commitments: [],
    openThreads: [],
    resolvedThreads: [],
    worldFacts: [],
    exactTerms: [],
    ...overrides,
  };
}

function memoryBlock(narrative, fields = {}) {
  return { ...fields, structured: summary(narrative, fields.structured) };
}

test('trigger ratio is the single persisted percentage source', () => {
  const settings = normalizeSettings({ triggerRatio: 0.8, tailRatio: 0.4 });
  assert.equal(settings.triggerRatio, 0.8);
  assert.ok(!Object.hasOwn(settings, 'tailRatio'));
});

test('summary output budget keeps a separate reserve for hidden reasoning', () => {
  assert.deepEqual(getSummaryRequestBudget({ summaryMaxOutputTokens: 8192 }), {
    usefulOutputTokens: 8192,
    reasoningReserveTokens: 4096,
    requestMaxTokens: 12288,
  });
  const settings = normalizeSettings({ blockTargetTokens: 16000, summaryMaxOutputTokens: 8192 });
  assert.equal(settings.summaryMaxOutputTokens, 16000);
});

test('prompt templates normalize independently and render supported placeholders', () => {
  const settings = normalizeSettings({ prompts: { raw: 'L{{level}} / {{target_tokens}}\n{{schema}}' } });
  assert.equal(settings.prompts.rollup, DEFAULT_PROMPTS.rollup);
  const rendered = renderSummaryPrompt(settings.prompts.raw, { level: 1, targetTokens: 4000 });
  assert.match(rendered, /^L1 \/ 4000/);
  assert.match(rendered, /"narrative"/);
  assert.ok(!rendered.includes('{{schema}}'));
});

test('non-current memory schemas initialize an empty version 3 memory', () => {
  assert.deepEqual(normalizeMemory({ schemaVersion: 1, blocks: [{ id: 'old', text: 'old' }] }), createEmptyMemory());
});

test('current memory schema drops blocks without a complete structured summary', () => {
  const memory = normalizeMemory({ schemaVersion: 3, blocks: [{ id: 'invalid', sourceFrom: 0, sourceTo: 0 }] });
  assert.deepEqual(memory.blocks, []);
});

test('strict summary parser accepts the complete canonical schema', () => {
  const summary = {
    narrative: 'Mira entrusted Rowan with the observatory key.',
    relationships: ['Mira trusts Rowan with guarded items.'],
    importantItems: ['Brass observatory key — carried by Rowan.'],
    characterStates: [],
    locations: [],
    commitments: ['Rowan will guard the key until dawn.'],
    openThreads: [],
    resolvedThreads: [],
    worldFacts: [],
    exactTerms: ['Nightmare Robe («Одеяние кошмара»)'],
  };
  assert.deepEqual(parseStructuredSummary(JSON.stringify(summary)), summary);
  assert.deepEqual(parseStructuredSummary(summary), summary);
});

test('strict summary parser rejects truncated JSON', () => {
  assert.throws(
    () => parseStructuredSummary('{"narrative":"cut off","relationships":['),
    /incomplete or invalid JSON/,
  );
});

test('strict summary parser rejects missing fields and non-string ledger entries', () => {
  assert.throws(() => parseStructuredSummary('{"narrative":"only narrative"}'), /relationships must be an array/);
  const invalid = {
    narrative: 'Invalid item shape.',
    relationships: [],
    importantItems: [{ name: 'Nightmare Robe' }],
    characterStates: [],
    locations: [],
    commitments: [],
    openThreads: [],
    resolvedThreads: [],
    worldFacts: [],
    exactTerms: [],
  };
  assert.throws(() => parseStructuredSummary(JSON.stringify(invalid)), /non-empty strings only/);
});

function dependencyMemory() {
  return {
    schemaVersion: 3,
    blocks: [
      memoryBlock('A', { id: 'l1-a', level: 1, sourceFrom: 0, sourceTo: 0, status: 'retired' }),
      memoryBlock('B', { id: 'l1-b', level: 1, sourceFrom: 1, sourceTo: 1, status: 'retired' }),
      memoryBlock('AB', { id: 'l2', level: 2, sourceFrom: 0, sourceTo: 1, status: 'active', children: ['l1-a', 'l1-b'] }),
    ],
  };
}

function threeL1Blocks() {
  let memory = createEmptyMemory();
  for (let index = 0; index < 3; index++) {
    memory = commitRawBlock(memory, {
      id: `l1-${index + 1}`,
      structured: summary(`L1 ${index + 1}`),
      sourceFrom: index * 10,
      sourceTo: index * 10 + 9,
      sourceTokens: 10000,
      summaryTokens: 4000,
    });
  }
  return memory;
}

test('manual merge accepts a contiguous L1 subset and leaves the third block separate', async () => {
  const memory = threeL1Blocks();
  assert.deepEqual(getManualRollupBlocks(memory, ['l1-1', 'l1-2']).map(block => block.id), ['l1-1', 'l1-2']);
  const result = await stageManualRollup({
    memory,
    childIds: ['l1-1', 'l1-2'],
    targetTokens: 4000,
    createBlock: async ({ level, childBlocks, targetTokens }) => ({
      id: 'l2-manual',
      level,
      structured: summary('Merged first two blocks'),
      sourceFrom: childBlocks[0].sourceFrom,
      sourceTo: childBlocks.at(-1).sourceTo,
      sourceTokens: childBlocks.reduce((sum, block) => sum + block.summaryTokens, 0),
      summaryTokens: targetTokens,
      children: childBlocks.map(block => block.id),
    }),
  });
  assert.deepEqual(getActiveBlocks(result.memory).map(block => block.id), ['l2-manual', 'l1-3']);
  assert.deepEqual(result.childIds, ['l1-1', 'l1-2']);
  assert.equal(result.sourceLevel, 1);
  assert.equal(result.targetLevel, 2);
  assert.equal(result.memory.blocks.find(block => block.id === 'l1-1').status, 'retired');
  assert.equal(result.memory.blocks.find(block => block.id === 'l1-3').status, 'active');
});

test('manual merge rejects gaps, mixed levels and raw-exposed blocks', () => {
  const memory = threeL1Blocks();
  assert.throws(() => getManualRollupBlocks(memory, ['l1-1', 'l1-3']), /adjacent/);
  const rawMemory = setBlockUseRaw(memory, 'l1-2', true);
  assert.throws(() => getManualRollupBlocks(rawMemory, ['l1-1', 'l1-2']), /Raw-exposed/);
  const mixed = commitSummaryRollup(memory, memoryBlock('Mixed level', {
    id: 'l2-mixed', level: 2, sourceFrom: 0, sourceTo: 9, sourceTokens: 4000, summaryTokens: 2000,
  }), ['l1-1']);
  assert.throws(() => getManualRollupBlocks(mixed, ['l2-mixed', 'l1-2']), /same level/);
});

test('manual merge promotes adjacent L2 blocks into L3', async () => {
  const memory = {
    schemaVersion: 3,
    blocks: [
      memoryBlock('L2 A', { id: 'l2-a', level: 2, sourceFrom: 0, sourceTo: 19, sourceTokens: 8000, rawTokens: 20000, summaryTokens: 4000, status: 'active' }),
      memoryBlock('L2 B', { id: 'l2-b', level: 2, sourceFrom: 20, sourceTo: 39, sourceTokens: 8000, rawTokens: 20000, summaryTokens: 4000, status: 'active' }),
    ],
  };
  const result = await stageManualRollup({
    memory,
    childIds: ['l2-a', 'l2-b'],
    targetTokens: 4000,
    createBlock: async ({ level, childBlocks }) => ({
      id: 'l3',
      level,
      structured: summary('L3 merged memory'),
      sourceFrom: childBlocks[0].sourceFrom,
      sourceTo: childBlocks.at(-1).sourceTo,
      sourceTokens: 8000,
      rawTokens: 40000,
      summaryTokens: 4000,
    }),
  });
  assert.equal(result.sourceLevel, 2);
  assert.equal(result.targetLevel, 3);
  assert.equal(result.rollupBlock.level, 3);
  assert.deepEqual(getActiveBlocks(result.memory).map(block => block.id), ['l3']);
});

test('failed manual merge leaves the saved memory untouched', async () => {
  const memory = threeL1Blocks();
  const before = structuredClone(memory);
  await assert.rejects(
    stageManualRollup({
      memory,
      childIds: ['l1-1', 'l1-2'],
      createBlock: async () => { throw new Error('manual merge failed'); },
    }),
    /manual merge failed/,
  );
  assert.deepEqual(memory, before);
});

test('raw exposure preserves the block and replaces its prompt cost with source tokens', () => {
  const memory = setBlockUseRaw(threeL1Blocks(), 'l1-1', true);
  const first = memory.blocks.find(block => block.id === 'l1-1');
  assert.equal(first.status, 'active');
  assert.equal(first.useRaw, true);
  assert.ok(!renderActiveMemory(getActiveBlocks(memory)).includes('L1 1'));
  const plan = buildCompactionPlan({ contextBudget: 80000, blocks: getActiveBlocks(memory), rawEntries: [] });
  assert.equal(plan.blockTokens, 18000);
  assert.equal(plan.summaryTierTokens, 8000);
});

test('block dependency lookup returns every transitive parent', () => {
  const memory = dependencyMemory();
  memory.blocks.push(memoryBlock('ABC', { id: 'l3', level: 3, sourceFrom: 0, sourceTo: 2, status: 'active', children: ['l2'] }));
  assert.deepEqual(new Set(getBlockAncestorIds(memory, 'l1-a')), new Set(['l2', 'l3']));
});

test('deleting an active rollup safely restores its retired children', () => {
  const result = deleteMemoryBlock(dependencyMemory(), 'l2');
  assert.deepEqual(result.removedIds, ['l2']);
  assert.deepEqual(new Set(result.reactivatedIds), new Set(['l1-a', 'l1-b']));
  assert.deepEqual(getActiveFrontier(result.memory).blocks.map(block => block.id), ['l1-a', 'l1-b']);
});

test('deleting a retired child also removes dependent rollups and exposes raw history after the gap', () => {
  const result = deleteMemoryBlock(dependencyMemory(), 'l1-a');
  assert.deepEqual(new Set(result.removedIds), new Set(['l1-a', 'l2']));
  assert.deepEqual(result.reactivatedIds, ['l1-b']);
  assert.deepEqual(result.staleIds, ['l1-b']);
  assert.equal(getActiveFrontier(result.memory).blocks.length, 0);
});

test('editing a retired child invalidates its rollup and reactivates the editable source tier', () => {
  const original = dependencyMemory();
  const structured = {
    narrative: 'A manually edited',
    relationships: [],
    importantItems: ['Edited item'],
    characterStates: [],
    locations: [],
    commitments: [],
    openThreads: [],
    resolvedThreads: [],
    worldFacts: [],
    exactTerms: [],
  };
  const result = editMemoryBlock(original, 'l1-a', structured, 42);
  assert.equal(result.memory.blocks.find(block => block.id === 'l1-a').structured.narrative, 'A manually edited');
  assert.equal(result.memory.blocks.find(block => block.id === 'l1-a').summaryTokens, 42);
  assert.equal(result.memory.blocks.find(block => block.id === 'l2').status, 'stale');
  assert.deepEqual(new Set(result.reactivatedIds), new Set(['l1-a', 'l1-b']));
  assert.deepEqual(getActiveFrontier(result.memory).blocks.map(block => block.id), ['l1-a', 'l1-b']);
});

test('staged block regeneration rebuilds the selected block before dependent rollups', async () => {
  const calls = [];
  const result = await stageBlockRegeneration({
    memory: dependencyMemory(),
    blockId: 'l1-a',
    createReplacement: async (block, candidate) => {
      calls.push(block.id);
      if (block.id === 'l2') {
        assert.equal(candidate.blocks.find(item => item.id === 'l1-a').structured.narrative, 'A regenerated');
      }
      return { ...block, structured: summary(`${block.structured.narrative} regenerated`), createdAt: 1234 };
    },
  });
  assert.deepEqual(calls, ['l1-a', 'l2']);
  assert.equal(result.memory.blocks.find(block => block.id === 'l1-a').status, 'retired');
  assert.equal(result.memory.blocks.find(block => block.id === 'l2').status, 'active');
  assert.deepEqual(result.regeneratedIds, ['l1-a', 'l2']);
});

test('failed dependent regeneration leaves the previously saved memory untouched', async () => {
  const memory = dependencyMemory();
  const before = structuredClone(memory);
  await assert.rejects(
    stageBlockRegeneration({
      memory,
      blockId: 'l1-a',
      createReplacement: async block => {
        if (block.id === 'l2') throw new Error('parent failed');
        return { ...block, structured: summary('temporary replacement') };
      },
    }),
    /parent failed/,
  );
  assert.deepEqual(memory, before);
});

test('selectTail retains the newest messages within the token budget', () => {
  const result = selectTail(entries([10000, 10000, 10000, 10000, 10000, 10000]), 20000);
  assert.equal(result.sourceTokens, 40000);
  assert.equal(result.tailTokens, 20000);
  assert.deepEqual(result.tail.map(item => item.index), [4, 5]);
});

test('summarizer sources are grouped without crossing the configured input budget', () => {
  const chunks = chunkByTokenBudget(entries([12000, 12000, 12000, 12000, 12000]), 28000);
  assert.deepEqual(chunks.map(chunk => chunk.length), [2, 2, 1]);
  assert.deepEqual(chunks.map(chunk => chunk.reduce((sum, item) => sum + item.tokens, 0)), [24000, 24000, 12000]);
});

test('an oversized message is split without losing or reordering text', async () => {
  const source = 'alpha beta gamma delta epsilon zeta eta theta';
  const chunks = await splitTextByTokenBudget(source, 12, async value => value.length);
  assert.equal(chunks.join(''), source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 12));
});

test('80k context at 75/25 plans 40k raw into a 4k block', () => {
  const result = buildCompactionPlan({
    contextBudget: 80000,
    rawEntries: entries([10000, 10000, 10000, 10000, 10000, 10000]),
    settings: { triggerRatio: 0.75, blockTargetTokens: 4000 },
  });
  assert.equal(result.kind, 'raw');
  assert.equal(result.triggerTokens, 60000);
  assert.equal(result.tailBudgetTokens, 20000);
  assert.equal(result.sourceTokens, 40000);
  assert.equal(result.targetTokens, 4000);
});

test('planner stays idle below the trigger', () => {
  const result = buildCompactionPlan({
    contextBudget: 80000,
    rawEntries: entries([10000, 10000, 10000, 10000, 10000]),
  });
  assert.equal(result.kind, 'none');
  assert.equal(result.reason, 'below-trigger');
});

test('fixed prompt overhead is removed before applying 75/25', () => {
  const result = buildCompactionPlan({
    contextBudget: 80000,
    fixedPromptTokens: 8000,
    rawEntries: entries([9000, 9000, 9000, 9000, 9000, 9000]),
  });
  assert.equal(result.kind, 'raw');
  assert.equal(result.usableBudget, 72000);
  assert.equal(result.grossTriggerTokens, 60000);
  assert.equal(result.triggerTokens, 52000);
  assert.equal(result.tailBudgetTokens, 20000);
  assert.equal(result.sourceTokens, 36000);
  assert.equal(result.triggerTokens + 8000, 60000);
});

test('minimum source size scales down for an 8k context', () => {
  const result = buildCompactionPlan({
    contextBudget: 8000,
    rawEntries: entries([1000, 1000, 1000, 1000, 1000, 1000]),
  });
  assert.equal(result.kind, 'raw');
  assert.equal(result.triggerTokens, 6000);
  assert.equal(result.tailBudgetTokens, 2000);
  assert.equal(result.effectiveMinimumSourceTokens, 4000);
  assert.equal(result.sourceTokens, 4000);
});

test('forced compaction can run below the automatic trigger', () => {
  const result = buildCompactionPlan({
    contextBudget: 80000,
    rawEntries: entries([10000, 10000, 10000]),
    force: true,
  });
  assert.equal(result.kind, 'raw');
  assert.equal(result.sourceTokens, 10000);
  assert.equal(result.tailTokens, 20000);
});

test('planner rolls summaries when 4k blocks occupy 75% of an 80k tier', () => {
  const blocks = Array.from({ length: 15 }, (_, index) => ({
    id: `b${index}`,
    status: 'active',
    summaryTokens: 4000,
    sourceFrom: index * 10,
    sourceTo: index * 10 + 9,
  }));
  const result = buildCompactionPlan({ contextBudget: 80000, blocks, rawEntries: [] });
  assert.equal(result.kind, 'summaries');
  assert.equal(result.blockTokens, 60000);
  assert.equal(result.archiveLimitTokens, 60000);
});

test('automatic rollup uses a contiguous summary run bounded by a raw block', () => {
  const blocks = Array.from({ length: 31 }, (_, index) => ({
    id: `b${index}`,
    status: 'active',
    useRaw: index === 15,
    summaryTokens: 4000,
    sourceTokens: 10000,
    sourceFrom: index * 10,
    sourceTo: index * 10 + 9,
  }));
  const result = buildCompactionPlan({ contextBudget: 80000, blocks, rawEntries: [] });
  assert.equal(result.kind, 'summaries');
  assert.deepEqual(result.blocks.map(block => block.id), blocks.slice(0, 15).map(block => block.id));
  assert.ok(!result.blocks.some(block => block.useRaw));
});

test('planner blocks a prompt that cannot fit because raw memory is pinned', () => {
  const result = buildCompactionPlan({
    contextBudget: 80000,
    blocks: [{
      id: 'raw-pin', status: 'active', useRaw: true, rawTokens: 70000, summaryTokens: 4000, sourceFrom: 0, sourceTo: 69,
    }],
    rawEntries: entries([10000, 10000]),
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(result.reason, 'raw-over-budget');
  assert.equal(result.overflowTokens, 10000);
});

test('hard overflow compacts available cold raw history when the projected prompt fits', () => {
  const result = buildCompactionPlan({
    contextBudget: 80000,
    blocks: [{
      id: 'raw-pin', status: 'active', useRaw: true, rawTokens: 50000, summaryTokens: 4000, sourceFrom: 0, sourceTo: 49,
    }],
    rawEntries: entries([10000, 10000, 10000, 10000]),
  });
  assert.equal(result.kind, 'raw');
  assert.equal(result.projectedTokens, 74000);
});

test('fixed overhead counts toward the 75% summary archive threshold', () => {
  const blocks = Array.from({ length: 13 }, (_, index) => ({
    id: `b${index}`,
    status: 'active',
    summaryTokens: 4000,
    sourceFrom: index * 10,
    sourceTo: index * 10 + 9,
  }));
  const result = buildCompactionPlan({
    contextBudget: 80000,
    fixedPromptTokens: 8000,
    blocks,
    rawEntries: [],
  });
  assert.equal(result.kind, 'summaries');
  assert.equal(result.archiveLimitTokens, 52000);
  assert.equal(result.blockTokens + 8000, 60000);
});

test('rollup retires children and becomes the active frontier', () => {
  let memory = createEmptyMemory();
  memory = commitRawBlock(memory, {
    id: 'a', structured: summary('A'), sourceFrom: 0, sourceTo: 9, sourceTokens: 10000, summaryTokens: 1000,
    sourceFingerprints: [{ index: 0, hash: 'a' }],
  });
  memory = commitRawBlock(memory, {
    id: 'b', structured: summary('B'), sourceFrom: 10, sourceTo: 19, sourceTokens: 10000, summaryTokens: 1000,
  });
  memory = commitSummaryRollup(memory, {
    id: 'ab', level: 2, structured: summary('AB'), sourceFrom: 0, sourceTo: 19, sourceTokens: 2000, summaryTokens: 500,
  }, ['a', 'b']);
  assert.deepEqual(getActiveBlocks(memory).map(block => block.id), ['ab']);
  assert.equal(getCoveredThrough(memory.blocks), 19);
  assert.deepEqual(memory.blocks.find(block => block.id === 'a').sourceFingerprints, []);
});

test('staged fifteenth block and rollup never mutate the last saved memory', () => {
  let saved = createEmptyMemory();
  for (let index = 0; index < 14; index++) {
    saved = commitRawBlock(saved, {
      id: `b${index}`,
      structured: summary(`Block ${index}`),
      sourceFrom: index * 10,
      sourceTo: index * 10 + 9,
      sourceTokens: 10000,
      summaryTokens: 4000,
    });
  }

  const savedSnapshot = structuredClone(saved);
  const staged = commitRawBlock(saved, {
    id: 'b14',
    structured: summary('Block 14'),
    sourceFrom: 140,
    sourceTo: 149,
    sourceTokens: 10000,
    summaryTokens: 4000,
  });
  const stagedSnapshot = structuredClone(staged);

  const plan = buildCompactionPlan({
    contextBudget: 80000,
    blocks: getActiveBlocks(staged),
    rawEntries: [],
  });
  assert.equal(plan.kind, 'summaries');

  const rolled = commitSummaryRollup(staged, {
    id: 'l2',
    level: 2,
    structured: summary('Rolled memory'),
    sourceFrom: 0,
    sourceTo: 149,
    sourceTokens: 60000,
    summaryTokens: 4000,
  }, plan.blocks.map(block => block.id));

  assert.deepEqual(saved, savedSnapshot);
  assert.deepEqual(staged, stagedSnapshot);
  assert.equal(getActiveBlocks(saved).length, 14);
  assert.equal(getActiveBlocks(staged).length, 15);
  assert.deepEqual(getActiveBlocks(rolled).map(block => block.id), ['l2']);
});


test('active memory renders in chronological order', () => {
  const text = renderActiveMemory([
    memoryBlock('Later', { id: 'b', status: 'active', level: 1, sourceFrom: 10, sourceTo: 19 }),
    memoryBlock('Earlier', { id: 'a', status: 'active', level: 1, sourceFrom: 0, sourceTo: 9 }),
  ]);
  assert.ok(text.indexOf('Earlier') < text.indexOf('Later'));
});

test('adding an L1 block appends without rewriting earlier rendered memory', () => {
  const first = {
    ...memoryBlock('Stable first memory', { id: 'a', status: 'active', level: 1, sourceFrom: 0, sourceTo: 9 }),
  };
  const second = {
    ...memoryBlock('Appended memory', { id: 'b', status: 'active', level: 1, sourceFrom: 10, sourceTo: 19 }),
  };
  const previousMemory = renderActiveMemory([first]);
  const extendedMemory = renderActiveMemory([first, second]);
  assert.ok(extendedMemory.startsWith(`${previousMemory}\n\n`));
});

test('conversation rewrite preserves raw and summary chronology', () => {
  const blocks = [
    memoryBlock('First summary', { id: 'a', level: 1, status: 'active', sourceFrom: 0, sourceTo: 0 }),
    memoryBlock('Hidden summary', { id: 'b', level: 1, status: 'active', useRaw: true, sourceFrom: 1, sourceTo: 1 }),
    memoryBlock('Later summary', { id: 'c', level: 1, status: 'active', sourceFrom: 2, sourceTo: 2 }),
  ];
  const chat = [0, 1, 2, 3].map(index => ({ index, mes: `raw-${index}` }));
  const result = rewriteConversationWithMemory(chat, blocks, text => ({ index: -1, mes: text, memory: true }));
  assert.equal(result.messages.length, 4);
  assert.match(result.messages[0].mes, /First summary/);
  assert.equal(result.messages[1].mes, 'raw-1');
  assert.match(result.messages[2].mes, /Later summary/);
  assert.equal(result.messages[3].mes, 'raw-3');
});

test('conversation rewrite rejects an incomplete raw range', () => {
  const blocks = [memoryBlock('Hidden', {
    id: 'raw', level: 1, status: 'active', useRaw: true, sourceFrom: 0, sourceTo: 1,
  })];
  assert.throws(
    () => rewriteConversationWithMemory([{ index: 0, mes: 'only one' }], blocks, text => ({ mes: text })),
    /unavailable/,
  );
});

test('covered range supports a block ending at index zero', () => {
  assert.equal(getCoveredThrough([{ status: 'active', sourceTo: 0 }]), 0);
});

test('a broken active frontier never hides messages across a source gap', () => {
  const frontier = getActiveFrontier([
    { id: 'a', status: 'active', sourceFrom: 0, sourceTo: 9 },
    { id: 'gap', status: 'active', sourceFrom: 20, sourceTo: 29 },
  ]);
  assert.deepEqual(frontier.blocks.map(block => block.id), ['a']);
  assert.equal(frontier.coveredThrough, 9);
});
