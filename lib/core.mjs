export const SCHEMA_VERSION = 3;

export const DEFAULT_PROMPTS = Object.freeze({
  raw: `You are a memory compaction engine for a long-running fictional conversation.
Create one canonical L1 memory block from the supplied raw transcript.
Target no more than {{target_tokens}} tokens. Preserve chronology, causal links, relationship changes, important items and their owner/location/state, character states, commitments, unresolved threads, world facts, and exact names or terms.
Newer information overrides older information only when a real change occurred. Do not invent details. Mark uncertainty instead of guessing.
Every array item must be one self-contained non-empty string. Return every schema key even when its array is empty.
Return JSON only with this schema:
{{schema}}`,
  rollup: `You are a hierarchical memory compaction engine for a long-running fictional conversation.
Merge the supplied memory blocks into one canonical L{{level}} block while preserving their chronology and all important continuity.
Target no more than {{target_tokens}} tokens. Resolve genuine updates in favor of newer information, but retain earlier facts that are still true. Preserve causal links, relationships, items, states, locations, commitments, unresolved threads, world facts, and exact names or terms.
Do not invent details. Mark uncertainty instead of guessing. Every array item must be one self-contained non-empty string. Return every schema key even when its array is empty.
Return JSON only with this schema:
{{schema}}`,
  reduce: `You are reducing an already structured memory block that exceeded its size target.
Recompress it to no more than {{target_tokens}} tokens without changing facts, chronology, names, or schema. Prefer removing repetition and low-value wording over removing continuity.
Do not invent details. Every array item must be one self-contained non-empty string. Return every schema key even when its array is empty.
Return JSON only with this schema:
{{schema}}`,
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  triggerRatio: 0.75,
  blockTargetTokens: 4000,
  minimumSourceTokens: 8000,
  summaryInputBudgetTokens: 50000,
  summaryMaxOutputTokens: 8192,
  summaryProfileId: '',
  summaryRole: 'system',
  includeStructuredMemory: true,
  prompts: DEFAULT_PROMPTS,
  debug: false,
});

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeSettings(source = {}) {
  const sourceTrigger = Number(source.triggerRatio);
  const hasTrigger = source.triggerRatio !== '' && source.triggerRatio != null && Number.isFinite(sourceTrigger);
  const triggerRatio = clampNumber(
    hasTrigger ? sourceTrigger : DEFAULT_SETTINGS.triggerRatio,
    0.5,
    0.95,
    DEFAULT_SETTINGS.triggerRatio,
  );
  const blockTargetTokens = Math.round(clampNumber(source.blockTargetTokens, 256, 16384, DEFAULT_SETTINGS.blockTargetTokens));
  const summaryMaxOutputTokens = Math.max(
    blockTargetTokens,
    Math.round(clampNumber(source.summaryMaxOutputTokens, 1024, 65536, DEFAULT_SETTINGS.summaryMaxOutputTokens)),
  );

  return {
    enabled: source.enabled !== false,
    triggerRatio,
    blockTargetTokens,
    minimumSourceTokens: Math.round(clampNumber(source.minimumSourceTokens, 512, 65536, DEFAULT_SETTINGS.minimumSourceTokens)),
    summaryInputBudgetTokens: Math.round(clampNumber(source.summaryInputBudgetTokens, 8192, 1000000, DEFAULT_SETTINGS.summaryInputBudgetTokens)),
    summaryMaxOutputTokens,
    summaryProfileId: String(source.summaryProfileId || ''),
    summaryRole: ['system', 'user', 'assistant'].includes(source.summaryRole) ? source.summaryRole : DEFAULT_SETTINGS.summaryRole,
    includeStructuredMemory: source.includeStructuredMemory !== false,
    prompts: normalizePromptTemplates(source.prompts),
    debug: source.debug === true,
  };
}

export function normalizePromptTemplates(source = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_PROMPTS).map(([stage, fallback]) => {
    const value = typeof source?.[stage] === 'string' ? source[stage].trim() : '';
    return [stage, value || fallback];
  }));
}

const SUMMARY_ARRAY_FIELDS = Object.freeze([
  'relationships',
  'importantItems',
  'characterStates',
  'locations',
  'commitments',
  'openThreads',
  'resolvedThreads',
  'worldFacts',
  'exactTerms',
]);

