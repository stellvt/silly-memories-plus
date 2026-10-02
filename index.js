import {
  chat_metadata,
  eventSource,
  event_types,
  extractMessageFromData,
  generateRawData,
  getCurrentChatId,
  getMaxPromptTokens,
  saveChatConditional,
  saveSettingsDebounced,
} from '../../../../script.js';
import {
  extension_settings,
  getContext,
  renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { system_message_types } from '../../../system-messages.js';
import { promptManager } from '../../../openai.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import {
  buildCompactionPlan,
  chunkByTokenBudget,
  createEmptyMemory,
  DEFAULT_PROMPTS,
  deleteMemoryBlock,
  describeBlockedPlan,
  editMemoryBlock,
  getActiveBlocks,
  getActiveFrontier,
  getBlockAncestorIds,
  getManualRollupBlocks,
  normalizeMemory,
  normalizeSettings,
  parseStructuredSummary,
  renderBlockText,
  rewriteConversationWithMemory,
  setBlockUseRaw,
  stageBlockRegeneration,
  stageCompactionTransaction,
  stageManualRollup,
  SUMMARY_JSON_SCHEMA,
  sumTokens,
} from './lib/core.mjs';
import {
  assertSummaryRequestFits,
  formatIntermediateSources,
  formatRawSources,
  formatSummarySources,
  getSummarySourceBudget,
  splitOversizedRawEntries,
} from './lib/summarizer.mjs';
import {
  BLOCK_EDITOR_FIELDS,
  renderBlockCard,
  renderRegenerationComparison,
} from './lib/ui.mjs';

const EXTENSION_ID = 'silly_memories_plus';
const EXTENSION_PATH = 'third-party/silly-memories-plus';
const MEMORY_KEY = 'silly_memories_plus';
const INTERCEPTOR_NAME = 'sillyMemoriesPlusGenerateInterceptor';
const LOG_PREFIX = '[Silly Memories Plus]';
const runtime = {
  summarizing: false,
  queued: false,
  forceCompaction: false,
  renderPromise: null,
  lastPlan: null,
  lastStatus: { kind: 'idle', text: 'Ready.' },
  abortController: null,
  fallbackSummaryActive: false,
  cancelRequested: false,
  activeCompactionChatId: null,
  fixedPromptTokensByChat: new Map(),
  pendingPromptMeasurement: null,
  selectedBlockId: null,
  editingBlockId: null,
  manualRollupIds: new Set(),
  libraryTab: 'active',
  regenerationBlockId: null,
  regenerationPreview: null,
};
let settingsInitialized = false;

function getSettings() {
  if (!settingsInitialized) {
    const previous = extension_settings[EXTENSION_ID];
    const normalized = normalizeSettings(previous || {});
    extension_settings[EXTENSION_ID] = normalized;
    settingsInitialized = true;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(normalized)) saveSettingsDebounced();
  }
  return extension_settings[EXTENSION_ID];
}

function updateSettings(mutator) {
  const draft = structuredClone(getSettings());
  mutator(draft);
  extension_settings[EXTENSION_ID] = normalizeSettings(draft);
  saveSettingsDebounced();
  return extension_settings[EXTENSION_ID];
}

function debug(...args) {
  if (getSettings().debug) console.debug(LOG_PREFIX, ...args);
}

function setStatus(kind, text) {
  runtime.lastStatus = { kind, text };
  const element = document.getElementById('smp-status');
  if (element) {
    element.dataset.kind = kind;
    element.textContent = text;
  }
  updateJobControls();
}

function updateJobControls() {
  const cancel = document.getElementById('smp-cancel');
  if (cancel) cancel.disabled = !runtime.summarizing || runtime.cancelRequested;
  for (const id of ['smp-generate-preview', 'smp-save-preview', 'smp-close-regeneration', 'smp-discard-preview', 'smp-compact-now', 'smp-test-summarizer', 'smp-clear']) {
    const button = document.getElementById(id);
    if (button) button.disabled = runtime.summarizing || (id === 'smp-save-preview' && !runtime.regenerationPreview);
  }
  const wish = document.getElementById('smp-regeneration-wish');
  if (wish) wish.disabled = runtime.summarizing;
  const close = document.getElementById('smp-close-regeneration');
  if (close) close.hidden = Boolean(runtime.regenerationPreview);
  for (const tab of document.querySelectorAll('[data-smp-tab]')) tab.disabled = runtime.summarizing;
}

function beginMemoryJob(chatId = null) {
  if (runtime.summarizing) throw new Error('Another memory job is already running');
  runtime.summarizing = true;
  runtime.cancelRequested = false;
  runtime.abortController = new AbortController();
  runtime.activeCompactionChatId = chatId;
  updateBlockActionBar();
  updateManualRollupControls();
  updateJobControls();
}

function endMemoryJob() {
  runtime.abortController = null;
  runtime.activeCompactionChatId = null;
  runtime.summarizing = false;
  runtime.cancelRequested = false;
  updateBlockActionBar();
  updateManualRollupControls();
  updateJobControls();
}

function getChatMemory() {
  const context = getContext();
  if (!Array.isArray(context?.chat) || !context.chat.length) return createEmptyMemory();
  const memory = normalizeMemory(chat_metadata[MEMORY_KEY] || {});
  chat_metadata[MEMORY_KEY] = memory;
  return memory;
}

async function setChatMemory(memory, save = true, expectedChatId = null) {
  if (expectedChatId !== null && getCurrentChatId() !== expectedChatId) {
    throw new Error('Refusing to write memory after chat change');
  }
  const context = getContext();
  if (!Array.isArray(context?.chat) || !context.chat.length) return;
  closeRegeneration();
  chat_metadata[MEMORY_KEY] = normalizeMemory(memory);
  if (save) {
    await saveChatConditional();
    if (expectedChatId !== null && getCurrentChatId() !== expectedChatId) {
      throw new Error('Chat changed while saving memory');
    }
  }
  renderLibrary();
}

