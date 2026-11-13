import { commitRawBlock, DEFAULT_SETTINGS, getActiveBlocks, normalizeMemory, splitRawRuns, sumTokens } from './core.mjs';
import { findCurrentMessage, fingerprintMessage } from './source-identity.mjs';
import { LocalizedError, message as msg } from './i18n.mjs';

function readIndex(value) {
  const index = Number(value);
  if (!/^\d+$/.test(String(value ?? '')) || !Number.isSafeInteger(index)) {
    throw new LocalizedError(msg('Enter a valid message number.'));
  }
  return index;
}

const hidden = message => message.extra?.[Symbol.for('ignore')];
const overlapsRange = (block, from, to) => block.sourceFrom <= to && from <= block.sourceTo;
const numberOf = message => message.chatIndex ?? message.index;

function resolveCheckpoint(chat, checkpoint) {
  const message = findCurrentMessage(chat, checkpoint);
  return message && !hidden(message) && (checkpoint.id || fingerprintMessage(message).hash === checkpoint.hash) ? message : null;
}

export function listCheckpoints(memory, chat) {
  const marks = new Map();
  for (const checkpoint of memory.checkpoints || []) {
    const message = resolveCheckpoint(chat, checkpoint);
    if (message) marks.set(message.index, message);
  }
  return [...marks.values()].sort((a, b) => a.index - b.index);
}

export function changeCheckpoint(memory, chat, at, marked) {
  const index = at === undefined && marked ? null : readIndex(at);
  const target = index === null ? chat.at(-1) : chat.find(message => numberOf(message) === index);
  if (!target || hidden(target)) throw new LocalizedError(msg('This message is not available for a checkpoint.'));
  const next = normalizeMemory(memory);
  const checkpoints = listCheckpoints(next, chat).filter(message => message.index !== target.index);
  if (marked) checkpoints.push(target);
  if (checkpoints.length) next.checkpoints = checkpoints.map(fingerprintMessage);
  else delete next.checkpoints;
  return next;
}

export function prepareManualRange(memory, chat, from, to) {
  const first = readIndex(from), last = readIndex(to);
  if (first > last) throw new LocalizedError(msg('The range start must not exceed its end.'));
  const source = chat.filter(message => numberOf(message) >= first && numberOf(message) <= last);
  if (source.some(hidden)) throw new LocalizedError(msg('This range includes hidden messages. Restore them before summarizing.'));
  if (!source.length || numberOf(source[0]) !== first || numberOf(source.at(-1)) !== last) {
    throw new LocalizedError(msg('Choose an available range of chat messages.'));
  }
  const overlaps = getActiveBlocks(memory).filter(block => overlapsRange(block, source[0].index, source.at(-1).index));
  return { source, overlaps };
}

export async function stageManualCompaction({
  memory, rawEntries, checkpointIndices = [], replaceOverlaps = false, requireReduction = false, targetTokens = DEFAULT_SETTINGS.blockTargetTokens,
  partitionRawSource, createBlock, validateBlock = () => {}, onStage = () => {}, onCheckpoint = () => {},
}) {
  let candidate = normalizeMemory(memory);
  const active = getActiveBlocks(candidate);
  if (!replaceOverlaps && rawEntries.some(entry => active.some(block => overlapsRange(block, entry.index, entry.index)))) {
    throw new LocalizedError(msg('The selected messages overlap active memory blocks.'));
  }
  const groups = [];
  for (const run of splitRawRuns(rawEntries, checkpointIndices)) groups.push(...await partitionRawSource(run, targetTokens));
  const rawBlocks = [];
  for (const [index, sourceEntries] of groups.entries()) {
    const sourceFrom = sourceEntries[0].index, sourceTo = sourceEntries.at(-1).index;
    const target = Math.min(targetTokens, Math.max(256, Math.floor(sumTokens(sourceEntries) / 2)));
    await onStage(index + 1, groups.length, sumTokens(sourceEntries), target);
    const block = await createBlock({ level: 1, sourceEntries, targetTokens: target });
    await validateBlock(block, msg('raw compaction'));
    if (block.level !== 1 || block.sourceFrom !== sourceFrom || block.sourceTo !== sourceTo || !(block.summaryTokens > 0)) {
      throw new LocalizedError(msg('Invalid raw summary block'));
    }
    if (requireReduction && block.summaryTokens >= sumTokens(sourceEntries)) {
      throw new LocalizedError(msg('Summary did not reduce the source size. Use a smaller block target or another summarizer.'));
    }
    // Replace coverage only after its first overlapping L1 is ready. Uncovered
    // portions of the archived block return to the original conversation.
    candidate = commitRawBlock({
      ...candidate,
      blocks: candidate.blocks.map(existing => existing.status === 'active' && overlapsRange(existing, sourceFrom, sourceTo)
        ? { ...existing, status: 'retired' } : existing),
    }, block);
    await onCheckpoint(candidate);
    rawBlocks.push(block);
  }
  return { memory: candidate, rawBlocks };
}