const stringArraySchema = Object.freeze({
  type: 'array',
  items: { type: 'string', minLength: 1 },
});

export const SUMMARY_JSON_SCHEMA = Object.freeze({
  name: 'silly_memories_plus_summary',
  description: 'Canonical structured memory for a fictional conversation.',
  strict: true,
  returnInvalid: true,
  value: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      narrative: { type: 'string', minLength: 1 },
      relationships: stringArraySchema,
      importantItems: stringArraySchema,
      characterStates: stringArraySchema,
      locations: stringArraySchema,
      commitments: stringArraySchema,
      openThreads: stringArraySchema,
      resolvedThreads: stringArraySchema,
      worldFacts: stringArraySchema,
      exactTerms: stringArraySchema,
    },
    required: ['narrative', ...SUMMARY_ARRAY_FIELDS],
    additionalProperties: false,
  },
});

const SUMMARY_SCHEMA_EXAMPLE = JSON.stringify({
  narrative: 'compact chronological memory',
  relationships: [],
  importantItems: [],
  characterStates: [],
  locations: [],
  commitments: [],
  openThreads: [],
  resolvedThreads: [],
  worldFacts: [],
  exactTerms: [],
}, null, 2);

export function renderSummaryPrompt(template, { targetTokens, level } = {}) {
  const values = {
    target_tokens: Math.max(1, Math.round(Number(targetTokens) || 1)),
    level: Math.max(1, Math.round(Number(level) || 1)),
    schema: SUMMARY_SCHEMA_EXAMPLE,
  };
  return String(template || '').replace(/\{\{\s*(target_tokens|level|schema)\s*\}\}/g, (_, key) => String(values[key]));
}

export function getSummaryRequestBudget(settings = DEFAULT_SETTINGS) {
  const normalized = normalizeSettings(settings);
  const usefulOutputTokens = normalized.summaryMaxOutputTokens;
  const reasoningReserveTokens = Math.max(1024, Math.min(8192, Math.ceil(usefulOutputTokens * 0.5)));
  return {
    usefulOutputTokens,
    reasoningReserveTokens,
    requestMaxTokens: usefulOutputTokens + reasoningReserveTokens,
  };
}

export function parseStructuredSummary(text) {
  let parsed;
  if (text && typeof text === 'object' && !Array.isArray(text)) {
    parsed = text;
  } else {
    let source = String(text ?? '').trim();
    const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) source = fenced[1].trim();
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error('Summarizer returned incomplete or invalid JSON', { cause: error });
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Summarizer JSON must be an object');
  }

  const allowedFields = new Set(['narrative', ...SUMMARY_ARRAY_FIELDS]);
  const unexpectedFields = Object.keys(parsed).filter(key => !allowedFields.has(key));
  if (unexpectedFields.length) {
    throw new Error(`Summarizer JSON contains unexpected fields: ${unexpectedFields.join(', ')}`);
  }
  if (typeof parsed.narrative !== 'string' || !parsed.narrative.trim()) {
    throw new Error('Summarizer JSON has no narrative');
  }

  const result = { narrative: parsed.narrative.trim() };
  for (const field of SUMMARY_ARRAY_FIELDS) {
    if (!Array.isArray(parsed[field])) {
      throw new Error(`Summarizer JSON field ${field} must be an array`);
    }
    if (parsed[field].some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error(`Summarizer JSON field ${field} must contain non-empty strings only`);
    }
    result[field] = parsed[field].map(value => value.trim());
  }
  return result;
}

export function createEmptyMemory() {
  return {
    schemaVersion: SCHEMA_VERSION,
    blocks: [],
  };
}

export function normalizeMemory(source = {}) {
  const memory = createEmptyMemory();
  if (Number(source?.schemaVersion) !== SCHEMA_VERSION) return memory;
  memory.blocks = Array.isArray(source.blocks)
    ? source.blocks.map(normalizeBlock).filter(Boolean)
    : [];
  return memory;
}