function fastHash(value) {
  const source = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getMessageIdentity(message) {
  return String(message?.id ?? message?.extra?.sillyFriends?.clientMsgId ?? '');
}

function fingerprintMessage(message) {
  const index = Math.max(0, Number(message?.index) || 0);
  const id = getMessageIdentity(message);
  const role = message?.is_user ? 'user' : 'assistant';
  const content = String(message?.mes || '');
  return { index, id, hash: fastHash(`${role}\u0000${message?.name || ''}\u0000${content}`) };
}

function buildSourceHash(fingerprints) {
  return fastHash(fingerprints.map(item => `${item.index}:${item.id}:${item.hash}`).join('|'));
}

function findCurrentMessage(coreChat, fingerprint) {
  if (fingerprint.id) {
    const byId = coreChat.find(message => getMessageIdentity(message) === fingerprint.id);
    if (byId) return byId;
  }
  return coreChat.find(message => Number(message?.index) === Number(fingerprint.index));
}

function getCurrentComparableChat() {
  const context = getContext();
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  return chat
    .filter(message => !message?.is_system || Array.isArray(message?.extra?.tool_invocations))
    .map((message, index) => ({ ...message, index }));
}

function fingerprintsStillMatch(fingerprints) {
  const current = getCurrentComparableChat();
  return fingerprints.every(fingerprint => {
    const message = findCurrentMessage(current, fingerprint);
    return Boolean(message && fingerprintMessage(message).hash === fingerprint.hash);
  });
}

function activeMemoryIsValid(rawChat, memory) {
  const active = getActiveBlocks(memory);
  for (const block of active) {
    for (const fingerprint of block.sourceFingerprints || []) {
      const rawMessage = findCurrentMessage(rawChat, fingerprint);
      if (!rawMessage || fingerprintMessage(rawMessage).hash !== fingerprint.hash) return false;
    }
  }
  return true;
}

async function invalidateActiveMemory(memory, reason) {
  let changed = false;
  for (const block of memory.blocks) {
    if (block.status === 'active') {
      block.status = 'stale';
      block.sourceFingerprints = [];
      changed = true;
    }
  }
  if (changed) {
    await setChatMemory(memory);
    setStatus('warning', reason);
  }
  return changed;
}

async function repairActiveFrontier(memory) {
  const active = getActiveBlocks(memory);
  const frontierIds = new Set(getActiveFrontier(active).blocks.map(block => block.id));
  const orphaned = active.filter(block => !frontierIds.has(block.id));
  if (!orphaned.length) return memory;
  for (const block of memory.blocks) {
    if (orphaned.some(orphan => orphan.id === block.id)) {
      block.status = 'stale';
      block.sourceFingerprints = [];
    }
  }
  const message = `Marked ${orphaned.length} non-contiguous active block(s) stale.`;
  await setChatMemory(memory);
  setStatus('warning', message);
  return memory;
}

async function countCoreChat(coreChat) {
  const counts = await Promise.all(coreChat.map(async message => ({
    message,
    index: Math.max(0, Number(message?.index) || 0),
    tokens: await getTokenCountAsync(String(message?.mes || ''), 0),
  })));
  return counts;
}

async function refreshActiveBlockTokenCounts(memory, settings) {
  for (const block of memory.blocks) {
    if (block.status !== 'active') continue;
    block.summaryTokens = await getTokenCountAsync(renderBlockText(block, settings.includeStructuredMemory), 0);
    if (block.useRaw) block.rawTokens = sumTokens(await countCoreChat(getBlockRangeMessages(block)));
  }
  return memory;
}

async function requestSummary(prompt, targetTokens, level, stage, instruction = '') {
  if (runtime.cancelRequested) throw new Error('Compaction cancelled');
  if (runtime.activeCompactionChatId !== null && getCurrentChatId() !== runtime.activeCompactionChatId) {
    throw new Error('Chat changed during compaction');
  }
  const settings = getSettings();
  const countTokens = value => getTokenCountAsync(value, 0);
  const { usefulOutputTokens, requestMaxTokens, systemPrompt } = await getSummarySourceBudget({
    settings,
    stage,
    targetTokens,
    level,
    instruction,
    countTokens,
  });
  await assertSummaryRequestFits({ settings, prompt, systemPrompt, requestMaxTokens, countTokens });
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  const getFinishReason = response => String(
    response?.choices?.[0]?.finish_reason
    || response?.candidates?.[0]?.finishReason
    || response?.stop_reason
    || '',
  );
  const validateResponse = async (response, finishReason = '') => {
    const rawText = typeof response === 'string' ? response.trim() : '';
    if (/<!--\s*oai-proxy-error\s*-->/i.test(rawText) || /^###\s*\*\*Proxy error/im.test(rawText)) {
      const note = rawText.match(/"proxy_note"\s*:\s*"([^"]+)"/i)?.[1]
        || rawText.match(/^\*([^*\r\n]+)\*/m)?.[1]
        || 'Proxy rejected the summarizer request';
      throw new Error(`Summarizer provider error: ${note}`);
    }

    let structured;
    try {
      structured = parseStructuredSummary(response);
    } catch (error) {
      if (/length|max.?tokens/i.test(finishReason)) {
        throw new Error(`Summarizer stopped at its output limit (${finishReason}); incomplete block was discarded`, { cause: error });
      }
      if (/has no narrative/i.test(String(error?.message || ''))) {
        throw new Error('Summarizer returned an empty structured object; the selected model/provider did not populate the JSON Schema', { cause: error });
      }
      throw error;
    }
    const canonicalText = JSON.stringify(structured);
    const outputTokens = await getTokenCountAsync(canonicalText, 0);
    if (outputTokens > usefulOutputTokens) {
      throw new Error(`Summarizer output exceeded the useful output limit (${outputTokens}/${usefulOutputTokens} tokens)`);
    }
    return canonicalText;
  };

  if (settings.summaryProfileId) {
    const profile = ConnectionManagerRequestService.getProfile(settings.summaryProfileId);
    const apiMap = ConnectionManagerRequestService.validateProfile(profile);
    const response = await ConnectionManagerRequestService.sendRequest(
      settings.summaryProfileId,
      messages,
      requestMaxTokens,
      {
        stream: false,
        extractData: false,
        includePreset: false,
        includeInstruct: false,
        signal: runtime.abortController?.signal || null,
      },
      {
        reasoning_effort: 'min',
        include_reasoning: false,
        json_schema: SUMMARY_JSON_SCHEMA,
      },
    );
    return await validateResponse(extractMessageFromData(response, apiMap.selected), getFinishReason(response));
  }

  runtime.fallbackSummaryActive = true;
  const overrideFallbackPayload = payload => {
    payload.max_tokens = requestMaxTokens;
    payload.reasoning_effort = 'min';
    payload.include_reasoning = false;
    payload.json_schema = SUMMARY_JSON_SCHEMA;
  };
  eventSource.once(event_types.CHAT_COMPLETION_SETTINGS_READY, overrideFallbackPayload);
  try {
    const response = await generateRawData({
      prompt,
      systemPrompt,
      responseLength: requestMaxTokens,
    });
    return await validateResponse(extractMessageFromData(response), getFinishReason(response));
  } finally {
    eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, overrideFallbackPayload);
    runtime.fallbackSummaryActive = false;
  }
}

async function requestStructuredSummary(prompt, targetTokens, level, stage, label, instruction = '') {
  try {
    return parseStructuredSummary(await requestSummary(prompt, targetTokens, level, stage, instruction));
  } catch (error) {
    throw new Error(`${label} failed strict validation`, { cause: error });
  }
}

async function reduceStructuredSummaries(parts, targetTokens, level, round = 1, instruction = '') {
  if (round > 12) throw new Error('Map/reduce did not converge within 12 rounds');
  const { sourceBudget: inputBudget } = await getSummarySourceBudget({
    settings: getSettings(),
    stage: 'rollup',
    targetTokens,
    level,
    instruction,
    countTokens: value => getTokenCountAsync(value, 0),
  });
  const entries = await Promise.all(parts.map(async part => {
    const text = JSON.stringify(part);
    return { part, tokens: await getTokenCountAsync(text, 0) };
  }));
  const groups = chunkByTokenBudget(entries, Math.max(512, Math.floor(inputBudget * 0.9)));

  if (groups.length === 1) {
    return await requestSummary(formatIntermediateSources(groups[0].map(entry => entry.part)), targetTokens, level, 'rollup', instruction);
  }

  setStatus('working', `Recursive reduce round ${round}: ${parts.length} memories in ${groups.length} chunks.`);
  const intermediateTarget = Math.max(256, Math.min(1500, targetTokens, Math.floor(inputBudget / 4)));
  const next = [];
  for (let index = 0; index < groups.length; index++) {
    next.push(await requestStructuredSummary(
      formatIntermediateSources(groups[index].map(entry => entry.part)),
      intermediateTarget,
      level,
      'rollup',
      `Reduce summary ${round}.${index + 1}`,
      instruction,
    ));
  }
  return await reduceStructuredSummaries(next, targetTokens, level + 1, round + 1, instruction);
}