export function normalizeBlock(source) {
  if (!source || !source.id) return null;
  let structured;
  try {
    structured = parseStructuredSummary(source.structured);
  } catch {
    return null;
  }
  const sourceFrom = Math.max(0, Math.round(Number(source.sourceFrom) || 0));
  const sourceTo = Math.max(0, Math.round(Number(source.sourceTo) || 0));
  if (sourceTo < sourceFrom) return null;
  return {
    id: String(source.id),
    level: Math.max(1, Math.round(Number(source.level) || 1)),
    structured,
    sourceFrom,
    sourceTo,
    sourceTokens: Math.max(0, Math.round(Number(source.sourceTokens) || 0)),
    rawTokens: Math.max(0, Math.round(Number(source.rawTokens ?? source.sourceTokens) || 0)),
    summaryTokens: Math.max(0, Math.round(Number(source.summaryTokens) || 0)),
    sourceHash: String(source.sourceHash || ''),
    sourceFingerprints: Array.isArray(source.sourceFingerprints)
      ? source.sourceFingerprints.filter(item => item && Number.isFinite(Number(item.index)) && item.hash).map(item => ({
        index: Math.max(0, Math.round(Number(item.index))),
        id: String(item.id || ''),
        hash: String(item.hash),
      }))
      : [],
    children: Array.isArray(source.children) ? [...new Set(source.children.map(String).filter(Boolean))] : [],
    status: ['active', 'retired', 'stale'].includes(source.status) ? source.status : 'active',
    useRaw: source.useRaw === true,
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now(),
  };
}

export function setBlockUseRaw(memory, blockId, useRaw) {
  const normalized = normalizeMemory(memory);
  const block = normalized.blocks.find(item => item.id === String(blockId || ''));
  if (!block) throw new Error('Memory block not found');
  if (block.status !== 'active') throw new Error('Only active blocks can expose their raw source');
  block.useRaw = useRaw === true;
  return normalized;
}

export function sumTokens(entries = []) {
  return entries.reduce((total, entry) => total + Math.max(0, Number(entry?.tokens) || Number(entry?.summaryTokens) || 0), 0);
}

export function chunkByTokenBudget(entries = [], budgetTokens = 1) {
  const budget = Math.max(1, Number(budgetTokens) || 1);
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const entry of entries) {
    const tokens = Math.max(0, Number(entry?.tokens) || Number(entry?.summaryTokens) || 0);
    if (current.length && currentTokens + tokens > budget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(entry);
    currentTokens += tokens;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function splitTextByTokenBudget(text, budgetTokens, countTokens) {
  const source = String(text || '');
  const budget = Math.max(1, Number(budgetTokens) || 1);
  if (!source || await countTokens(source) <= budget) return source ? [source] : [];

  const chunks = [];
  let offset = 0;
  while (offset < source.length) {
    let low = offset + 1;
    let high = source.length;
    let best = offset;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = source.slice(offset, middle);
      if (await countTokens(candidate) <= budget) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (best <= offset) best = Math.min(source.length, offset + 1);
    if (best < source.length) {
      const minimumBoundary = offset + Math.floor((best - offset) * 0.6);
      const paragraphBoundary = source.lastIndexOf('\n', best - 1);
      const wordBoundary = source.lastIndexOf(' ', best - 1);
      const preferredBoundary = Math.max(paragraphBoundary, wordBoundary);
      if (preferredBoundary >= minimumBoundary) best = preferredBoundary + 1;
    }

    chunks.push(source.slice(offset, best));
    offset = best;
  }
  return chunks;
}

export function getActiveBlocks(memory) {
  return normalizeMemory(memory).blocks
    .filter(block => block.status === 'active')
    .sort((a, b) => a.sourceFrom - b.sourceFrom || a.level - b.level || a.createdAt - b.createdAt);
}

export function getActiveFrontier(memoryOrBlocks) {
  const blocks = Array.isArray(memoryOrBlocks)
    ? memoryOrBlocks.filter(block => block?.status === 'active')
    : getActiveBlocks(memoryOrBlocks);
  const sorted = [...blocks].sort((a, b) => a.sourceFrom - b.sourceFrom || a.sourceTo - b.sourceTo || a.level - b.level);
  const frontier = [];
  let coveredThrough = -1;

  for (const block of sorted) {
    const rawSourceFrom = Number(block.sourceFrom);
    const sourceFrom = Number.isFinite(rawSourceFrom) ? rawSourceFrom : 0;
    const sourceTo = Number(block.sourceTo);
    if (!Number.isFinite(sourceTo) || sourceTo < sourceFrom) continue;
    if (sourceFrom > coveredThrough + 1) break;
    if (sourceTo <= coveredThrough) continue;
    frontier.push(block);
    coveredThrough = sourceTo;
  }

  return { blocks: frontier, coveredThrough };
}

export function getBlockAncestorIds(memory, blockId) {
  const blocks = normalizeMemory(memory).blocks;
  const targetId = String(blockId || '');
  if (!blocks.some(block => block.id === targetId)) return [];
  const ancestors = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (block.id === targetId || ancestors.has(block.id)) continue;
      if (block.children.some(childId => childId === targetId || ancestors.has(childId))) {
        ancestors.add(block.id);
        changed = true;
      }
    }
  }
  return [...ancestors];
}

export function deleteMemoryBlock(memory, blockId) {
  const normalized = normalizeMemory(memory);
  const targetId = String(blockId || '');
  if (!normalized.blocks.some(block => block.id === targetId)) {
    throw new Error('Memory block not found');
  }

  const removedIds = new Set([targetId, ...getBlockAncestorIds(normalized, targetId)]);
  const removedBlocks = normalized.blocks.filter(block => removedIds.has(block.id));
  const reactivationCandidates = new Set(
    removedBlocks.flatMap(block => block.children).filter(childId => !removedIds.has(childId)),
  );
  normalized.blocks = normalized.blocks.filter(block => !removedIds.has(block.id));

  const remainingReferences = new Set(normalized.blocks.flatMap(block => block.children));
  const reactivatedIds = [];
  for (const block of normalized.blocks) {
    if (reactivationCandidates.has(block.id) && !remainingReferences.has(block.id) && block.status === 'retired') {
      block.status = 'active';
      reactivatedIds.push(block.id);
    }
  }

  const frontierIds = new Set(getActiveFrontier(normalized.blocks).blocks.map(block => block.id));
  const staleIds = [];
  for (const block of normalized.blocks) {
    if (block.status === 'active' && !frontierIds.has(block.id)) {
      block.status = 'stale';
      block.sourceFingerprints = [];
      staleIds.push(block.id);
    }
  }

  return {
    memory: normalized,
    removedIds: [...removedIds],
    reactivatedIds,
    staleIds,
  };
}

export function editMemoryBlock(memory, blockId, structured, summaryTokens = 0) {
  const normalized = normalizeMemory(memory);
  const targetId = String(blockId || '');
  const target = normalized.blocks.find(block => block.id === targetId);
  if (!target) throw new Error('Memory block not found');
  const edited = parseStructuredSummary(structured);
  target.structured = edited;
  target.summaryTokens = Math.max(0, Math.round(Number(summaryTokens) || 0));

  const dependentIds = new Set(getBlockAncestorIds(normalized, targetId));
  const reactivationCandidates = new Set();
  for (const block of normalized.blocks) {
    if (!dependentIds.has(block.id)) continue;
    block.status = 'stale';
    block.sourceFingerprints = [];
    for (const childId of block.children) {
      if (!dependentIds.has(childId)) reactivationCandidates.add(childId);
    }
  }

  const survivingReferences = new Set(
    normalized.blocks
      .filter(block => !dependentIds.has(block.id) && ['active', 'retired'].includes(block.status))
      .flatMap(block => block.children),
  );
  const reactivatedIds = [];
  for (const block of normalized.blocks) {
    if (reactivationCandidates.has(block.id) && !survivingReferences.has(block.id) && block.status === 'retired') {
      block.status = 'active';
      reactivatedIds.push(block.id);
    }
  }

  const frontierIds = new Set(getActiveFrontier(normalized.blocks).blocks.map(block => block.id));
  const staleIds = [...dependentIds];
  for (const block of normalized.blocks) {
    if (block.status === 'active' && !frontierIds.has(block.id)) {
      block.status = 'stale';
      block.sourceFingerprints = [];
      if (!staleIds.includes(block.id)) staleIds.push(block.id);
    }
  }

  return {
    memory: normalized,
    editedId: targetId,
    dependentIds: [...dependentIds],
    reactivatedIds,
    staleIds,
  };
}