async function createBlock({ level, sourceEntries = [], childBlocks = [], targetTokens, instruction = '' }) {
  const isRaw = level === 1;
  const settings = getSettings();
  const stage = isRaw ? 'raw' : 'rollup';
  const countTokens = value => getTokenCountAsync(value, 0);
  const { sourceBudget: inputBudget } = await getSummarySourceBudget({
    settings,
    stage,
    targetTokens,
    level,
    instruction,
    countTokens,
  });
  const sourceUnits = isRaw ? await splitOversizedRawEntries(sourceEntries, inputBudget, countTokens) : childBlocks;
  const units = await Promise.all(sourceUnits.map(async unit => ({
    ...unit,
    tokens: await countTokens(isRaw ? formatRawSources([unit]) : formatSummarySources([unit])),
  })));
  const groups = chunkByTokenBudget(units, Math.max(512, Math.floor(inputBudget * 0.9)));
  if (!groups.length) throw new Error('Compaction source is empty');

  let responseText = '';
  if (groups.length === 1) {
    const prompt = isRaw ? formatRawSources(groups[0]) : formatSummarySources(groups[0]);
    responseText = await requestSummary(prompt, targetTokens, level, stage, instruction);
  } else {
    setStatus('working', `Map/reduce compaction: ${groups.length} source chunks.`);
    const intermediateTarget = Math.max(512, Math.min(2000, targetTokens));
    const intermediate = [];
    for (let index = 0; index < groups.length; index++) {
      const prompt = isRaw ? formatRawSources(groups[index]) : formatSummarySources(groups[index]);
      intermediate.push(await requestStructuredSummary(
        prompt,
        intermediateTarget,
        level,
        stage,
        `Intermediate summary ${index + 1}`,
        instruction,
      ));
    }
    responseText = await reduceStructuredSummaries(intermediate, targetTokens, level + 1, 1, instruction);
  }
  let structured = parseStructuredSummary(responseText);

  const currentChat = isRaw ? getCurrentComparableChat() : [];
  const fingerprints = isRaw
    ? sourceEntries.map(entry => {
      const sourceIdentity = {
        index: entry.index,
        id: getMessageIdentity(entry.message),
      };
      const currentMessage = findCurrentMessage(currentChat, sourceIdentity) || entry.message;
      return fingerprintMessage(currentMessage);
    })
    : childBlocks.flatMap(block => block.sourceFingerprints || []);
  const sourceFrom = isRaw
    ? sourceEntries[0].index
    : Math.min(...childBlocks.map(block => block.sourceFrom));
  const sourceTo = isRaw
    ? sourceEntries[sourceEntries.length - 1].index
    : Math.max(...childBlocks.map(block => block.sourceTo));
  const sourceTokens = isRaw ? sumTokens(sourceEntries) : sumTokens(childBlocks);
  const rawTokens = isRaw
    ? sourceTokens
    : childBlocks.reduce((total, child) => total + Math.max(0, Number(child.rawTokens ?? child.sourceTokens) || 0), 0);

  let block = {
    id: `smp-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    level,
    structured,
    sourceFrom,
    sourceTo,
    sourceTokens,
    rawTokens,
    summaryTokens: 0,
    sourceHash: buildSourceHash(fingerprints),
    sourceFingerprints: fingerprints,
    children: childBlocks.map(child => child.id),
    status: 'active',
    createdAt: Date.now(),
  };

  block.summaryTokens = await getTokenCountAsync(renderBlockText(block, settings.includeStructuredMemory), 0);
  if (block.summaryTokens > targetTokens) {
    const reducedText = await requestSummary(JSON.stringify(structured), targetTokens, level, 'reduce', instruction);
    structured = parseStructuredSummary(reducedText);
    block = { ...block, structured };
    block.summaryTokens = await getTokenCountAsync(renderBlockText(block, settings.includeStructuredMemory), 0);
  }

  if (block.summaryTokens > Math.ceil(targetTokens * 1.1)) {
    throw new Error(`Summary block is too large (${block.summaryTokens}/${targetTokens} tokens)`);
  }
  return block;
}

function getBlockById(memory, blockId) {
  return memory.blocks.find(block => block.id === String(blockId || '')) || null;
}

function getBlockRangeMessages(block) {
  const sourceFrom = Number(block?.sourceFrom);
  const sourceTo = Number(block?.sourceTo);
  const messages = getCurrentComparableChat().filter(message => {
    const index = Number(message?.index);
    return index >= sourceFrom && index <= sourceTo;
  });
  const expectedCount = sourceTo - sourceFrom + 1;
  if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo) || sourceTo < sourceFrom || messages.length !== expectedCount) {
    throw new Error(`Raw source ${sourceFrom}–${sourceTo} is no longer fully available`);
  }
  return messages;
}

function refreshBlockSourceIdentity(block) {
  const fingerprints = getBlockRangeMessages(block).map(fingerprintMessage);
  block.sourceFingerprints = fingerprints;
  block.sourceHash = buildSourceHash(fingerprints);
  return block;
}

function closeRegeneration() {
  runtime.regenerationBlockId = null;
  runtime.regenerationPreview = null;
  const panel = document.getElementById('smp-regeneration');
  const preview = document.getElementById('smp-regeneration-preview');
  const comparison = document.getElementById('smp-regeneration-comparison');
  if (panel) panel.hidden = true;
  if (preview) preview.hidden = true;
  if (comparison) comparison.replaceChildren();
  updateJobControls();
}

function openRegeneration(blockId) {
  if (runtime.summarizing || !getBlockById(getChatMemory(), blockId)) return;
  closeBlockEditor();
  closeRegeneration();
  runtime.regenerationBlockId = blockId;
  document.getElementById('smp-regeneration').hidden = false;
  const wish = document.getElementById('smp-regeneration-wish');
  wish.value = '';
  wish.focus();
}

function regenerationSourceSnapshot(memory, ids) {
  const blocks = memory.blocks.filter(block => ids.includes(block.id));
  return JSON.stringify(getCurrentComparableChat()
    .filter(message => blocks.some(block => message.index >= block.sourceFrom && message.index <= block.sourceTo))
    .map(fingerprintMessage));
}

function assertRegenerationCurrent(preview) {
  // A preview replaces only the graph and source snapshot it was generated from.
  if (getCurrentChatId() !== preview.chatId) throw new Error('Chat changed; generate a new preview.');
  if (JSON.stringify(getChatMemory()) !== preview.originalMemory) throw new Error('Memory changed; generate a new preview.');
  if (regenerationSourceSnapshot(preview.memory, preview.ids) !== preview.sourceSnapshot) {
    throw new Error('Source messages changed; generate a new preview.');
  }
  for (const id of preview.ids) assertBlockSourceStillCurrent(getBlockById(preview.memory, id), preview.chatId, 'Regeneration preview');
}

async function saveRegenerationPreview() {
  const preview = runtime.regenerationPreview;
  if (!preview || runtime.summarizing) return;
  assertRegenerationCurrent(preview);
  runtime.selectedBlockId = preview.blockId;
  closeRegeneration();
  await setChatMemory(preview.memory, true, preview.chatId);
  setStatus('success', `Saved block replacement${preview.ids.length > 1 ? ` and ${preview.ids.length - 1} dependent merge(s)` : ''}.`);
}

async function regenerateMemoryBlock(blockId, instruction = '') {
  if (runtime.summarizing) throw new Error('Another compaction job is already running');
  const chatId = getCurrentChatId();
  if (chatId == null) throw new Error('No active chat');
  const original = getChatMemory();
  const selected = getBlockById(original, blockId);
  if (!selected) throw new Error('Selected memory block no longer exists');

  const ids = [selected.id, ...getBlockAncestorIds(original, selected.id)];
  const dependentCount = ids.length - 1;
  const originalMemory = JSON.stringify(original);
  const sourceSnapshot = regenerationSourceSnapshot(original, ids);
  const settings = getSettings();

  runtime.regenerationPreview = null;
  document.getElementById('smp-regeneration-preview').hidden = true;
  beginMemoryJob(chatId);
  try {
    const result = await stageBlockRegeneration({
      memory: original,
      blockId: selected.id,
      onStage: ({ block, position, total }) => {
        if (runtime.cancelRequested) throw new Error('Block regeneration cancelled');
        if (getCurrentChatId() !== chatId) throw new Error('Chat changed during block regeneration');
        setStatus(
          'working',
          `Regenerating L${block.level} block ${position + 1}/${total}${position ? ' (dependent rollup)' : ''}.`,
        );
      },
      createReplacement: async (current, candidate) => {
        let generated;
        if (current.level === 1) {
          generated = await createBlock({
            level: 1,
            sourceEntries: await countCoreChat(getBlockRangeMessages(current)),
            targetTokens: settings.blockTargetTokens,
            instruction,
          });
        } else {
          const childBlocks = current.children.map(childId => getBlockById(candidate, childId));
          if (!current.children.length || childBlocks.some(child => !child)) {
            throw new Error(`L${current.level} block has missing source children`);
          }
          generated = await createBlock({
            level: current.level,
            childBlocks,
            targetTokens: settings.blockTargetTokens,
            instruction,
          });
        }
        return refreshBlockSourceIdentity({ ...generated, createdAt: Date.now() });
      },
    });

    if (runtime.cancelRequested) throw new Error('Block regeneration cancelled');
    if (getCurrentChatId() !== chatId) throw new Error('Chat changed before regenerated block commit');
    const preview = { memory: result.memory, originalMemory, sourceSnapshot, ids, blockId: selected.id, chatId };
    assertRegenerationCurrent(preview);
    runtime.regenerationPreview = preview;
    const replacement = getBlockById(result.memory, selected.id);
    document.getElementById('smp-regeneration-comparison').innerHTML = renderRegenerationComparison(selected, replacement, dependentCount);
    document.getElementById('smp-regeneration-preview').hidden = false;
    setStatus('idle', 'Preview ready. Review the variant and save or discard it.');
  } catch (error) {
    if (getCurrentChatId() === chatId) setStatus(runtime.cancelRequested ? 'warning' : 'error', String(error?.message || error));
    throw error;
  } finally {
    endMemoryJob();
  }
}

async function createManualRollup() {
  if (runtime.summarizing) return;
  const chatId = getCurrentChatId();
  if (chatId == null) throw new Error('No active chat');
  const memory = getChatMemory();
  const selected = getManualRollupBlocks(memory, [...runtime.manualRollupIds]);
  const sourceLevel = selected[0].level;
  const targetLevel = sourceLevel + 1;
  if (!confirm(`Merge ${selected.length} selected L${sourceLevel} blocks into one L${targetLevel} block?`)) return;

  const settings = getSettings();
  beginMemoryJob(chatId);
  setStatus('working', `Merging ${selected.length} selected L${sourceLevel} blocks into L${targetLevel}.`);

  try {
    const result = await stageManualRollup({
      memory,
      childIds: selected.map(block => block.id),
      targetTokens: settings.blockTargetTokens,
      createBlock,
      validateBlock: (block, label) => {
        if (runtime.cancelRequested) throw new Error('Manual rollup cancelled');
        assertBlockSourceStillCurrent(block, chatId, label);
      },
    });
    if (runtime.cancelRequested) throw new Error('Manual rollup cancelled');
    if (getCurrentChatId() !== chatId) throw new Error('Chat changed before manual rollup commit');
    runtime.manualRollupIds.clear();
    runtime.selectedBlockId = result.rollupBlock.id;
    await setChatMemory(result.memory, true, chatId);
    setStatus(
      'success',
      `Created L${result.targetLevel} from ${result.childIds.length} selected L${result.sourceLevel} blocks: ${result.rollupBlock.sourceTokens} → ${result.rollupBlock.summaryTokens} tokens.`,
    );
  } catch (error) {
    const message = String(error?.message || error);
    setStatus(runtime.cancelRequested ? 'warning' : 'error', message);
    throw error;
  } finally {
    endMemoryJob();
  }
}

async function toggleBlockRawSource(blockId) {
  if (runtime.summarizing) return;
  const memory = getChatMemory();
  const block = getBlockById(memory, blockId);
  if (!block) return;
  const useRaw = !block.useRaw;
  const next = setBlockUseRaw(memory, block.id, useRaw);
  if (useRaw) {
    const nextBlock = getBlockById(next, block.id);
    nextBlock.rawTokens = sumTokens(await countCoreChat(getBlockRangeMessages(block)));
    runtime.manualRollupIds.delete(block.id);
  }
  await setChatMemory(next);
  setStatus('success', useRaw ? 'Using original history for this block.' : 'Using summary for this block.');
}

async function deleteSelectedMemoryBlock(blockId = runtime.selectedBlockId) {
  if (runtime.summarizing) return;
  const memory = getChatMemory();
  const selected = getBlockById(memory, blockId);
  if (!selected) return;
  const preview = deleteMemoryBlock(memory, selected.id);
  const dependentCount = preview.removedIds.length - 1;
  const message = dependentCount
    ? `Delete L${selected.level} block and ${dependentCount} dependent rollup(s)? Raw source will be exposed where coverage becomes discontinuous.`
    : `Delete selected L${selected.level} block? Its raw source will become visible again.`;
  if (!confirm(message)) return;

  for (const id of preview.reactivatedIds) {
    const block = getBlockById(preview.memory, id);
    if (!block) continue;
    try {
      refreshBlockSourceIdentity(block);
    } catch {
      block.status = 'stale';
      block.sourceFingerprints = [];
      if (!preview.staleIds.includes(id)) preview.staleIds.push(id);
    }
  }

  await setChatMemory(preview.memory);
  if (runtime.selectedBlockId === selected.id) runtime.selectedBlockId = null;
  if (runtime.editingBlockId === selected.id) runtime.editingBlockId = null;
  setStatus(
    'success',
    `Deleted ${preview.removedIds.length} block(s); reactivated ${preview.reactivatedIds.length}, marked stale ${preview.staleIds.length}.`,
  );
}

function findBlockElement(blockId) {
  return [...document.querySelectorAll('#smp-library .smp-block')]
    .find(element => element.dataset.blockId === String(blockId || '')) || null;
}

function closeBlockEditor(blockId = runtime.editingBlockId) {
  const blockElement = findBlockElement(blockId);
  const view = blockElement?.querySelector('.smp-block-view');
  const editor = blockElement?.querySelector('.smp-inline-editor');
  if (view instanceof HTMLElement) view.hidden = false;
  if (editor instanceof HTMLElement) editor.hidden = true;
  if (runtime.editingBlockId === String(blockId || '')) runtime.editingBlockId = null;
}

function openBlockEditor(blockId) {
  if (runtime.summarizing) return;
  closeRegeneration();
  const memory = getChatMemory();
  const block = getBlockById(memory, blockId);
  if (!block) return;
  if (runtime.editingBlockId && runtime.editingBlockId !== block.id) closeBlockEditor(runtime.editingBlockId);
  selectMemoryBlock(block.id);
  runtime.editingBlockId = block.id;
  const blockElement = findBlockElement(block.id);
  const view = blockElement?.querySelector('.smp-block-view');
  const editor = blockElement?.querySelector('.smp-inline-editor');
  if (blockElement instanceof HTMLDetailsElement) blockElement.open = true;
  if (view instanceof HTMLElement) view.hidden = true;
  if (editor instanceof HTMLElement) editor.hidden = false;
  editor?.querySelector('textarea[data-field="narrative"]')?.focus();
}

function readBlockEditor(blockElement) {
  const narrative = blockElement?.querySelector('textarea[data-field="narrative"]');
  if (!(narrative instanceof HTMLTextAreaElement)) throw new Error('Block editor is unavailable');
  const structured = { narrative: narrative.value.trim() };
  const title = blockElement.querySelector('input[data-field="title"]')?.value.trim();
  if (title) structured.title = title;
  for (const [field] of BLOCK_EDITOR_FIELDS) {
    const textarea = blockElement.querySelector(`textarea[data-field="${field}"]`);
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error(`Block editor field ${field} is unavailable`);
    structured[field] = textarea.value
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);
  }
  return parseStructuredSummary(structured);
}

async function saveSelectedBlockEdit(blockId = runtime.editingBlockId) {
  if (runtime.summarizing) return;
  const chatId = getCurrentChatId();
  if (chatId == null) throw new Error('No active chat');
  const memory = getChatMemory();
  const block = getBlockById(memory, blockId);
  if (!block) throw new Error('Selected memory block no longer exists');
  const dependentCount = getBlockAncestorIds(memory, block.id).length;
  if (dependentCount && !confirm(`Editing this block will mark ${dependentCount} dependent rollup(s) stale and reactivate their source blocks. Continue?`)) {
    return;
  }

  const blockElement = findBlockElement(block.id);
  const structured = readBlockEditor(blockElement);
  const settings = getSettings();
  const summaryTokens = await getTokenCountAsync(renderBlockText({ ...block, structured }, settings.includeStructuredMemory), 0);
  const result = editMemoryBlock(memory, block.id, structured, summaryTokens);

  for (const id of result.reactivatedIds) {
    const reactivated = getBlockById(result.memory, id);
    if (!reactivated) continue;
    try {
      refreshBlockSourceIdentity(reactivated);
    } catch {
      reactivated.status = 'stale';
      reactivated.sourceFingerprints = [];
      if (!result.staleIds.includes(id)) result.staleIds.push(id);
    }
  }
  const frontierIds = new Set(getActiveFrontier(result.memory).blocks.map(item => item.id));
  for (const candidate of result.memory.blocks) {
    if (candidate.status === 'active' && !frontierIds.has(candidate.id)) {
      candidate.status = 'stale';
      candidate.sourceFingerprints = [];
      if (!result.staleIds.includes(candidate.id)) result.staleIds.push(candidate.id);
    }
  }

  if (getCurrentChatId() !== chatId) throw new Error('Chat changed before edited block commit');
  runtime.editingBlockId = null;
  await setChatMemory(result.memory, true, chatId);
  setStatus(
    'success',
    `Saved block edit; invalidated ${result.dependentIds.length} rollup(s), reactivated ${result.reactivatedIds.length} source block(s).`,
  );
}

function getSelectedMemoryBlock() {
  return getBlockById(getChatMemory(), runtime.selectedBlockId);
}

function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copySelectedBlockJson() {
  const block = getSelectedMemoryBlock();
  if (!block) return;
  const text = JSON.stringify(block, null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  setStatus('success', `Copied L${block.level} block JSON.`);
}

function exportSelectedBlock() {
  const block = getSelectedMemoryBlock();
  if (!block) return;
  downloadJson(block, `silly-memories-plus-${block.id}.json`);
  setStatus('success', `Exported L${block.level} block.`);
}

function selectMemoryBlock(blockId) {
  const memory = getChatMemory();
  const nextId = getBlockById(memory, blockId)?.id || null;
  if (!runtime.summarizing && runtime.regenerationBlockId && runtime.regenerationBlockId !== nextId) closeRegeneration();
  if (runtime.editingBlockId && runtime.editingBlockId !== nextId) closeBlockEditor(runtime.editingBlockId);
  runtime.selectedBlockId = nextId;
  for (const element of document.querySelectorAll('#smp-library .smp-block')) {
    const selected = element.dataset.blockId === runtime.selectedBlockId;
    element.classList.toggle('smp-selected', selected);
    element.setAttribute('aria-selected', String(selected));
  }
  updateBlockActionBar(memory);
}

function updateBlockActionBar(memory = getChatMemory()) {
  const label = document.getElementById('smp-selected-block');
  const block = getBlockById(memory, runtime.selectedBlockId);
  if (!block) runtime.selectedBlockId = null;
  if (label) {
    label.textContent = block
      ? `Selected: L${block.level} · ${block.sourceFrom}–${block.sourceTo} · ${block.status} · ${block.sourceTokens} → ${block.summaryTokens}t`
      : 'No block selected.';
  }
  const disabled = !block || runtime.summarizing;
  for (const id of ['smp-regenerate-block', 'smp-copy-block', 'smp-export-block']) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) button.disabled = disabled;
  }
}

function updateManualRollupControls(memory = getChatMemory()) {
  const eligibleIds = new Set(memory.blocks
    .filter(block => block.status === 'active' && !block.useRaw)
    .map(block => block.id));
  for (const id of runtime.manualRollupIds) {
    if (!eligibleIds.has(id)) runtime.manualRollupIds.delete(id);
  }

  const label = document.getElementById('smp-rollup-selection');
  const button = document.getElementById('smp-rollup-selected');
  const selectedBlocks = [...runtime.manualRollupIds]
    .map(id => getBlockById(memory, id))
    .filter(Boolean);
  const selectedLevel = selectedBlocks[0]?.level ?? null;
  let selected = [];
  let error = '';
  try {
    if (runtime.manualRollupIds.size >= 2) {
      selected = getManualRollupBlocks(memory, [...runtime.manualRollupIds]);
    }
  } catch (selectionError) {
    error = String(selectionError?.message || selectionError);
  }

  if (label) {
    if (error) label.textContent = error;
    else if (selected.length) {
      label.textContent = `${selected.length} × L${selected[0].level} · source ${selected[0].sourceFrom}–${selected.at(-1).sourceTo} → L${selected[0].level + 1}.`;
    } else if (runtime.manualRollupIds.size === 1) {
      label.textContent = `L${selectedLevel} selected; select one or more adjacent L${selectedLevel} blocks.`;
    } else {
      label.textContent = 'Select at least two adjacent active blocks of the same level.';
    }
  }
  if (button instanceof HTMLButtonElement) {
    button.disabled = runtime.summarizing || selected.length < 2 || Boolean(error);
    const text = button.querySelector('span');
    if (text) text.textContent = selectedLevel === null ? 'Merge blocks' : `Merge L${selectedLevel} → L${selectedLevel + 1}`;
  }
  for (const control of document.querySelectorAll('#smp-library [data-smp-rollup-select]')) {
    if (!(control instanceof HTMLButtonElement)) continue;
    const block = getBlockById(memory, control.value);
    const isSelected = runtime.manualRollupIds.has(control.value);
    control.setAttribute('aria-pressed', String(isSelected));
    control.disabled = runtime.summarizing
      || !block
      || block.status !== 'active'
      || block.useRaw
      || (selectedLevel !== null && block.level !== selectedLevel && !isSelected);
  }
}

function makeSyntheticMemoryMessage(text, settings) {
  const role = settings.summaryRole;
  const message = {
    name: 'Memory',
    mes: text,
    is_user: role === 'user',
    is_system: false,
    index: -1,
    extra: { sillyMemoriesPlus: true },
  };
  if (role === 'system') message.extra.type = system_message_types.NARRATOR;
  return message;
}

function applyMemoryToCoreChat(coreChat, memory) {
  const settings = getSettings();
  const result = rewriteConversationWithMemory(
    coreChat,
    memory,
    text => makeSyntheticMemoryMessage(text, settings),
    settings.includeStructuredMemory,
  );
  coreChat.splice(0, coreChat.length, ...result.messages);
  debug('Prompt rewritten', {
    activeBlocks: result.activeBlocks.length,
    rawBlocks: result.activeBlocks.filter(block => block.useRaw).length,
    coveredThrough: result.coveredThrough,
  });
}

function assertBlockSourceStillCurrent(block, chatId, label) {
  if (getCurrentChatId() !== chatId) throw new Error(`Chat changed during ${label}`);
  if (!fingerprintsStillMatch(block.sourceFingerprints)) throw new Error(`Source changed during ${label}`);
}

async function executePlanTransaction(plan, memory, chatId, contextSize, settings) {
  runtime.abortController = new AbortController();
  runtime.activeCompactionChatId = chatId;
  try {
    const result = await stageCompactionTransaction({
      plan,
      memory,
      contextBudget: contextSize,
      fixedPromptTokens: runtime.fixedPromptTokensByChat.get(String(chatId)) || 0,
      settings,
      createBlock,
      validateBlock: (block, label) => {
        if (runtime.cancelRequested) throw new Error('Compaction cancelled');
        assertBlockSourceStillCurrent(block, chatId, label);
      },
      onStage: ({ kind, plan: stagePlan, level }) => {
        if (runtime.cancelRequested) throw new Error('Compaction cancelled');
        if (kind === 'raw') {
          setStatus('working', `Compacting ${stagePlan.sourceTokens} raw tokens into ~${stagePlan.targetTokens}.`);
        } else {
          runtime.lastPlan = stagePlan;
          setStatus('working', `Rolling ${stagePlan.blocks.length} memory blocks into L${level}.`);
        }
      },
    });

    if (runtime.cancelRequested) throw new Error('Compaction cancelled');
    if (getCurrentChatId() !== chatId) throw new Error('Chat changed before memory commit');
    for (const block of getActiveFrontier(result.memory).blocks) {
      assertBlockSourceStillCurrent(block, chatId, 'compaction');
    }
    await setChatMemory(result.memory, true, chatId);
    runtime.lastPlan = result.finalPlan;
    updateStats(result.finalPlan, result.memory);
    if (result.rawBlock && result.rollupBlock) {
      setStatus(
        'success',
        `Atomic L1+L${result.rollupBlock.level}: ${result.rawBlock.sourceTokens} → ${result.rawBlock.summaryTokens}t, tier ${result.rollupBlock.sourceTokens} → ${result.rollupBlock.summaryTokens}t.`,
      );
    } else if (result.rawBlock) {
      setStatus('success', `Created L1 block: ${result.rawBlock.sourceTokens} → ${result.rawBlock.summaryTokens} tokens.`);
    } else if (result.rollupBlock) {
      setStatus(
        'success',
        `Created L${result.rollupBlock.level} rollup: ${result.rollupBlock.sourceTokens} → ${result.rollupBlock.summaryTokens} tokens.`,
      );
    }
    return result.memory;
  } finally {
    runtime.abortController = null;
    runtime.activeCompactionChatId = null;
  }
}

async function runInterceptor(coreChat, contextSize, abort, type) {
  const settings = getSettings();
  if (!settings.enabled || !Array.isArray(coreChat) || !coreChat.length) return;
  if (runtime.summarizing || type === 'quiet' || type === 'impersonate') return;

  let memory;
  let plan;
  try {
    memory = getChatMemory();
    if (!activeMemoryIsValid(getCurrentComparableChat(), memory)) {
      await invalidateActiveMemory(memory, 'Memory source changed; active blocks marked stale.');
      memory = getChatMemory();
    }
    memory = await repairActiveFrontier(memory);
    memory = await refreshActiveBlockTokenCounts(memory, settings);

    const activeFrontier = getActiveFrontier(memory);
    const coveredThrough = activeFrontier.coveredThrough;
    const rawMessages = coreChat.filter(message => Number(message?.index) > coveredThrough);
    const rawEntries = await countCoreChat(rawMessages);
    plan = buildCompactionPlan({
      contextBudget: contextSize,
      fixedPromptTokens: runtime.fixedPromptTokensByChat.get(String(getCurrentChatId())) || 0,
      blocks: activeFrontier.blocks,
      rawEntries,
      settings,
      force: runtime.forceCompaction,
    });
  } catch (error) {
    runtime.forceCompaction = false;
    const message = `Memory preflight failed: ${String(error?.message || error)}`;
    setStatus('error', message);
    console.error(LOG_PREFIX, error);
    abort?.(true);
    return;
  }
  runtime.lastPlan = plan;
  runtime.forceCompaction = false;
  updateStats(plan, memory);

  if (plan.kind === 'blocked') {
    setStatus('error', describeBlockedPlan(plan));
    abort?.(true);
    return;
  }

  if (plan.kind === 'none' && type === 'manual') {
    const messages = {
      'below-trigger': 'Nothing to compact at the current trigger.',
      'no-cold-source': 'Nothing to compact while preserving the configured raw tail.',
      'source-too-small': `Cold source is smaller than the ${plan.effectiveMinimumSourceTokens}-token minimum.`,
      'no-space-for-summary': 'The current conversation fits; there is no space for an additional memory block.',
    };
    setStatus('idle', messages[plan.reason] || 'Nothing to compact.');
  }

  if (plan.kind !== 'none') {
    runtime.summarizing = true;
    runtime.cancelRequested = false;
    updateBlockActionBar();
    updateManualRollupControls();
    const chatId = getCurrentChatId();
    try {
      memory = await executePlanTransaction(plan, memory, chatId, contextSize, settings);
    } catch (error) {
      const errorText = String(error?.message || error);
      if (runtime.cancelRequested) {
        setStatus('warning', 'Compaction cancelled; previous memory and raw chat remain active.');
        abort?.(true);
        return;
      }
      if (getCurrentChatId() !== chatId) {
        setStatus('warning', `Compaction discarded after chat change: ${errorText}`);
        abort?.(true);
        return;
      }
      console.error(LOG_PREFIX, error);

      memory = getChatMemory();
      if (!activeMemoryIsValid(getCurrentComparableChat(), memory)) {
        await invalidateActiveMemory(memory, `Compaction source changed: ${errorText}`);
        memory = getChatMemory();
      } else {
        setStatus(plan.totalTokens > plan.usableBudget ? 'error' : 'warning', errorText);
      }
      // A failed compaction cannot send an already oversized context onward.
      if (plan.totalTokens > plan.usableBudget) {
        abort?.(true);
        return;
      }
    } finally {
      runtime.summarizing = false;
      runtime.cancelRequested = false;
      updateBlockActionBar();
      updateManualRollupControls();
      updateJobControls();
    }
  }

  try {
    // Check the actual saved blocks after success or a provider failure.
    const frontier = getActiveFrontier(memory);
    const finalRaw = await countCoreChat(coreChat.filter(message => Number(message?.index) > frontier.coveredThrough));
    const fixedTokens = runtime.fixedPromptTokensByChat.get(String(getCurrentChatId())) || 0;
    const currentPlan = buildCompactionPlan({
      contextBudget: contextSize, fixedPromptTokens: fixedTokens,
      blocks: frontier.blocks, rawEntries: finalRaw, settings,
    });
    runtime.lastPlan = currentPlan;
    updateStats(currentPlan, memory);
    if (currentPlan.totalTokens > currentPlan.usableBudget) {
      setStatus('error', describeBlockedPlan({ ...currentPlan, overflowTokens: currentPlan.totalTokens - currentPlan.usableBudget }));
      abort?.(true);
      return;
    }
    applyMemoryToCoreChat(coreChat, memory);
  } catch (error) {
    const message = `Memory rewrite failed: ${String(error?.message || error)}`;
    setStatus('error', message);
    console.error(LOG_PREFIX, error);
    abort?.(true);
    return;
  }
  if (type !== 'manual') {
    const visibleConversation = coreChat.map(message => String(message?.mes || '')).join('\n');
    runtime.pendingPromptMeasurement = {
      chatId: String(getCurrentChatId()),
      conversationTokens: await getTokenCountAsync(visibleConversation, 0),
    };
  }
}

function updateStats(plan = runtime.lastPlan, memory = getChatMemory()) {
  const active = getActiveBlocks(memory);
  const activeTokens = active.reduce(
    (total, block) => total + Math.max(0, Number(block.useRaw ? (block.rawTokens ?? block.sourceTokens) : block.summaryTokens) || 0),
    0,
  );
  const stats = document.getElementById('smp-stats');
  if (!stats) return;
  const trigger = plan?.triggerTokens ?? '—';
  const raw = plan?.rawTokens ?? '—';
  const fixed = runtime.fixedPromptTokensByChat.get(String(getCurrentChatId())) || 0;
  const exposedRaw = active.filter(block => block.useRaw).length;
  stats.textContent = `Active blocks: ${active.length} (${activeTokens}t) · Raw blocks: ${exposedRaw} · Tail: ${raw}t · Fixed: ${fixed}t · Trigger: ${trigger}t`;
}

function renderLibrary() {
  const container = document.getElementById('smp-library');
  if (!container) return;
  const memory = getChatMemory();
  const blocks = memory.blocks.filter(block => runtime.libraryTab === 'active' ? block.status === 'active' : block.status !== 'active')
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const tab of document.querySelectorAll('[data-smp-tab]')) {
    const selected = tab.dataset.smpTab === runtime.libraryTab;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const count = memory.blocks.filter(block => tab.dataset.smpTab === 'active' ? block.status === 'active' : block.status !== 'active').length;
    tab.querySelector('[data-smp-count]').textContent = String(count);
  }
  container.setAttribute('aria-labelledby', `smp-tab-${runtime.libraryTab}`);
  document.querySelector('#smp-settings .smp-rollup-panel').hidden = runtime.libraryTab !== 'active';
  if (!blocks.some(block => block.id === runtime.selectedBlockId)) runtime.selectedBlockId = null;
  if (!blocks.some(block => block.id === runtime.editingBlockId)) runtime.editingBlockId = null;
  if (!blocks.length) {
    runtime.selectedBlockId = null;
    runtime.editingBlockId = null;
    container.innerHTML = `<div class="smp-empty">${runtime.libraryTab === 'active' ? 'No active memory blocks.' : 'No archived memory blocks.'}</div>`;
    updateBlockActionBar(memory);
    updateManualRollupControls(memory);
    updateStats(runtime.lastPlan, memory);
    return;
  }
  if (!getBlockById(memory, runtime.selectedBlockId)) runtime.selectedBlockId = null;
  if (!getBlockById(memory, runtime.editingBlockId)) runtime.editingBlockId = null;
  updateManualRollupControls(memory);
  container.innerHTML = blocks.map(block => renderBlockCard(block, {
    selected: block.id === runtime.selectedBlockId,
    editing: block.id === runtime.editingBlockId,
    mergeSelected: runtime.manualRollupIds.has(block.id),
  })).join('');
  updateBlockActionBar(memory);
  updateManualRollupControls(memory);
  updateStats(runtime.lastPlan, memory);
}

function bindInput(id, key, parse = value => value) {
  const element = document.getElementById(id);
  if (!element) return;
  const settings = getSettings();
  if (element instanceof HTMLInputElement && element.type === 'checkbox') {
    element.checked = Boolean(settings[key]);
    element.addEventListener('change', () => {
      updateSettings(draft => { draft[key] = element.checked; });
    });
    return;
  }
  element.value = String(settings[key] ?? '');
  element.addEventListener('change', () => {
    updateSettings(draft => { draft[key] = parse(element.value); });
    updateSettingsFields();
  });
}

function bindPercentageInputs() {
  const triggerInput = document.getElementById('smp-trigger');
  const tailInput = document.getElementById('smp-tail');
  if (!(triggerInput instanceof HTMLInputElement) || !(tailInput instanceof HTMLInputElement)) return;

  const commit = (source, clampInvalid) => {
    const isTrigger = source === triggerInput;
    const minimum = isTrigger ? 50 : 5;
    const maximum = isTrigger ? 95 : 50;
    const entered = Number(source.value);

    if (!Number.isFinite(entered)) {
      if (clampInvalid) updateSettingsFields();
      return;
    }
    if (!clampInvalid && (entered < minimum || entered > maximum)) return;

    const percent = Math.round(Math.min(maximum, Math.max(minimum, entered)));
    const triggerPercent = isTrigger ? percent : 100 - percent;
    updateSettings(draft => { draft.triggerRatio = triggerPercent / 100; });
    updateSettingsFields();
  };

  for (const input of [triggerInput, tailInput]) {
    input.addEventListener('input', () => commit(input, false));
    input.addEventListener('change', () => commit(input, true));
  }

  updateSettingsFields();
}

const PROMPT_INPUTS = Object.freeze({
  raw: 'smp-prompt-raw',
  rollup: 'smp-prompt-rollup',
  reduce: 'smp-prompt-reduce',
});

function updatePromptFields() {
  const prompts = getSettings().prompts;
  for (const [stage, id] of Object.entries(PROMPT_INPUTS)) {
    const textarea = document.getElementById(id);
    if (textarea instanceof HTMLTextAreaElement) textarea.value = prompts[stage];
  }
}

function bindPromptInputs() {
  updatePromptFields();
  for (const [stage, id] of Object.entries(PROMPT_INPUTS)) {
    const textarea = document.getElementById(id);
    if (!(textarea instanceof HTMLTextAreaElement)) continue;
    textarea.addEventListener('change', () => {
      updateSettings(draft => {
        draft.prompts = {
          ...draft.prompts,
          [stage]: textarea.value.trim() || DEFAULT_PROMPTS[stage],
        };
      });
      updatePromptFields();
    });
  }
}

function populateProfiles() {
  const select = document.getElementById('smp-summary-profile');
  if (!(select instanceof HTMLSelectElement)) return;
  const selected = getSettings().summaryProfileId;
  select.innerHTML = '<option value="">Current main API</option>';
  try {
    for (const profile of ConnectionManagerRequestService.getSupportedProfiles()) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      select.append(option);
    }
  } catch (error) {
    console.warn(LOG_PREFIX, 'Could not enumerate connection profiles.', error);
  }
  const available = [...select.options].some(option => option.value === selected);
  select.value = available ? selected : '';
  if (selected && !available) updateSettings(draft => { draft.summaryProfileId = ''; });
}

function updateSettingsFields() {
  const settings = getSettings();
  const trigger = document.getElementById('smp-trigger');
  const tail = document.getElementById('smp-tail');
  if (trigger instanceof HTMLInputElement) trigger.value = String(Math.round(settings.triggerRatio * 100));
  if (tail instanceof HTMLInputElement) tail.value = String(100 - Math.round(settings.triggerRatio * 100));
}

async function testSummarizerConnection() {
  if (runtime.summarizing) return;
  beginMemoryJob(null);
  setStatus('working', 'Testing summarizer with synthetic continuity data.');
  try {
    const prompt = formatRawSources([
      { message: { index: 0, is_user: true, name: 'Mira', mes: 'Mira gives Rowan the brass observatory key and asks him to guard it until dawn.' } },
      { message: { index: 1, is_user: false, name: 'Rowan', mes: 'Rowan accepts, puts the key in his inner coat pocket, and promises to meet Mira at the north gate. Their trust improves, but the missing map remains unresolved.' } },
    ]);
    const text = await requestSummary(prompt, 512, 1, 'raw');
    const structured = parseStructuredSummary(text);
    const tokens = await getTokenCountAsync(JSON.stringify(structured), 0);
    setStatus('success', `Summarizer test passed (${tokens}t): ${structured.narrative.slice(0, 140)}`);
    return structured;
  } catch (error) {
    const message = String(error?.message || error);
    setStatus('error', `Summarizer test failed: ${message}`);
    throw error;
  } finally {
    endMemoryJob();
  }
}

async function renderSettings() {
  if (document.getElementById('smp-settings')) return;
  if (runtime.renderPromise) return runtime.renderPromise;
  runtime.renderPromise = (async () => {
    const container = document.getElementById('extensions_settings2');
    if (!container) return;
    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    if (!document.getElementById('smp-settings')) container.insertAdjacentHTML('beforeend', html);

    bindInput('smp-enabled', 'enabled');
    bindPercentageInputs();
    bindInput('smp-block-target', 'blockTargetTokens', Number);
    bindInput('smp-min-source', 'minimumSourceTokens', Number);
    bindInput('smp-input-budget', 'summaryInputBudgetTokens', Number);
    bindInput('smp-output-budget', 'summaryMaxOutputTokens', Number);
    bindInput('smp-summary-profile', 'summaryProfileId', String);
    bindInput('smp-summary-role', 'summaryRole', String);
    bindInput('smp-structured', 'includeStructuredMemory');
    bindInput('smp-debug', 'debug');
    bindPromptInputs();
    populateProfiles();

    for (const submenu of document.querySelectorAll('#smp-settings .smp-submenu')) {
      submenu.addEventListener('toggle', () => {
        if (!submenu.open) return;
        for (const sibling of document.querySelectorAll('#smp-settings .smp-submenu')) {
          if (sibling !== submenu) sibling.removeAttribute('open');
        }
      });
    }

    document.getElementById('smp-compact-now')?.addEventListener('click', async () => {
      if (runtime.summarizing) return;
      runtime.forceCompaction = true;
      setStatus('working', 'Starting forced compaction.');
      try {
        const comparableChat = getCurrentComparableChat();
        await runInterceptor(comparableChat, getMaxPromptTokens(), () => {}, 'manual');
      } catch (error) {
        console.error(LOG_PREFIX, error);
      }
    });
    document.getElementById('smp-test-summarizer')?.addEventListener('click', () => {
      void testSummarizerConnection().catch(error => console.error(LOG_PREFIX, error));
    });
    document.getElementById('smp-cancel')?.addEventListener('click', async () => {
      runtime.cancelRequested = true;
      runtime.abortController?.abort();
      if (runtime.fallbackSummaryActive) await eventSource.emit(event_types.GENERATION_STOPPED);
      setStatus('warning', 'Compaction cancellation requested.');
    });
    document.getElementById('smp-clear')?.addEventListener('click', async () => {
      if (!confirm('Clear every saved memory block for the current chat?')) return;
      runtime.selectedBlockId = null;
      runtime.manualRollupIds.clear();
      closeBlockEditor();
      await setChatMemory(createEmptyMemory());
      setStatus('idle', 'Current chat memory cleared.');
    });
    document.getElementById('smp-reset-prompts')?.addEventListener('click', () => {
      if (!confirm('Restore all three built-in summary prompts?')) return;
      updateSettings(draft => { draft.prompts = { ...DEFAULT_PROMPTS }; });
      updatePromptFields();
      setStatus('success', 'Default summary prompts restored.');
    });
    document.getElementById('smp-library')?.addEventListener('click', event => {
      const rollupControl = event.target instanceof Element ? event.target.closest('[data-smp-rollup-select]') : null;
      if (rollupControl instanceof HTMLButtonElement) {
        event.preventDefault();
        event.stopPropagation();
        if (rollupControl.disabled) return;
        if (runtime.manualRollupIds.has(rollupControl.value)) runtime.manualRollupIds.delete(rollupControl.value);
        else runtime.manualRollupIds.add(rollupControl.value);
        updateManualRollupControls();
        return;
      }
      const action = event.target instanceof Element ? event.target.closest('[data-smp-block-action]') : null;
      if (action instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const blockElement = action.closest('.smp-block');
        const blockId = blockElement?.dataset.blockId;
        if (!blockId) return;
        selectMemoryBlock(blockId);
        const actionName = action.dataset.smpBlockAction;
        if (actionName === 'edit') openBlockEditor(blockId);
        if (actionName === 'cancel-edit') closeBlockEditor(blockId);
        if (actionName === 'save-edit') {
          void saveSelectedBlockEdit(blockId).catch(error => {
            setStatus('error', String(error?.message || error));
            console.error(LOG_PREFIX, error);
          });
        }
        if (actionName === 'delete') {
          void deleteSelectedMemoryBlock(blockId).catch(error => {
            setStatus('error', String(error?.message || error));
            console.error(LOG_PREFIX, error);
          });
        }
        if (actionName === 'toggle-raw') {
          void toggleBlockRawSource(blockId).catch(error => {
            setStatus('error', String(error?.message || error));
            console.error(LOG_PREFIX, error);
          });
        }
        return;
      }
      const summary = event.target instanceof Element ? event.target.closest('.smp-block > summary') : null;
      const block = summary?.closest('.smp-block');
      if (block instanceof HTMLElement) selectMemoryBlock(block.dataset.blockId);
    });
    document.getElementById('smp-rollup-selected')?.addEventListener('click', () => {
      void createManualRollup().catch(error => console.error(LOG_PREFIX, error));
    });
    document.getElementById('smp-regenerate-block')?.addEventListener('click', () => {
      const memory = getChatMemory();
      const block = getBlockById(memory, runtime.selectedBlockId);
      if (!block || runtime.summarizing) return;
      openRegeneration(block.id);
    });
    document.getElementById('smp-generate-preview')?.addEventListener('click', () => {
      if (!runtime.regenerationBlockId || runtime.summarizing) return;
      const instruction = document.getElementById('smp-regeneration-wish').value.trim();
      void regenerateMemoryBlock(runtime.regenerationBlockId, instruction).catch(error => {
        const message = String(error?.message || error);
        if (runtime.regenerationBlockId && runtime.lastStatus.text !== message) setStatus('error', message);
        console.error(LOG_PREFIX, error);
      });
    });
    document.getElementById('smp-save-preview')?.addEventListener('click', () => {
      void saveRegenerationPreview().catch(error => {
        runtime.regenerationPreview = null;
        setStatus('error', String(error?.message || error));
        console.error(LOG_PREFIX, error);
      });
    });
    for (const id of ['smp-discard-preview', 'smp-close-regeneration']) {
      document.getElementById(id)?.addEventListener('click', () => {
        if (runtime.summarizing) return;
        closeRegeneration();
        setStatus('idle', 'Ready.');
      });
    }
    const selectLibraryTab = tab => {
      if (runtime.summarizing) return;
      closeBlockEditor();
      closeRegeneration();
      runtime.libraryTab = tab.dataset.smpTab;
      runtime.selectedBlockId = null;
      runtime.manualRollupIds.clear();
      renderLibrary();
    };
    for (const tab of document.querySelectorAll('[data-smp-tab]')) {
      tab.addEventListener('click', () => selectLibraryTab(tab));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...document.querySelectorAll('[data-smp-tab]')];
        const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs.find(item => item !== tab);
        selectLibraryTab(next);
        next.focus();
      });
    }
    document.getElementById('smp-copy-block')?.addEventListener('click', () => {
      void copySelectedBlockJson().catch(error => {
        setStatus('error', String(error?.message || error));
        console.error(LOG_PREFIX, error);
      });
    });
    document.getElementById('smp-export-block')?.addEventListener('click', exportSelectedBlock);
    document.getElementById('smp-refresh')?.addEventListener('click', () => renderLibrary());
    document.getElementById('smp-export')?.addEventListener('click', exportCurrentMemory);
    updateSettingsFields();
    updatePromptFields();
    renderLibrary();
    setStatus(runtime.lastStatus.kind, runtime.lastStatus.text);
  })().finally(() => {
    runtime.renderPromise = null;
  });
  return runtime.renderPromise;
}

function exportCurrentMemory() {
  const chatId = String(getCurrentChatId() || 'chat').replace(/[^a-z0-9._-]+/gi, '_');
  downloadJson(getChatMemory(), `silly-memories-plus-${chatId}.json`);
}

function onChatChanged() {
  if (runtime.summarizing) {
    runtime.abortController?.abort();
    if (runtime.fallbackSummaryActive) void eventSource.emit(event_types.GENERATION_STOPPED);
  }
  runtime.lastPlan = null;
  runtime.forceCompaction = false;
  runtime.pendingPromptMeasurement = null;
  runtime.selectedBlockId = null;
  runtime.libraryTab = 'active';
  closeRegeneration();
  runtime.manualRollupIds.clear();
  closeBlockEditor();
  renderLibrary();
  setStatus('idle', 'Ready for this chat.');
}

function captureChatCompletionOverhead() {
  if (runtime.summarizing) return;
  const pending = runtime.pendingPromptMeasurement;
  if (!pending || pending.chatId !== String(getCurrentChatId())) return;
  const counts = promptManager?.tokenHandler?.counts;
  if (!counts || typeof counts !== 'object') return;
  const total = Object.values(counts)
    .map(Number)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  const conversation = Math.max(0, Number(counts.chatHistory ?? counts.conversation) || 0);
  const fixed = Math.max(0, Math.round(total - conversation));
  runtime.fixedPromptTokensByChat.set(pending.chatId, fixed);
  runtime.pendingPromptMeasurement = null;
  debug('Captured fixed prompt overhead', { total, conversation, fixed });
  updateStats();
}

async function captureTextCompletionOverhead(eventData) {
  if (runtime.summarizing || eventData?.dryRun || typeof eventData?.prompt !== 'string') return;
  const pending = runtime.pendingPromptMeasurement;
  if (!pending || pending.chatId !== String(getCurrentChatId())) return;
  const total = await getTokenCountAsync(eventData.prompt, 0);
  const fixed = Math.max(0, Math.round(total - pending.conversationTokens));
  runtime.fixedPromptTokensByChat.set(pending.chatId, fixed);
  runtime.pendingPromptMeasurement = null;
  debug('Captured text-completion overhead', { total, conversation: pending.conversationTokens, fixed });
  updateStats();
}

function clearCurrentOverheadEstimate() {
  runtime.fixedPromptTokensByChat.delete(String(getCurrentChatId()));
}

async function validateAfterChatMutation(label) {
  const memory = getChatMemory();
  if (!getActiveBlocks(memory).length) return;
  if (!activeMemoryIsValid(getCurrentComparableChat(), memory)) {
    await invalidateActiveMemory(memory, `${label}; active memory marked stale.`);
  } else {
    setStatus('idle', `${label}; active memory remains valid.`);
  }
}

globalThis[INTERCEPTOR_NAME] = runInterceptor;
getSettings();

eventSource.on(event_types.APP_READY, () => setTimeout(() => void renderSettings(), 0));
eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, captureChatCompletionOverhead);
eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, captureTextCompletionOverhead);
eventSource.on(event_types.PRESET_CHANGED, clearCurrentOverheadEstimate);
eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, clearCurrentOverheadEstimate);
eventSource.on(event_types.CHATCOMPLETION_MODEL_CHANGED, clearCurrentOverheadEstimate);
eventSource.on(event_types.MESSAGE_EDITED, () => void validateAfterChatMutation('Message edited'));
eventSource.on(event_types.MESSAGE_UPDATED, () => void validateAfterChatMutation('Message updated'));
eventSource.on(event_types.MESSAGE_SWIPED, () => void validateAfterChatMutation('Swipe changed'));
eventSource.on(event_types.MESSAGE_DELETED, () => void validateAfterChatMutation('Message deleted'));

if (document.readyState !== 'loading') setTimeout(() => void renderSettings(), 0);