export async function stageBlockRegeneration({
  memory,
  blockId,
  createReplacement,
  onStage = () => {},
} = {}) {
  if (typeof createReplacement !== 'function') throw new Error('createReplacement callback is required');
  const candidate = normalizeMemory(memory);
  const targetId = String(blockId || '');
  const selected = candidate.blocks.find(block => block.id === targetId);
  if (!selected) throw new Error('Memory block not found');

  const ancestorIds = getBlockAncestorIds(candidate, targetId)
    .sort((leftId, rightId) => {
      const left = candidate.blocks.find(block => block.id === leftId);
      const right = candidate.blocks.find(block => block.id === rightId);
      return (left?.level || 0) - (right?.level || 0) || (left?.createdAt || 0) - (right?.createdAt || 0);
    });
  const regenerationIds = [targetId, ...ancestorIds];

  for (let position = 0; position < regenerationIds.length; position++) {
    const id = regenerationIds[position];
    const index = candidate.blocks.findIndex(block => block.id === id);
    const current = candidate.blocks[index];
    if (!current) throw new Error(`Dependent block ${id} no longer exists`);
    await onStage({ block: current, position, total: regenerationIds.length });
    const generated = await createReplacement(current, candidate);
    const replacement = normalizeBlock({
      ...generated,
      id: current.id,
      status: current.status,
      useRaw: current.useRaw,
      children: [...current.children],
      sourceFrom: current.sourceFrom,
      sourceTo: current.sourceTo,
    });
    if (!replacement) throw new Error(`Regenerated block ${id} is invalid`);
    candidate.blocks[index] = replacement;
  }

  return { memory: candidate, regeneratedIds: regenerationIds };
}

export function selectTail(entries, tailBudgetTokens, minimumMessages = 2) {
  const list = Array.isArray(entries) ? entries : [];
  const budget = Math.max(0, Number(tailBudgetTokens) || 0);
  let tailTokens = 0;
  let splitIndex = list.length;

  for (let index = list.length - 1; index >= 0; index--) {
    const entryTokens = Math.max(0, Number(list[index]?.tokens) || 0);
    const retainedCount = list.length - index;
    const mustKeep = retainedCount <= minimumMessages;
    if (!mustKeep && tailTokens + entryTokens > budget) break;
    tailTokens += entryTokens;
    splitIndex = index;
  }

  return {
    source: list.slice(0, splitIndex),
    tail: list.slice(splitIndex),
    sourceTokens: sumTokens(list.slice(0, splitIndex)),
    tailTokens,
    splitIndex,
  };
}

export function buildCompactionPlan({
  contextBudget,
  fixedPromptTokens = 0,
  blocks = [],
  rawEntries = [],
  settings = DEFAULT_SETTINGS,
  force = false,
} = {}) {
  const normalized = normalizeSettings(settings);
  const grossBudget = Math.max(1, Math.floor(Number(contextBudget) || 1));
  const fixedTokens = Math.max(0, Math.floor(Number(fixedPromptTokens) || 0));
  const usableBudget = Math.max(1, grossBudget - fixedTokens);
  const grossTriggerTokens = Math.floor(grossBudget * normalized.triggerRatio);
  const triggerTokens = Math.max(1, grossTriggerTokens - fixedTokens);
  const tailBudgetTokens = Math.min(usableBudget, Math.floor(grossBudget * (1 - normalized.triggerRatio)));
  const archiveLimitTokens = Math.max(normalized.blockTargetTokens, triggerTokens);
  const effectiveMinimumSourceTokens = Math.min(
    normalized.minimumSourceTokens,
    Math.max(512, triggerTokens - tailBudgetTokens),
  );
  const activeBlocks = blocks
    .filter(block => block?.status === 'active')
    .sort((left, right) => left.sourceFrom - right.sourceFrom || left.sourceTo - right.sourceTo || left.level - right.level);
  const blockTokens = activeBlocks.reduce(
    (total, block) => total + Math.max(0, Number(block.useRaw ? (block.rawTokens ?? block.sourceTokens) : block.summaryTokens) || 0),
    0,
  );
  const summaryTierTokens = sumTokens(activeBlocks.filter(block => !block.useRaw));
  const rawTokens = sumTokens(rawEntries);
  const totalTokens = blockTokens + rawTokens;
  const hardOverflow = totalTokens > usableBudget;
  const selection = selectTail(rawEntries, tailBudgetTokens, 2);
  const budget = {
    usableBudget, grossTriggerTokens, triggerTokens, tailBudgetTokens, archiveLimitTokens,
    blockTokens, summaryTierTokens, rawTokens, totalTokens, effectiveMinimumSourceTokens, rawEntries,
  };
  // Small sources need small outputs; the configured target is a ceiling.
  const targetForSource = tokens => Math.min(normalized.blockTargetTokens, Math.max(256, Math.floor(tokens / 2)));
  const desiredRawTarget = targetForSource(selection.sourceTokens);
  const rawWorthCompacting = selection.source.length > 0
    && (force || hardOverflow || selection.sourceTokens >= effectiveMinimumSourceTokens);
  // Reserve the same 10% output tolerance that createBlock accepts.
  const availableForRaw = usableBudget - blockTokens - selection.tailTokens;
  const memoryPressure = hardOverflow
    || ((force || totalTokens >= triggerTokens) && rawWorthCompacting && Math.ceil(desiredRawTarget * 1.1) > availableForRaw);

  const rollupRuns = [];
  let currentRun = [];
  for (const block of activeBlocks) {
    if (block.useRaw) {
      if (currentRun.length) rollupRuns.push(currentRun);
      currentRun = [];
    } else {
      currentRun.push(block);
    }
  }
  if (currentRun.length) rollupRuns.push(currentRun);
  const rollupCandidates = rollupRuns.filter(run => run.length > 1).map(run => {
    const tokens = sumTokens(run);
    const targetTokens = targetForSource(tokens);
    return { blocks: run, tokens, targetTokens, projectedTokens: totalTokens - tokens + targetTokens };
  }).filter(candidate => Math.ceil(candidate.targetTokens * 1.1) < candidate.tokens);
  const rollupCandidate = rollupCandidates.find(candidate =>
    candidate.tokens >= archiveLimitTokens || memoryPressure);
  if (rollupCandidate) {
    return {
      ...budget,
      kind: 'summaries',
      projectedTokens: rollupCandidate.projectedTokens,
      blocks: rollupCandidate.blocks,
      targetTokens: rollupCandidate.targetTokens,
    };
  }

  if (!force && totalTokens < triggerTokens) {
    return { ...budget, kind: 'none', reason: 'below-trigger' };
  }
  const targetTokens = Math.min(desiredRawTarget, Math.floor(availableForRaw / 1.1));
  const rawFits = targetTokens >= 256 && Math.ceil(targetTokens * 1.1) < selection.sourceTokens;
  if (!rawWorthCompacting || !rawFits) {
    // A hypothetical oversized result must not block a conversation that fits.
    if (!hardOverflow) {
      const reason = !selection.source.length ? 'no-cold-source'
        : selection.sourceTokens < effectiveMinimumSourceTokens ? 'source-too-small'
        : 'no-space-for-summary';
      return { ...budget, ...selection, kind: 'none', reason };
    }
    return {
      ...budget, ...selection,
      kind: 'blocked',
      reason: activeBlocks.some(block => block.useRaw) ? 'raw-over-budget' : 'context-over-budget',
      overflowTokens: totalTokens - usableBudget,
    };
  }
  return {
    ...budget, ...selection,
    kind: 'raw',
    projectedTokens: blockTokens + targetTokens + selection.tailTokens,
    targetTokens,
  };
}

export function commitRawBlock(memory, block) {
  const normalized = normalizeMemory(memory);
  const next = normalizeBlock({ ...block, status: 'active', level: block.level || 1 });
  if (!next) throw new Error('Invalid raw summary block');
  normalized.blocks.push(next);
  return normalized;
}

export function commitSummaryRollup(memory, block, childIds) {
  const normalized = normalizeMemory(memory);
  const children = new Set((childIds || []).map(String));
  for (const existing of normalized.blocks) {
    if (children.has(existing.id) && existing.status === 'active') {
      existing.status = 'retired';
      existing.sourceFingerprints = [];
    }
  }
  const next = normalizeBlock({ ...block, status: 'active', children: [...children] });
  if (!next) throw new Error('Invalid summary rollup block');
  normalized.blocks.push(next);
  return normalized;
}

export function getManualRollupBlocks(memory, childIds) {
  const normalized = normalizeMemory(memory);
  const requestedIds = [...new Set((childIds || []).map(String))];
  if (requestedIds.length < 2) throw new Error('Select at least two blocks');

  const frontier = getActiveFrontier(normalized).blocks;
  const positions = requestedIds.map(id => frontier.findIndex(block => block.id === id));
  if (positions.some(position => position < 0)) throw new Error('Manual rollup accepts active frontier blocks only');

  const selected = positions
    .map(position => frontier[position])
    .sort((left, right) => left.sourceFrom - right.sourceFrom);
  const sourceLevel = selected[0].level;
  if (selected.some(block => block.level !== sourceLevel)) throw new Error('Selected blocks must have the same level');
  if (selected.some(block => block.useRaw)) throw new Error('Raw-exposed blocks cannot be rolled up');

  const selectedPositions = selected.map(block => frontier.findIndex(item => item.id === block.id));
  for (let index = 1; index < selected.length; index++) {
    if (selectedPositions[index] !== selectedPositions[index - 1] + 1) {
      throw new Error('Selected blocks must be adjacent in the active frontier');
    }
    if (selected[index].sourceFrom !== selected[index - 1].sourceTo + 1) {
      throw new Error('Selected blocks must cover a contiguous source range');
    }
  }
  return selected;
}

export async function stageManualRollup({
  memory,
  childIds,
  targetTokens = DEFAULT_SETTINGS.blockTargetTokens,
  createBlock,
  validateBlock = () => {},
} = {}) {
  if (typeof createBlock !== 'function') throw new Error('createBlock callback is required');
  const children = getManualRollupBlocks(memory, childIds);
  const sourceLevel = children[0].level;
  const targetLevel = sourceLevel + 1;
  const generated = await createBlock({
    level: targetLevel,
    childBlocks: children,
    targetTokens: Math.max(1, Math.round(Number(targetTokens) || DEFAULT_SETTINGS.blockTargetTokens)),
  });
  const rollupBlock = normalizeBlock({
    ...generated,
    level: targetLevel,
    status: 'active',
    useRaw: false,
    sourceFrom: children[0].sourceFrom,
    sourceTo: children.at(-1).sourceTo,
    children: children.map(block => block.id),
  });
  if (!rollupBlock) throw new Error('Manual rollup returned an invalid block');
  await validateBlock(rollupBlock, `manual L${sourceLevel} to L${targetLevel} rollup`);
  return {
    memory: commitSummaryRollup(memory, rollupBlock, children.map(block => block.id)),
    rollupBlock,
    childIds: children.map(block => block.id),
    sourceLevel,
    targetLevel,
  };
}

export async function stageCompactionTransaction({
  plan,
  memory,
  contextBudget,
  fixedPromptTokens = 0,
  settings = DEFAULT_SETTINGS,
  createBlock,
  validateBlock = () => {},
  onStage = () => {},
} = {}) {
  if (typeof createBlock !== 'function') throw new Error('createBlock callback is required');
  let candidate = normalizeMemory(memory);
  let remainingRaw = plan?.rawEntries || [];
  let nextPlan = plan;
  let rawBlock = null;
  let rollupBlock = null;
  let rollupPlan = null;
  // Every stage consumes cold messages or reduces the number of active blocks.
  // Keep the real tail in each budget check and publish only the final candidate.
  while (nextPlan && nextPlan.kind !== 'none') {
    if (nextPlan.kind === 'blocked') throw new Error(describeBlockedPlan(nextPlan));
    const isRaw = nextPlan.kind === 'raw';
    if (!isRaw && nextPlan.kind !== 'summaries') throw new Error(`Unknown compaction plan kind: ${nextPlan.kind}`);
    const level = isRaw ? 1 : Math.max(...nextPlan.blocks.map(block => block.level)) + 1;
    await onStage({ kind: nextPlan.kind, plan: nextPlan, level });
    const block = await createBlock({
      level,
      ...(isRaw ? { sourceEntries: nextPlan.source } : { childBlocks: nextPlan.blocks }),
      targetTokens: nextPlan.targetTokens,
    });
    await validateBlock(block, isRaw ? 'raw compaction' : 'summary rollup');
    const sourceTokens = isRaw ? nextPlan.sourceTokens : sumTokens(nextPlan.blocks);
    if (!(block?.summaryTokens > 0) || block.summaryTokens >= sourceTokens) {
      throw new Error('Summary did not reduce the source size. Use a smaller block target or another summarizer.');
    }
    if (isRaw) {
      candidate = commitRawBlock(candidate, block);
      remainingRaw = nextPlan.tail;
      rawBlock = block;
    } else {
      candidate = commitSummaryRollup(candidate, block, nextPlan.blocks.map(child => child.id));
      rollupBlock = block;
      rollupPlan = nextPlan;
    }
    nextPlan = buildCompactionPlan({
      contextBudget, fixedPromptTokens, settings,
      blocks: getActiveFrontier(candidate).blocks,
      rawEntries: remainingRaw,
    });
  }
  return { memory: candidate, rawBlock, rollupBlock, rollupPlan, finalPlan: nextPlan };
}

export function describeBlockedPlan(plan) {
  const prefix = `Context exceeds the budget by ${plan.overflowTokens} tokens.`;
  return plan.reason === 'raw-over-budget'
    ? `${prefix} Restore a hidden summary or increase the context size.`
    : `${prefix} The remaining messages cannot be compacted. Increase the context size or shorten the latest messages.`;
}

export function getCoveredThrough(blocks = []) {
  return getActiveFrontier(blocks).coveredThrough;
}

export function renderBlockText(block, includeStructuredMemory = true) {
  const structured = block.structured || {};
  const payload = {
    type: 'memory_block',
    level: Math.max(1, Number(block.level) || 1),
    source: [Math.max(0, Number(block.sourceFrom) || 0), Math.max(0, Number(block.sourceTo) || 0)],
    narrative: String(structured.narrative || '').trim(),
  };
  if (includeStructuredMemory) {
    for (const field of SUMMARY_ARRAY_FIELDS) payload[field] = Array.isArray(structured[field]) ? structured[field] : [];
  }
  return JSON.stringify(payload);
}

export function renderActiveMemory(blocks, includeStructuredMemory = true) {
  return blocks
    .filter(block => block?.status === 'active' && !block.useRaw)
    .sort((a, b) => a.sourceFrom - b.sourceFrom || a.level - b.level)
    .map(block => renderBlockText(block, includeStructuredMemory))
    .join('\n\n');
}

export function rewriteConversationWithMemory(
  coreChat,
  memoryOrBlocks,
  makeMemoryMessage,
  includeStructuredMemory = true,
) {
  if (!Array.isArray(coreChat)) throw new Error('Conversation must be an array');
  if (typeof makeMemoryMessage !== 'function') throw new Error('Memory message factory is required');
  const activeBlocks = getActiveFrontier(memoryOrBlocks).blocks;
  if (!activeBlocks.length) return { messages: [...coreChat], activeBlocks, coveredThrough: -1 };

  const coveredThrough = getCoveredThrough(activeBlocks);
  const messages = [];
  let summaryRun = [];
  const flushSummaryRun = () => {
    if (!summaryRun.length) return;
    const text = renderActiveMemory(summaryRun, includeStructuredMemory);
    if (text) messages.push(makeMemoryMessage(text));
    summaryRun = [];
  };

  for (const block of activeBlocks) {
    if (!block.useRaw) {
      summaryRun.push(block);
      continue;
    }
    flushSummaryRun();
    const rawRange = coreChat.filter(message => {
      const index = Number(message?.index);
      return index >= block.sourceFrom && index <= block.sourceTo;
    });
    const expectedCount = block.sourceTo - block.sourceFrom + 1;
    if (rawRange.length !== expectedCount) {
      throw new Error(`Raw source ${block.sourceFrom}–${block.sourceTo} is unavailable in the outgoing conversation`);
    }
    messages.push(...rawRange);
  }
  flushSummaryRun();
  messages.push(...coreChat.filter(message => Number(message?.index) > coveredThrough));
  return { messages, activeBlocks, coveredThrough };
}
