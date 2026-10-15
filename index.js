import {
  chat_metadata,
  eventSource,
  event_types,
  extractMessageFromData,
  generateRawData,
  getCurrentChatId,
  getMaxPromptTokens,
  is_send_press,
  main_api,
  saveChatConditional,
  saveSettingsDebounced,
  substituteParams,
} from '../../../../script.js';
import {
  extension_settings,
  getContext,
  renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { getTokenCountAsync as getNativeTokenCountAsync, countTokensOpenAIAsync, getTokenizerModel } from '../../../tokenizers.js';
import { formatInstructModeChat } from '../../../instruct-mode.js';
import { is_group_generating } from '../../../group-chats.js';
import { appendFileContent } from '../../../chats.js';
import { isExecutingCommandsFromChatInput } from '../../../slash-commands.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';
import { system_message_types } from '../../../system-messages.js';
import { ChatCompletion, promptManager, setOpenAIMessages, oai_settings, getChatCompletionModel } from '../../../openai.js';
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
  getUncoveredMessages,
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
  chunkStructuredSources,
  formatRawSources,
  formatSummarySources,
  getSummarySourceBudget,
  partitionRawEntries,
  splitOversizedRawEntries,
} from './lib/summarizer.mjs';
import {
  BLOCK_EDITOR_FIELDS,
  renderBlockCard,
  renderContextUsage,
  renderRegenerationComparison,
} from './lib/ui.mjs';
import { getContextUsage, renderPinnedFacts } from './lib/context.mjs';
import { countChatPrompt, isSynthetic, locateChatConversation, locateTextConversation, missingHistory, replaceChatMemory, replaceTextMemory, resolveChatConversation, unverifiedChatHistory } from './lib/prompt.mjs';
import { installNativeContextManagement } from './lib/native-context.mjs';
import { blockSourceMatches, buildSourceHash, findCurrentMessage, fingerprintMessage, getMessageIdentity, hasSourceIdentity, inspectBlockSource, reconcileMemorySources } from './lib/source-identity.mjs';
import { diagnosticError, recordDiagnostic, exportDiagnostics, nextDiagnosticRequest } from './lib/diagnostics.mjs';
import { diagnosticName, inspectConversation, inspectChatPrompt } from './lib/prompt-inspection.mjs';
import { inspectChatTextTrace, traceIndexedText } from './lib/text-trace.mjs';
import { getCurrentLocale, translate as nativeTranslate } from '../../../i18n.js';
import { applyTranslations, displayText, initializeI18n, LocalizedError, message as msg, setLanguage, t, translate } from './lib/i18n.mjs';

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
  lastStatus: { kind: 'idle', text: 'Ready.' },
  abortController: null,
  fallbackSummaryActive: false,
  cancelRequested: false,
  activeCompactionChatId: null,
  fixedPromptTokensByChat: new Map(),
  preparedHistoryByChat: new Map(),
  pendingPromptMeasurement: null,
  preparingPrompt: null,
  liveGeneration: false,
  passivePromptMeasurement: null,
  passivePromptDirty: true,
  passivePromptTimer: null,
  passivePromptInFlight: false,
  overheadRevision: 0,
  notice: null,
  selectedBlockId: null,
  editingBlockId: null,
  editingBlockSnapshot: null,
  libraryChatId: null,
  manualRollupIds: new Set(),
  libraryTab: 'active',
  regenerationBlockId: null,
  regenerationPreview: null,
  contextBudgetsByChat: new Map(),
  contextRevision: 0,
  contextRefreshTimer: null,
  factsEditorChatId: null,
  factsEditorValue: '',
  contextUsage: null,
  generationType: null,
  diagnosticRequestId: null,
};
let settingsInitialized = false;

async function countTextTokens(text) {
  if (typeof text !== 'string' || !text.length) return 0;
  // Explicit chat tokenization avoids the host's padding-dependent shadow estimate.
  return main_api === 'openai'
    ? Math.max(0, await countTokensOpenAIAsync({ role: 'system', content: text }, true))
    : getNativeTokenCountAsync(text);
}

function diagnosticEnvironment() {
  return { api: main_api, provider: main_api === 'openai' ? diagnosticName(oai_settings.chat_completion_source) : main_api,
    model: main_api === 'openai' ? diagnosticName(getChatCompletionModel()) : null,
    tokenizer: main_api === 'openai' ? diagnosticName(getTokenizerModel()) : 'native-text',
    tokenizerMode: main_api === 'openai' ? 'explicit-chat-tokenizer' : 'native-text',
    contextBudget: getMaxPromptTokens(), tokenPadding: getContext().powerUserSettings.token_padding,
    nativeClipping: !(getSettings().enabled && main_api === 'openai' && !runtime.summarizing && !['quiet', 'impersonate'].includes(runtime.generationType)) };
}

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
  const previous = getSettings();
  const draft = structuredClone(previous);
  mutator(draft);
  extension_settings[EXTENSION_ID] = normalizeSettings(draft);
  recordDiagnostic('settings-changed', { fields: Object.keys(draft).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(draft[key])) });
  saveSettingsDebounced();
  scheduleContextRefresh();
  return extension_settings[EXTENSION_ID];
}

function debug(...args) {
  if (getSettings().debug) console.debug(LOG_PREFIX, ...args);
}

function showNotice(kind, text) {
  const short = displayText(text).replace(/\s+/g, ' ').slice(0, 237);
  if (runtime.notice) globalThis.toastr?.remove(runtime.notice);
  runtime.notice = globalThis.toastr?.[kind]?.(short, 'Silly Memories Plus', { escapeHtml: true, preventDuplicates: true, timeOut: kind === 'error' ? 7000 : 3500, extendedTimeOut: 1500 });
}

function setStatus(kind, text) {
  if (typeof text === 'string') text = msg(text);
  const changed = kind !== runtime.lastStatus.kind || displayText(text) !== displayText(runtime.lastStatus.text);
  const started = kind === 'working' && runtime.lastStatus.kind !== 'working';
  runtime.lastStatus = { kind, text };
  if (changed) {
    recordDiagnostic('status', { requestId: runtime.diagnosticRequestId, kind, code: text.translationKey || text.key || text.name || 'status', values: text.diagnosticValues, ...(text instanceof Error ? { causes: diagnosticError(text) } : {}) });
    if (started || ['success', 'error', 'warning'].includes(kind)) {
      const noticeKind = started ? 'info' : kind;
      showNotice(noticeKind, text);
    }
  }
  const element = document.getElementById('smp-status');
  if (element) {
    element.dataset.kind = kind;
    element.textContent = displayText(text);
  }
  updateJobControls();
}

function updateJobControls() {
  const busy = runtime.summarizing || runtime.queued;
  const cancel = document.getElementById('smp-cancel');
  if (cancel) cancel.disabled = !runtime.summarizing || runtime.cancelRequested;
  for (const id of ['smp-generate-preview', 'smp-save-preview', 'smp-close-regeneration', 'smp-discard-preview', 'smp-compact-now', 'smp-test-summarizer', 'smp-clear']) {
    const button = document.getElementById(id);
    if (button) button.disabled = busy || (id === 'smp-save-preview' && !runtime.regenerationPreview);
  }
  const wish = document.getElementById('smp-regeneration-wish');
  if (wish) wish.disabled = runtime.summarizing;
  const close = document.getElementById('smp-close-regeneration');
  if (close) close.hidden = Boolean(runtime.regenerationPreview);
  for (const tab of document.querySelectorAll('[data-smp-tab]')) tab.disabled = runtime.summarizing;
  updatePinnedFactsControls();
}

function beginMemoryJob(chatId = null) {
  if (runtime.summarizing || runtime.queued) throw new LocalizedError(msg('Another memory job is already running'));
  runtime.summarizing = true;
  runtime.diagnosticRequestId = nextDiagnosticRequest();
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
  runtime.diagnosticRequestId = null;
  runtime.cancelRequested = false;
  updateBlockActionBar();
  updateManualRollupControls();
  updateJobControls();
  schedulePassivePromptRefresh();
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
    throw new LocalizedError(msg('Refusing to write memory after chat change'));
  }
  const context = getContext();
  if (!Array.isArray(context?.chat) || !context.chat.length) return;
  closeRegeneration();
  chat_metadata[MEMORY_KEY] = normalizeMemory(memory);
  if (save) {
    await saveChatConditional();
    if (expectedChatId !== null && getCurrentChatId() !== expectedChatId) {
      throw new LocalizedError(msg('Chat changed while saving memory'));
    }
  }
  renderLibrary();
}

function updatePinnedFactsControls() {
  const input = document.getElementById('smp-pinned-facts');
  const button = document.getElementById('smp-save-facts');
  const state = document.getElementById('smp-facts-state');
  if (!input || !button) return;
  const hasChat = getCurrentChatId() != null && Boolean(getContext()?.chat?.length);
  const changed = input.value.trim() !== runtime.factsEditorValue;
  input.disabled = !hasChat || runtime.summarizing;
  button.disabled = !hasChat || runtime.summarizing || !changed;
  if (state) state.textContent = translate(!hasChat ? 'Open a chat.' : changed ? 'Unsaved' : 'Saved');
}

function syncPinnedFactsEditor(reset = false) {
  const input = document.getElementById('smp-pinned-facts');
  if (!input) return;
  const chatId = getCurrentChatId();
  const facts = getChatMemory().pinnedFacts || '';
  // Refresh updates saved content while leaving the current chat's draft intact.
  if (reset || chatId !== runtime.factsEditorChatId || input.value === runtime.factsEditorValue || input.value.trim() === facts) {
    input.value = facts;
    runtime.factsEditorChatId = chatId;
    runtime.factsEditorValue = facts;
  }
  updatePinnedFactsControls();
}

async function savePinnedFacts() {
  if (runtime.summarizing) return;
  const chatId = getCurrentChatId();
  if (chatId == null || chatId !== runtime.factsEditorChatId) throw new LocalizedError(msg('Open a chat before saving facts.'));
  const input = document.getElementById('smp-pinned-facts');
  const memory = structuredClone(getChatMemory());
  const facts = input.value.trim();
  if (facts) memory.pinnedFacts = facts;
  else delete memory.pinnedFacts;
  await setChatMemory(memory, true, chatId);
  setStatus('success', facts ? msg('Pinned facts saved for this chat.') : msg('Pinned facts cleared.'));
}

function getCurrentComparableChat() {
  const context = getContext();
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  return chat
    .filter(message => !message?.is_system || Array.isArray(message?.extra?.tool_invocations))
    .map((message, index) => ({ ...message, index }));
}

function excludedSourceMessages() {
  return getCurrentComparableChat().filter(message => message.extra?.[Symbol.for('ignore')]).map(message => ({ index: message.index, reason: 'hidden-by-tavern' }));
}

function fingerprintsStillMatch(fingerprints) {
  const current = getCurrentComparableChat();
  const missing = fingerprints.flatMap(fingerprint => {
    const message = findCurrentMessage(current, fingerprint);
    const actualHash = message ? fingerprintMessage(message).hash : null;
    return message && message.index === fingerprint.index && actualHash === fingerprint.hash ? [] : [{
      index: fingerprint.index, actualIndex: message?.index ?? null,
      reason: !message ? 'source-missing' : message.index !== fingerprint.index ? 'source-moved' : 'content-changed',
      expectedHash: fingerprint.hash, actualHash,
    }];
  });
  if (missing.length) recordDiagnostic('source-check-failed', { requestId: runtime.diagnosticRequestId, missing });
  return !missing.length;
}

function memoryPromptSnapshot(memory = getChatMemory()) {
  return JSON.stringify({ pinnedFacts: memory.pinnedFacts, blocks: memory.blocks.map(({ summaryTokens, rawTokens, ...block }) => block) });
}

function assertMemoryEditCurrent(chatId, snapshot) {
  if (getCurrentChatId() !== chatId) throw new LocalizedError(msg('Chat changed before memory commit.'));
  if (snapshot !== memoryPromptSnapshot()) throw new LocalizedError(msg('Memory changed during the operation. Try again.'));
}

function verifyMemorySources(memory) {
  const result = reconcileMemorySources(memory, getCurrentComparableChat());
  if (result.changes.length) recordDiagnostic('memory-reconciled', { invalidated: result.changedIds.length, recovered: result.recoveredIds.length, blocks: result.changes });
  return result.memory;
}

function activeMemoryIsValid(rawChat, memory) {
  return getActiveBlocks(memory).every(block =>
    !hasSourceIdentity(block) || blockSourceMatches(block, rawChat));
}

async function reconcileChatMemory(memory, reason = null) {
  const chatId = getCurrentChatId();
  const result = reconcileMemorySources(memory, getCurrentComparableChat());
  if (result.changedIds.length || result.recoveredIds.length) {
    await setChatMemory(result.memory, true, chatId);
    recordDiagnostic('memory-reconciled', { invalidated: result.changedIds.length, recovered: result.recoveredIds.length, blocks: result.changes });
    if (result.changedIds.length && reason) setStatus('warning', reason);
  }
  return result.memory;
}

async function countCoreChat(coreChat) {
  const counts = await Promise.all(coreChat.map(async message => ({
    message,
    index: Math.max(0, Number(message?.index) || 0),
    tokens: await countTextTokens(String(message?.promptText ?? message?.mes ?? '')),
  })));
  return counts;
}

async function refreshActiveBlockTokenCounts(memory, settings, sourceChat) {
  for (const block of memory.blocks) {
    if (block.status !== 'active') continue;
    block.summaryTokens = await countTextTokens(renderBlockText(block, settings.includeStructuredMemory));
    if (block.useRaw) block.rawTokens = sumTokens(await countCoreChat(sourceChat.filter(message => message.index >= block.sourceFrom && message.index <= block.sourceTo)));
  }
  return memory;
}

async function requestSummary(prompt, targetTokens, level, stage, instruction = '') {
  if (runtime.cancelRequested) throw new LocalizedError(msg('Compaction cancelled'));
  if (runtime.activeCompactionChatId !== null && getCurrentChatId() !== runtime.activeCompactionChatId) {
    throw new LocalizedError(msg('Chat changed during compaction'));
  }
  const settings = getSettings();
  const countTokens = value => countTextTokens(value);
  const { usefulOutputTokens, requestMaxTokens, systemPrompt } = await getSummarySourceBudget({
    settings,
    stage,
    targetTokens,
    level,
    instruction,
    countTokens,
  });
  await assertSummaryRequestFits({ settings, prompt, systemPrompt, requestMaxTokens, countTokens });
  const summaryRequestId = nextDiagnosticRequest();
  recordDiagnostic('summary-request', { requestId: summaryRequestId, parentRequestId: runtime.diagnosticRequestId, stage, level, targetTokens, requestMaxTokens, inputTokens: await countTokens(prompt), separateProfile: Boolean(settings.summaryProfileId), reasoningEffort: 'low' });
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
  const extractSummary = (response, api) => {
    const tool = Array.isArray(response?.content)
      ? response.content.find(part => part.type === 'tool_use' && part.name === SUMMARY_JSON_SCHEMA.name) : null;
    return tool ? tool.input : extractMessageFromData(response, api);
  };
  const validateResponse = async (response, finishReason = '') => {
    const rawText = typeof response === 'string' ? response.trim() : '';
    if (/<!--\s*oai-proxy-error\s*-->/i.test(rawText) || /^###\s*\*\*Proxy error/im.test(rawText)) {
      const note = rawText.match(/"proxy_note"\s*:\s*"([^"]+)"/i)?.[1]
        || rawText.match(/^\*([^*\r\n]+)\*/m)?.[1]
        || msg('Proxy rejected the summarizer request');
      throw new LocalizedError(msg`Summarizer provider error: ${note}`);
    }

    let structured;
    try {
      structured = parseStructuredSummary(response);
    } catch (error) {
      if (/length|max.?tokens/i.test(finishReason)) {
        throw new LocalizedError(msg`Summarizer stopped at its output limit (${finishReason}); incomplete block was discarded`, { cause: error });
      }
      // Response classification is independent of the displayed error language.
      if (error.translationKey === 'Summarizer JSON has no narrative') {
        throw new LocalizedError(msg('Summarizer returned an empty structured object; the selected model/provider did not populate the JSON Schema'), { cause: error });
      }
      throw error;
    }
    const canonicalText = JSON.stringify(structured);
    const outputTokens = await countTextTokens(canonicalText);
    if (outputTokens > usefulOutputTokens) {
      throw new LocalizedError(msg`Summarizer output exceeded the useful output limit (${outputTokens}/${usefulOutputTokens} tokens)`);
    }
    recordDiagnostic('summary-response', { requestId: summaryRequestId, parentRequestId: runtime.diagnosticRequestId, outputTokens, finishReason: /^[a-z_]{0,64}$/i.test(finishReason) ? finishReason : 'other' });
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
        reasoning_effort: 'low',
        include_reasoning: false,
        json_schema: SUMMARY_JSON_SCHEMA,
      },
    );
    return await validateResponse(extractSummary(response, apiMap.selected), getFinishReason(response));
  }

  runtime.fallbackSummaryActive = true;
  const overrideFallbackPayload = payload => {
    payload.max_tokens = requestMaxTokens;
    payload.reasoning_effort = 'low';
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
    return await validateResponse(extractSummary(response), getFinishReason(response));
  } finally {
    eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, overrideFallbackPayload);
    runtime.fallbackSummaryActive = false;
  }
}

async function requestStructuredSummary(prompt, targetTokens, level, stage, label, instruction = '') {
  try {
    return parseStructuredSummary(await requestSummary(prompt, targetTokens, level, stage, instruction));
  } catch (error) {
    throw new LocalizedError(msg`${label}: ${error}`, { cause: error });
  }
}

async function reduceStructuredSummaries(parts, targetTokens, level, round = 1, instruction = '') {
  if (round > 12) throw new LocalizedError(msg('Map/reduce did not converge within 12 rounds'));
  const { sourceBudget: inputBudget } = await getSummarySourceBudget({
    settings: getSettings(),
    stage: 'rollup',
    targetTokens,
    level,
    instruction,
    countTokens: value => countTextTokens(value),
  });
  const groups = await chunkStructuredSources(parts.map((structured, index) => ({ index: index + 1, structured })),
    Math.floor(inputBudget * 0.9), value => countTextTokens(value));

  if (groups.length === 1) {
    return await requestSummary(groups[0], targetTokens, level, 'rollup', instruction);
  }

  setStatus('working', msg`Recursive reduce round ${round}: ${parts.length} memories in ${groups.length} chunks.`);
  const intermediateTarget = Math.max(256, Math.min(1500, targetTokens, Math.floor(inputBudget / 4)));
  const next = [];
  for (let index = 0; index < groups.length; index++) {
    next.push(await requestStructuredSummary(
      groups[index],
      intermediateTarget,
      level,
      'rollup',
      msg`Reduce summary ${round}.${index + 1}`,
      instruction,
    ));
  }
  return await reduceStructuredSummaries(next, targetTokens, level, round + 1, instruction);
}

async function createBlock({ level, sourceEntries = [], childBlocks = [], targetTokens, instruction = '' }) {
  const isRaw = level === 1;
  const settings = getSettings();
  const currentChat = getCurrentComparableChat();
  const fingerprints = isRaw
    ? sourceEntries.map(entry => fingerprintMessage(findCurrentMessage(currentChat, {
      index: entry.index, id: getMessageIdentity(entry.message),
    }) || entry.message))
    : childBlocks.flatMap(block => getBlockRangeMessages(block).map(fingerprintMessage));
  const stage = isRaw ? 'raw' : 'rollup';
  const countTokens = value => countTextTokens(value);
  const { sourceBudget: inputBudget } = await getSummarySourceBudget({
    settings,
    stage,
    targetTokens,
    level,
    instruction,
    countTokens,
  });
  let groups;
  if (isRaw) {
    const prompt = formatRawSources(sourceEntries);
    if (await countTokens(prompt) <= Math.floor(inputBudget * 0.9)) {
      groups = [prompt];
    } else {
      const sourceUnits = await splitOversizedRawEntries(sourceEntries, inputBudget, countTokens);
      const units = await Promise.all(sourceUnits.map(async unit => ({ ...unit, tokens: await countTokens(formatRawSources([unit])) })));
      groups = chunkByTokenBudget(units, Math.floor(inputBudget * 0.9)).map(formatRawSources);
    }
  } else {
    for (const child of childBlocks) {
      const evidence = inspectBlockSource(child, currentChat);
      if (child.staleReason === 'summary-edited' || hasSourceIdentity(child) && !evidence.matches || evidence.reason === 'source-hidden') {
        recordDiagnostic('source-check-failed', { requestId: runtime.diagnosticRequestId, blocks: [{ id: child.id, from: child.sourceFrom, to: child.sourceTo, ...evidence }] });
        throw new LocalizedError(msg`Source block ${child.id} changed. Regenerate that block before merging.`);
      }
    }
    const prompt = formatSummarySources(childBlocks);
    groups = await countTokens(prompt) <= Math.floor(inputBudget * 0.9) ? [prompt]
      : await chunkStructuredSources(childBlocks.map(block => ({ level: block.level,
        source: [block.sourceFrom, block.sourceTo], structured: block.structured })), Math.floor(inputBudget * 0.9), countTokens);
  }
  if (!groups.length) throw new LocalizedError(msg('Compaction source is empty'));

  let responseText = '';
  if (groups.length === 1) {
    responseText = await requestSummary(groups[0], targetTokens, level, stage, instruction);
  } else {
    setStatus('working', msg`Map/reduce compaction: ${groups.length} source chunks.`);
    const intermediateTarget = Math.max(512, Math.min(2000, targetTokens));
    const intermediate = [];
    for (let index = 0; index < groups.length; index++) {
      intermediate.push(await requestStructuredSummary(
        groups[index],
        intermediateTarget,
        level,
        stage,
        msg`Intermediate summary ${index + 1}`,
        instruction,
      ));
    }
    responseText = await reduceStructuredSummaries(intermediate, targetTokens, level, 1, instruction);
  }
  const structured = parseStructuredSummary(responseText);

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

  block.summaryTokens = await countTextTokens(renderBlockText(block, settings.includeStructuredMemory));
  if (block.summaryTokens > targetTokens) {
    try {
      const reducedText = await requestSummary(JSON.stringify(structured), targetTokens, level, 'reduce', instruction);
      const reduced = { ...block, structured: parseStructuredSummary(reducedText) };
      reduced.summaryTokens = await countTextTokens(renderBlockText(reduced, settings.includeStructuredMemory));
      if (reduced.summaryTokens < block.summaryTokens) block = reduced;
    } catch (error) {
      if (runtime.cancelRequested || runtime.abortController?.signal.aborted || (runtime.activeCompactionChatId !== null && getCurrentChatId() !== runtime.activeCompactionChatId)) throw error;
      // A failed optional reduction cannot invalidate a complete checked answer.
      debug('Keeping complete summary after reduction failure', error);
      recordDiagnostic('reduction-failed', { causes: diagnosticError(error), retainedTokens: block.summaryTokens });
    }
  }
  recordDiagnostic('block-staged', { requestId: runtime.diagnosticRequestId, id: block.id, level, from: sourceFrom, to: sourceTo,
    sourceIndices: sourceEntries.map(entry => entry.index), childIds: childBlocks.map(child => child.id), sourceTokens, summaryTokens: block.summaryTokens });
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
    throw new LocalizedError(msg`Raw source ${sourceFrom}–${sourceTo} is no longer fully available`);
  }
  if (messages.some(message => message.extra?.[Symbol.for('ignore')])) throw new LocalizedError(msg('Source contains hidden messages. Restore them before regenerating this block.'));
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
  if (getCurrentChatId() !== preview.chatId) throw new LocalizedError(msg('Chat changed; generate a new preview.'));
  if (memoryPromptSnapshot() !== preview.originalMemory) throw new LocalizedError(msg('Memory changed; generate a new preview.'));
  if (regenerationSourceSnapshot(preview.memory, preview.ids) !== preview.sourceSnapshot) {
    throw new LocalizedError(msg('Source messages changed; generate a new preview.'));
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
  setStatus('success', preview.ids.length > 1
    ? msg`Saved ${preview.ids.length} updated memory blocks.`
    : msg('Saved block replacement.'));
}

async function regenerateMemoryBlock(blockId, instruction = '') {
  if (runtime.summarizing) throw new LocalizedError(msg('Another compaction job is already running'));
  const chatId = getCurrentChatId();
  if (chatId == null) throw new LocalizedError(msg('No active chat'));
  const original = getChatMemory();
  const selected = getBlockById(original, blockId);
  if (!selected) throw new LocalizedError(msg('Selected memory block no longer exists'));

  const ids = [selected.id, ...getBlockAncestorIds(original, selected.id)];
  const originalMemory = memoryPromptSnapshot(original);
  const sourceSnapshot = regenerationSourceSnapshot(original, ids);
  const settings = getSettings();

  runtime.regenerationPreview = null;
  document.getElementById('smp-regeneration-preview').hidden = true;
  beginMemoryJob(chatId);
  try {
    const result = await stageBlockRegeneration({
      memory: original,
      blockId: selected.id,
      sourceNeedsRegeneration: block => block.staleReason === 'summary-edited' || hasSourceIdentity(block) && !blockSourceMatches(block, getCurrentComparableChat()),
      onStage: ({ block, position, total }) => {
        if (runtime.cancelRequested) throw new LocalizedError(msg('Block regeneration cancelled'));
        if (getCurrentChatId() !== chatId) throw new LocalizedError(msg('Chat changed during block regeneration'));
        setStatus(
          'working',
          msg`Regenerating L${block.level} block ${position + 1}/${total}${position ? msg(' (dependent rollup)') : ''}.`,
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
            throw new LocalizedError(msg`L${current.level} block has missing source children`);
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

    if (runtime.cancelRequested) throw new LocalizedError(msg('Block regeneration cancelled'));
    if (getCurrentChatId() !== chatId) throw new LocalizedError(msg('Chat changed before regenerated block commit'));
    const preview = { memory: result.memory, originalMemory, sourceSnapshot, ids: result.regeneratedIds, blockId: selected.id, chatId };
    assertRegenerationCurrent(preview);
    runtime.regenerationPreview = preview;
    const replacement = getBlockById(result.memory, selected.id);
    document.getElementById('smp-regeneration-comparison').innerHTML = renderRegenerationComparison(selected, replacement);
    document.getElementById('smp-regeneration-preview').hidden = false;
    setStatus('idle', msg('Preview ready.'));
    showNotice('success', msg('Preview ready.'));
  } catch (error) {
    if (getCurrentChatId() === chatId) setStatus(runtime.cancelRequested ? 'warning' : 'error', error);
    throw error;
  } finally {
    endMemoryJob();
  }
}

async function createManualRollup() {
  if (runtime.summarizing) return;
  const chatId = getCurrentChatId();
  if (chatId == null) throw new LocalizedError(msg('No active chat'));
  const memory = getChatMemory();
  const snapshot = memoryPromptSnapshot(memory);
  const selected = getManualRollupBlocks(memory, [...runtime.manualRollupIds]);
  const sourceLevel = selected[0].level;
  const targetLevel = sourceLevel + 1;
  if (!confirm(t`Merge ${selected.length} selected L${sourceLevel} blocks into one L${targetLevel} block?`)) return;

  const settings = getSettings();
  beginMemoryJob(chatId);
  setStatus('working', msg`Merging ${selected.length} selected L${sourceLevel} blocks into L${targetLevel}.`);

  try {
    const result = await stageManualRollup({
      memory,
      childIds: selected.map(block => block.id),
      targetTokens: settings.blockTargetTokens,
      createBlock,
      validateBlock: (block, label) => {
        if (runtime.cancelRequested) throw new LocalizedError(msg('Manual rollup cancelled'));
        assertBlockSourceStillCurrent(block, chatId, label);
      },
    });
    if (runtime.cancelRequested) throw new LocalizedError(msg('Manual rollup cancelled'));
    if (getCurrentChatId() !== chatId) throw new LocalizedError(msg('Chat changed before manual rollup commit'));
    assertMemoryEditCurrent(chatId, snapshot);
    runtime.manualRollupIds.clear();
    runtime.selectedBlockId = result.rollupBlock.id;
    await setChatMemory(result.memory, true, chatId);
    setStatus(
      'success',
      msg`Created L${result.targetLevel} from ${result.childIds.length} selected L${result.sourceLevel} blocks: ${result.rollupBlock.sourceTokens} → ${result.rollupBlock.summaryTokens} tokens.`,
    );
  } catch (error) {
    const message = error;
    setStatus(runtime.cancelRequested ? 'warning' : 'error', message);
    throw error;
  } finally {
    endMemoryJob();
  }
}

async function toggleBlockRawSource(blockId) {
  if (runtime.summarizing || runtime.queued) return;
  const chatId = getCurrentChatId();
  const memory = getChatMemory();
  const snapshot = memoryPromptSnapshot(memory);
  const block = getBlockById(memory, blockId);
  if (!block) return;
  const useRaw = !block.useRaw;
  const next = setBlockUseRaw(memory, block.id, useRaw);
  if (useRaw) {
    const nextBlock = getBlockById(next, block.id);
    nextBlock.rawTokens = sumTokens(await countCoreChat(getBlockRangeMessages(block)));
    runtime.manualRollupIds.delete(block.id);
  }
  assertMemoryEditCurrent(chatId, snapshot);
  await setChatMemory(next, true, chatId);
  setStatus('success', useRaw ? msg('Using original history for this block.') : msg('Using summary for this block.'));
}

async function deleteSelectedMemoryBlock(blockId = runtime.selectedBlockId) {
  if (runtime.summarizing || runtime.queued) return;
  const chatId = getCurrentChatId();
  const memory = getChatMemory();
  const selected = getBlockById(memory, blockId);
  if (!selected) return;
  const preview = deleteMemoryBlock(memory, selected.id);
  const dependentCount = preview.removedIds.length - 1;
  const message = dependentCount
    ? msg`Delete L${selected.level} block and ${dependentCount} dependent rollup(s)? Raw source will be exposed where coverage becomes discontinuous.`
    : msg`Delete selected L${selected.level} block? Its raw source will become visible again.`;
  if (!confirm(displayText(message))) return;

  preview.memory = verifyMemorySources(preview.memory);
  preview.staleIds = preview.memory.blocks.filter(block => block.status === 'stale' && getBlockById(memory, block.id)?.status !== 'stale').map(block => block.id);
  preview.reactivatedIds = preview.reactivatedIds.filter(id => getBlockById(preview.memory, id)?.status === 'active');
  await setChatMemory(preview.memory, true, chatId);
  recordDiagnostic('memory-deleted', { targetId: selected.id, removedIds: preview.removedIds,
    blocks: preview.memory.blocks.filter(block => preview.staleIds.includes(block.id) || preview.reactivatedIds.includes(block.id))
      .map(block => ({ id: block.id, level: block.level, from: block.sourceFrom, to: block.sourceTo, status: block.status, reason: block.staleReason || 'parent-deleted' })) });
  if (runtime.selectedBlockId === selected.id) runtime.selectedBlockId = null;
  if (runtime.editingBlockId === selected.id) runtime.editingBlockId = null;
  setStatus(
    'success',
    msg`Deleted ${preview.removedIds.length} block(s); reactivated ${preview.reactivatedIds.length}, marked stale ${preview.staleIds.length}.`,
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
  if (runtime.editingBlockId === String(blockId || '')) { runtime.editingBlockId = null; runtime.editingBlockSnapshot = null; }
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
  runtime.editingBlockSnapshot = JSON.stringify(block.structured);
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
  if (!(narrative instanceof HTMLTextAreaElement)) throw new LocalizedError(msg('Block editor is unavailable'));
  const structured = { narrative: narrative.value.trim() };
  const title = blockElement.querySelector('input[data-field="title"]')?.value.trim();
  if (title) structured.title = title;
  for (const [field] of BLOCK_EDITOR_FIELDS) {
    const textarea = blockElement.querySelector(`textarea[data-field="${field}"]`);
    if (!(textarea instanceof HTMLTextAreaElement)) throw new LocalizedError(msg`Block editor field ${field} is unavailable`);
    structured[field] = textarea.value
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(Boolean);
  }
  return parseStructuredSummary(structured);
}

async function saveSelectedBlockEdit(blockId = runtime.editingBlockId) {
  if (runtime.summarizing || runtime.queued) return;
  const chatId = getCurrentChatId();
  if (chatId == null) throw new LocalizedError(msg('No active chat'));
  const memory = getChatMemory();
  const block = getBlockById(memory, blockId);
  if (!block) throw new LocalizedError(msg('Selected memory block no longer exists'));
  const snapshot = memoryPromptSnapshot(memory);
  if (runtime.editingBlockSnapshot !== JSON.stringify(block.structured)) throw new LocalizedError(msg('Memory changed during the operation. Try again.'));
  const dependentCount = getBlockAncestorIds(memory, block.id).length;
  if (dependentCount && !confirm(t`Editing this block will mark ${dependentCount} dependent rollup(s) stale and reactivate their source blocks. Continue?`)) {
    return;
  }

  const blockElement = findBlockElement(block.id);
  const structured = readBlockEditor(blockElement);
  const settings = getSettings();
  const summaryTokens = await countTextTokens(renderBlockText({ ...block, structured }, settings.includeStructuredMemory));
  assertMemoryEditCurrent(chatId, snapshot);
  const result = editMemoryBlock(memory, block.id, structured, summaryTokens);
  result.memory = verifyMemorySources(result.memory);
  result.staleIds = result.memory.blocks.filter(item => item.status === 'stale' && getBlockById(memory, item.id)?.status !== 'stale').map(item => item.id);
  result.reactivatedIds = result.reactivatedIds.filter(id => getBlockById(result.memory, id)?.status === 'active');
  if (getCurrentChatId() !== chatId) throw new LocalizedError(msg('Chat changed before edited block commit'));
  runtime.editingBlockId = null;
  await setChatMemory(result.memory, true, chatId);
  recordDiagnostic('memory-edited', { targetId: block.id,
    blocks: result.memory.blocks.filter(item => result.staleIds.includes(item.id) || result.reactivatedIds.includes(item.id))
      .map(item => ({ id: item.id, level: item.level, from: item.sourceFrom, to: item.sourceTo, status: item.status, reason: item.staleReason || 'parent-edited' })) });
  setStatus(
    'success',
    msg`Saved block edit; invalidated ${result.dependentIds.length} rollup(s), reactivated ${result.reactivatedIds.length} source block(s).`,
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
  setStatus('success', msg`Copied L${block.level} block JSON.`);
}

function exportSelectedBlock() {
  const block = getSelectedMemoryBlock();
  if (!block) return;
  downloadJson(block, `silly-memories-plus-${block.id}.json`);
  setStatus('success', msg`Exported L${block.level} block.`);
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
      ? t`Selected: L${block.level} · ${block.sourceFrom}–${block.sourceTo} · ${translate(block.status)} · ${block.sourceTokens} → ${block.summaryTokens}t`
      : translate('No block selected.');
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
    error = selectionError;
  }

  if (label) {
    if (error) label.textContent = displayText(error);
    else if (selected.length) {
      label.textContent = t`${selected.length} × L${selected[0].level} · source ${selected[0].sourceFrom}–${selected.at(-1).sourceTo} → L${selected[0].level + 1}.`;
    } else if (runtime.manualRollupIds.size === 1) {
      label.textContent = `1 × L${selectedLevel}`;
    } else {
      label.textContent = '';
    }
  }
  if (button instanceof HTMLButtonElement) {
    button.disabled = runtime.summarizing || selected.length < 2 || Boolean(error);
    const text = button.querySelector('span');
    if (text) text.textContent = selectedLevel === null ? translate('Merge blocks') : t`Merge L${selectedLevel} → L${selectedLevel + 1}`;
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
  const result = settings.enabled ? rewriteConversationWithMemory(
    coreChat,
    memory,
    (text, blocks) => {
      const message = makeSyntheticMemoryMessage(text, settings);
      message.extra.sillyMemoriesPlusBlockIds = blocks.map(block => block.id);
      return message;
    },
    settings.includeStructuredMemory,
  ) : { messages: [...coreChat], activeBlocks: [], coveredThrough: -1 };
  const facts = renderPinnedFacts(memory.pinnedFacts);
  if (facts) {
    const message = makeSyntheticMemoryMessage(facts, settings);
    message.name = 'Pinned facts';
    message.extra.sillyMemoriesPlusPinnedFacts = true;
    result.messages.unshift(message);
  }
  coreChat.splice(0, coreChat.length, ...result.messages);
  debug('Prompt rewritten', {
    activeBlocks: result.activeBlocks.length,
    rawBlocks: result.activeBlocks.filter(block => block.useRaw).length,
    coveredThrough: result.coveredThrough,
  });
}

function assertBlockSourceStillCurrent(block, chatId, label) {
  if (getCurrentChatId() !== chatId) throw new LocalizedError(msg`Chat changed during ${typeof label === 'string' ? msg(label) : label}`);
  if (!fingerprintsStillMatch(block.sourceFingerprints)) throw new LocalizedError(msg`Source changed during ${typeof label === 'string' ? msg(label) : label}`);
  if (inspectBlockSource(block, getCurrentComparableChat()).reason === 'source-hidden') throw new LocalizedError(msg('Source contains hidden messages. Restore them before regenerating this block.'));
}

function assertPinnedFactsCurrent(memory, chatId) {
  if (chatId !== getCurrentChatId()) throw new LocalizedError(msg('Chat changed during context preparation.'));
  if ((memory.pinnedFacts || '') !== (getChatMemory().pinnedFacts || '')) {
    throw new LocalizedError(msg('Pinned facts changed during context preparation. Start generation again.'));
  }
}

async function executePlanTransaction(plan, memory, chatId, contextSize, settings, pinnedTokens, preparedFingerprints, fixedPromptTokens, force) {
  runtime.abortController = new AbortController();
  runtime.activeCompactionChatId = chatId;
  let committedSnapshot = memoryPromptSnapshot(memory);
  try {
    const result = await stageCompactionTransaction({
      plan,
      memory,
      contextBudget: contextSize,
      fixedPromptTokens: fixedPromptTokens + pinnedTokens,
      settings,
      force,
      partitionRawSource: force ? async (entries, targetTokens) => {
        const countTokens = text => {
          runtime.abortController.signal.throwIfAborted();
          return countTextTokens(text);
        };
        const { sourceBudget } = await getSummarySourceBudget({ settings, stage: 'raw', targetTokens, level: 1, countTokens });
        const batchBudget = Math.floor(sourceBudget * 0.9);
        const groups = await partitionRawEntries(entries, batchBudget, countTokens);
        recordDiagnostic('raw-batches', { requestId: runtime.diagnosticRequestId, inputBudget: settings.summaryInputBudgetTokens, sourceBudget, batchBudget,
          blocks: groups.map(source => ({ from: source[0].index, to: source.at(-1).index, sourceTokens: sumTokens(source) })) });
        return groups;
      } : undefined,
      createBlock,
      validateBlock: (block, label) => {
        if (runtime.cancelRequested) throw new LocalizedError(msg('Compaction cancelled'));
        assertBlockSourceStillCurrent(block, chatId, label);
      },
      onStage: ({ kind, plan: stagePlan, level, batchIndex, batchCount }) => {
        if (runtime.cancelRequested) throw new LocalizedError(msg('Compaction cancelled'));
        recordDiagnostic('compaction-stage', { requestId: runtime.diagnosticRequestId, kind, level, batchIndex, batchCount,
          sourceIndices: stagePlan.source?.map(entry => entry.index), childIds: stagePlan.blocks?.map(block => block.id), targetTokens: stagePlan.targetTokens });
        if (kind === 'raw') {
          setStatus('working', batchCount > 1
            ? msg`Summarizing part ${batchIndex}/${batchCount}: ${stagePlan.sourceTokens} → ~${stagePlan.targetTokens} tokens.`
            : msg`Compacting ${stagePlan.sourceTokens} raw tokens into ~${stagePlan.targetTokens}.`);
        } else {
          setStatus('working', msg`Rolling ${stagePlan.blocks.length} memory blocks into L${level}.`);
        }
      },
      onCheckpoint: async candidate => {
        if (runtime.cancelRequested) throw new LocalizedError(msg('Compaction cancelled'));
        if (!fingerprintsStillMatch(preparedFingerprints)) throw new LocalizedError(msg('Source messages changed during compaction. Start generation again.'));
        for (const block of getActiveFrontier(candidate).blocks) assertBlockSourceStillCurrent(block, chatId, msg('compaction'));
        assertPinnedFactsCurrent(candidate, chatId);
        assertMemoryEditCurrent(chatId, committedSnapshot);
        await setChatMemory(candidate, true, chatId);
        committedSnapshot = memoryPromptSnapshot(candidate);
        recordDiagnostic('checkpoint', { requestId: runtime.diagnosticRequestId, totalBlocks: candidate.blocks.length,
          blocks: candidate.blocks.map(block => ({ id: block.id, level: block.level, from: block.sourceFrom, to: block.sourceTo, status: block.status, reason: block.staleReason })) });
      },
    });

    if (runtime.cancelRequested) throw new LocalizedError(msg('Compaction cancelled'));
    if (getCurrentChatId() !== chatId) throw new LocalizedError(msg('Chat changed before memory commit'));
    for (const block of getActiveFrontier(result.memory).blocks) {
      assertBlockSourceStillCurrent(block, chatId, msg('compaction'));
    }
    assertPinnedFactsCurrent(result.memory, chatId);
    updateContextFromPlan(result.finalPlan, contextSize, pinnedTokens);
    updateStats(result.memory);
    const rawSourceTokens = result.rawBlocks.reduce((sum, block) => sum + block.sourceTokens, 0);
    const rawSummaryTokens = sumTokens(result.rawBlocks);
    if (result.rawBlocks.length && result.rollupBlock) {
      setStatus(
        'success',
        msg`Saved L1 and L${result.rollupBlock.level}: ${rawSourceTokens} → ${rawSummaryTokens}t, tier ${result.rollupBlock.sourceTokens} → ${result.rollupBlock.summaryTokens}t.`,
      );
    } else if (result.rawBlocks.length > 1) {
      setStatus('success', msg`Created ${result.rawBlocks.length} L1 blocks: ${rawSourceTokens} → ${rawSummaryTokens} tokens.`);
    } else if (result.rawBlocks.length) {
      setStatus('success', msg`Created L1 block: ${rawSourceTokens} → ${rawSummaryTokens} tokens.`);
    } else if (result.rollupBlock) {
      setStatus(
        'success',
        msg`Created L${result.rollupBlock.level} rollup: ${result.rollupBlock.sourceTokens} → ${result.rollupBlock.summaryTokens} tokens.`,
      );
    }
    return result.memory;
  } finally {
    runtime.abortController = null;
    runtime.activeCompactionChatId = null;
  }
}

async function runInterceptor(coreChat, contextSize, abort, type, measuredFixedTokens = null) {
  if (!Array.isArray(coreChat) || !coreChat.length || runtime.summarizing || type === 'quiet' || type === 'impersonate') return;
  if (runtime.queued) { abort?.(true); return; }
  runtime.queued = true;
  updateJobControls();
  const chatId = getCurrentChatId();
  try {
    if (type === 'manual') {
      const snapshot = memoryPromptSnapshot();
      const fingerprints = getCurrentComparableChat().map(fingerprintMessage);
      const cache = runtime.preparedHistoryByChat.get(String(chatId));
      const formatted = await prepareStoredHistory(coreChat);
      assertMemoryEditCurrent(chatId, snapshot);
      if (!fingerprintsStillMatch(fingerprints)) throw new LocalizedError(msg('Source messages changed during compaction. Start generation again.'));
      coreChat.splice(0, coreChat.length, ...formatted.map(message => {
        const cached = cache?.get(message.index);
        const text = cached?.hash === fingerprints.find(item => item.index === message.index)?.hash
          ? cached.promptText : substituteParams(message.mes);
        return { ...message, mes: text, promptText: text };
      }));
    }
    return await prepareMemoryContext(coreChat, contextSize, abort, type, measuredFixedTokens);
  } catch (error) {
    if (getCurrentChatId() === chatId) setStatus('error', error);
    abort?.(true);
  }
  finally { runtime.forceCompaction = false; runtime.queued = false; updateJobControls(); schedulePassivePromptRefresh(); }
}

async function prepareMemoryContext(coreChat, contextSize, abort, type, measuredFixedTokens = null) {
  const settings = getSettings();
  const requestId = type === 'prepared' ? runtime.pendingPromptMeasurement?.requestId : nextDiagnosticRequest();
  runtime.diagnosticRequestId = requestId;
  const excluded = excludedSourceMessages();
  // Injected memory and facts never become raw sources on repeated interception.
  const sourceChat = coreChat.filter(message => !isSynthetic(message) && !message.extra?.[Symbol.for('ignore')]);
  if (sourceChat.length !== coreChat.length) coreChat.splice(0, coreChat.length, ...sourceChat);
  runtime.contextBudgetsByChat.set(String(getCurrentChatId()), contextSize);
  ++runtime.contextRevision;
  const preparedChatId = getCurrentChatId();
  const preparedFingerprints = getCurrentComparableChat().map(fingerprintMessage);
  const originalSource = structuredClone(coreChat);
  if (settings.debug && type !== 'prepared') recordDiagnostic('text-trace', {
    requestId, phase: type, fromStage: 'stored-history', toStage: 'interceptor',
    messages: traceIndexedText(getCurrentComparableChat(), originalSource),
  });
  // A prior request is a display estimate, never authority to block a new one.
  const fixedPromptTokens = measuredFixedTokens ?? (type === 'manual' ? runtime.fixedPromptTokensByChat.get(String(preparedChatId)) || 0 : 0);

  let memory;
  let plan;
  let pinnedTokens = 0;
  try {
    memory = settings.enabled ? await reconcileChatMemory(getChatMemory()) : getChatMemory();
    if (settings.enabled && !activeMemoryIsValid(getCurrentComparableChat(), memory)) {
      await reconcileChatMemory(memory, msg('Memory source changed; active blocks marked stale.'));
      memory = getChatMemory();
    }
    if (settings.enabled) {
      // A gap controls coverage; it is not evidence that later sources changed.
      memory = await refreshActiveBlockTokenCounts(memory, settings, coreChat);
    }
    const facts = renderPinnedFacts(memory.pinnedFacts);
    pinnedTokens = facts ? await countTextTokens(facts) : 0;

    const activeFrontier = settings.enabled ? getActiveFrontier(memory) : { blocks: [], coveredThrough: -1 };
    const rawMessages = getUncoveredMessages(coreChat, activeFrontier.blocks);
    const rawEntries = await countCoreChat(rawMessages);
    plan = buildCompactionPlan({
      contextBudget: contextSize,
      fixedPromptTokens: fixedPromptTokens + pinnedTokens,
      blocks: activeFrontier.blocks,
      rawEntries,
      settings,
      force: runtime.forceCompaction,
    });
    if (!settings.enabled) {
      plan = { ...plan, kind: plan.totalTokens > plan.usableBudget ? 'blocked' : 'none', reason: 'automatic-off' };
      if (plan.kind === 'blocked') plan.overflowTokens = plan.totalTokens - plan.usableBudget;
    }
    assertPinnedFactsCurrent(memory, preparedChatId);
  } catch (error) {
    runtime.forceCompaction = false;
    const message = msg`Memory preflight failed: ${error}`;
    setStatus('error', message);
    console.error(LOG_PREFIX, error);
    abort?.(true);
    return;
  }
  updateContextFromPlan(plan, contextSize, pinnedTokens);
  recordDiagnostic('plan', { requestId, phase: type, kind: plan.kind, reason: plan.reason, budget: contextSize, fixed: fixedPromptTokens, facts: pinnedTokens, memory: plan.blockTokens, raw: plan.rawTokens,
    blocks: getActiveFrontier(memory).blocks.map(block => ({ id: block.id, from: block.sourceFrom, to: block.sourceTo, level: block.level, useRaw: block.useRaw })),
    sourceIndices: plan.source?.map(entry => entry.index) || [], tailIndices: plan.tail?.map(entry => entry.index) || [], excluded });
  runtime.forceCompaction = false;
  updateStats(memory);

  if (plan.kind === 'blocked') {
    setStatus('error', describeContextBlock(plan, pinnedTokens));
    abort?.(true);
    return;
  }

  if (plan.kind === 'none' && type === 'manual') {
    const messages = {
      'below-trigger': 'Nothing to compact at the current trigger.',
      'no-cold-source': 'Nothing to compact while preserving the configured raw tail.',
      'source-too-small': msg`Cold source is smaller than the ${plan.effectiveMinimumSourceTokens}-token minimum.`,
      'no-space-for-summary': 'The current conversation fits; there is no space for an additional memory block.',
      'automatic-off': 'Automatic compaction is off.',
    };
    setStatus('idle', messages[plan.reason] || msg('Nothing to compact.'));
  }

  if (plan.kind !== 'none') {
    runtime.summarizing = true;
    runtime.cancelRequested = false;
    updateBlockActionBar();
    updateManualRollupControls();
    const chatId = getCurrentChatId();
    try {
      memory = await executePlanTransaction(plan, memory, chatId, contextSize, settings, pinnedTokens, preparedFingerprints, fixedPromptTokens, type === 'manual');
    } catch (error) {
      const errorText = error;
      if (runtime.cancelRequested) {
        setStatus('warning', msg('Compaction cancelled.'));
        abort?.(true);
        return;
      }
      if (getCurrentChatId() !== chatId) {
        setStatus('warning', msg`Compaction discarded after chat change: ${errorText}`);
        abort?.(true);
        return;
      }
      if (!fingerprintsStillMatch(preparedFingerprints)) {
        setStatus('warning', msg('Source messages changed during compaction. Start generation again.'));
        abort?.(true);
        return;
      }
      console.error(LOG_PREFIX, error);

      memory = getChatMemory();
      if (!activeMemoryIsValid(getCurrentComparableChat(), memory)) {
        await reconcileChatMemory(memory, msg`Compaction source changed: ${errorText}`);
        memory = getChatMemory();
      } else {
        setStatus('warning', errorText);
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
    memory = getChatMemory();
    if (settings.enabled) memory = await refreshActiveBlockTokenCounts(memory, settings, coreChat);
    const frontier = settings.enabled ? getActiveFrontier(memory) : { blocks: [], coveredThrough: -1 };
    const finalRaw = await countCoreChat(getUncoveredMessages(coreChat, frontier.blocks));
    const facts = renderPinnedFacts(memory.pinnedFacts);
    pinnedTokens = facts ? await countTextTokens(facts) : 0;
    assertPinnedFactsCurrent(memory, preparedChatId);
    if (!fingerprintsStillMatch(preparedFingerprints)) throw new LocalizedError(msg('Source messages changed during compaction. Start generation again.'));
    const fixedTokens = fixedPromptTokens + pinnedTokens;
    const currentPlan = buildCompactionPlan({
      contextBudget: contextSize, fixedPromptTokens: fixedTokens,
      blocks: frontier.blocks, rawEntries: finalRaw, settings,
    });
    updateContextFromPlan(currentPlan, contextSize, pinnedTokens);
    updateStats(memory);
    if (currentPlan.totalTokens > currentPlan.usableBudget) {
      const overflowTokens = currentPlan.totalTokens - currentPlan.usableBudget;
      setStatus('error', currentPlan.kind !== 'blocked' && runtime.lastStatus.kind === 'warning'
        ? msg`Context exceeds the budget by ${overflowTokens} tokens. ${runtime.lastStatus.text}`
        : describeContextBlock({ ...currentPlan, overflowTokens }, pinnedTokens));
      abort?.(true);
      return;
    }
    applyMemoryToCoreChat(coreChat, memory);
  } catch (error) {
    const message = msg`Memory rewrite failed: ${error}`;
    setStatus('error', message);
    console.error(LOG_PREFIX, error);
    abort?.(true);
    return;
  }
  if (type !== 'manual' && type !== 'prepared') {
    runtime.pendingPromptMeasurement = {
      chatId: String(getCurrentChatId()), budget: contextSize,
      requestId, excluded,
      source: originalSource, outgoing: withPromptRoles(coreChat), initialOutgoing: withPromptRoles(coreChat), fingerprints: preparedFingerprints,
      memorySnapshot: memoryPromptSnapshot(),
    };
  }
}

function describeContextBlock(plan, pinnedTokens) {
  const message = describeBlockedPlan({ ...plan, overflowTokens: Math.max(0, plan.totalTokens - plan.usableBudget) });
  return pinnedTokens >= plan.grossBudget ? msg`${message} Shorten pinned facts to free context.` : message;
}

function showContextUsage(usage) {
  runtime.contextUsage = usage;
  const meter = document.getElementById('smp-context-meter');
  if (!meter) return;
  for (const key of ['used', 'budget', 'memory', 'raw', 'facts', 'other', 'free', 'triggerRemaining']) meter.dataset[key] = String(usage[key]);
  meter.dataset.kind = usage.overflow ? 'overflow' : usage.triggerRemaining ? 'normal' : 'trigger';
  meter.innerHTML = renderContextUsage(usage);
}

function updateContextFromPlan(plan, budget, facts) {
  ++runtime.contextRevision;
  const chatId = String(getCurrentChatId());
  showContextUsage(getContextUsage({
    budget, memory: plan.summaryTierTokens,
    raw: plan.rawTokens + plan.blockTokens - plan.summaryTierTokens,
    facts, other: runtime.fixedPromptTokensByChat.get(chatId) || 0,
    otherKnown: runtime.fixedPromptTokensByChat.has(chatId),
    triggerRatio: getSettings().triggerRatio, automatic: getSettings().enabled,
  }));
}

function scheduleContextRefresh() {
  clearTimeout(runtime.contextRefreshTimer);
  const revision = ++runtime.contextRevision;
  runtime.contextRefreshTimer = setTimeout(() => {
    void refreshContextUsage(revision).catch(error => debug('Context estimate unavailable', error));
  }, 100);
  schedulePassivePromptRefresh();
}

function schedulePassivePromptRefresh() {
  clearTimeout(runtime.passivePromptTimer);
  if (!runtime.passivePromptDirty) return;
  runtime.passivePromptTimer = setTimeout(async () => {
    const context = getContext();
    if (runtime.liveGeneration || runtime.summarizing || runtime.queued || runtime.preparingPrompt || runtime.passivePromptInFlight
      || runtime.passivePromptMeasurement || is_send_press || is_group_generating
      || isExecutingCommandsFromChatInput || document.body.dataset.generating
      || getCurrentChatId() == null || !context.chat?.length) return;
    // Group dry runs select a member as a side effect. Let the host initiate them.
    if (context.groupId) return;
    // Native Generate writes macro expansion into chat[0], even in a dry run.
    // Let a foreground generation own that change instead of invalidating memory
    // from idle token measurement.
    if (/\{\{[\s\S]*?\}\}/.test(String(context.chat[0]?.mes || ''))) {
      recordDiagnostic('prompt-estimate-skipped', { phase: 'passive', reason: 'first-message-macros-have-native-side-effects', index: 0 });
      return;
    }
    runtime.passivePromptInFlight = true;
    const revision = runtime.overheadRevision;
    try {
      await context.generate('normal', {}, true);
    } catch (error) { debug('Context estimate unavailable', error); }
    finally {
      runtime.passivePromptInFlight = false;
      runtime.passivePromptMeasurement = null;
      if (revision !== runtime.overheadRevision) schedulePassivePromptRefresh();
    }
  }, 600);
}

function beginPromptMeasurement(type, options, dryRun) {
  runtime.passivePromptMeasurement = null;
  runtime.generationType = type;
  nativeContext.reset();
  if (!dryRun) return;
  if (runtime.liveGeneration || runtime.summarizing || type === 'quiet' || type === 'impersonate') return;
  runtime.passivePromptMeasurement = {
    chatId: getCurrentChatId(), revision: runtime.overheadRevision, api: main_api,
    requestId: nextDiagnosticRequest(),
    source: getCurrentComparableChat().map(message => ({ ...structuredClone(message), extra: { ...structuredClone(message.extra || {}), [Symbol.for('ignore')]: Boolean(message.extra?.[Symbol.for('ignore')]) } })),
  };
}

async function measurePassivePrompt(data, dryRun) {
  if (!dryRun) return;
  const snapshot = runtime.passivePromptMeasurement;
  runtime.passivePromptMeasurement = null;
  if (!snapshot || snapshot.chatId == null || runtime.liveGeneration || runtime.summarizing) return;
  const prompt = typeof data?.input === 'string' ? data.input : data?.prompt;
  if (snapshot.api === 'openai' ? !Array.isArray(prompt) : typeof prompt !== 'string') return;
  const preparedHistory = nativeContext.snapshot();
  // Dry runs omit extension interceptors. Subtract only raw text actually present
  // in the native prompt; clipped history must not become fixed prompt overhead.
  const processed = await prepareStoredHistory(snapshot.source);
  const chatMode = snapshot.api === 'openai';
  const formatted = withPromptRoles(processed, preparedHistory);
  const source = chatMode ? resolveChatConversation(prompt, formatted) : formatted;
  const matches = chatMode ? locateChatConversation(prompt, source) : locateTextConversation(prompt, source);
  const native = chatMode ? promptManager?.messages?.flatten?.() || [] : [];
  const total = chatMode ? await countChatPrompt(prompt, countTokensOpenAIAsync, native) : await countTextTokens(prompt);
  const included = await Promise.all([...matches.keys()].map(index => countTextTokens(source[index].promptText ?? source[index].mes)));
  const inspection = chatMode ? await inspectChatPrompt(prompt, source, getChatMemory().blocks, native, value => countChatPrompt(value, countTokensOpenAIAsync, native), countTextTokens) : inspectConversation(prompt, source, getChatMemory().blocks, true);
  if (snapshot.chatId !== getCurrentChatId() || snapshot.revision !== runtime.overheadRevision
    || snapshot.api !== main_api || runtime.liveGeneration || runtime.summarizing
    || snapshot.source.length !== getCurrentComparableChat().length
    || !fingerprintsStillMatch(snapshot.source.map(fingerprintMessage))) {
    if (runtime.passivePromptDirty) schedulePassivePromptRefresh();
    return;
  }
  if (getSettings().debug) {
    recordDiagnostic('text-trace', { requestId: snapshot.requestId, phase: 'passive',
      fromStage: 'stored-history', toStage: 'prompt-processing', messages: traceIndexedText(snapshot.source, processed) });
    if (chatMode) tracePromptText(snapshot.requestId, 'passive', processed, source, preparedHistory, native, prompt);
  }
  const unverified = chatMode ? unverifiedChatHistory(prompt, source) : [];
  if (unverified.length) {
    runtime.fixedPromptTokensByChat.delete(String(snapshot.chatId));
    runtime.preparedHistoryByChat.delete(String(snapshot.chatId));
    runtime.passivePromptDirty = false;
    recordDiagnostic('prompt-estimate-rejected', { requestId: snapshot.requestId, phase: 'passive',
      environment: diagnosticEnvironment(), messages: unverified });
    scheduleContextRefresh();
    return;
  }
  const fixed = Math.max(0, total - included.reduce((sum, value) => sum + value, 0));
  runtime.preparedHistoryByChat.set(String(snapshot.chatId), new Map(source.map(message => [message.index, {
    hash: fingerprintMessage(snapshot.source.find(item => item.index === message.index)).hash, promptText: message.promptText ?? message.formatted ?? message.mes,
  }])));
  runtime.fixedPromptTokensByChat.set(String(snapshot.chatId), fixed);
  runtime.contextBudgetsByChat.set(String(snapshot.chatId), getMaxPromptTokens());
  runtime.passivePromptDirty = false;
  recordDiagnostic('prompt-estimate', { requestId: snapshot.requestId, phase: 'passive', mode: chatMode ? 'chat' : 'text', total, fixed, included: matches.size, expected: source.length,
    environment: diagnosticEnvironment(), ...inspection, matches: undefined,
    excluded: snapshot.source.filter(message => message.extra?.[Symbol.for('ignore')]).map(message => ({ index: message.index, reason: 'hidden-by-tavern' })) });
  scheduleContextRefresh();
}

async function prepareStoredHistory(source) {
  return Promise.all(source.filter(message => !message.extra?.[Symbol.for('ignore')]).map(async message => {
    const placement = message.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
    const text = getRegexedString(message.mes, placement, { isPrompt: true, depth: source.length - message.index - 1 });
    const mes = await appendFileContent(message, text);
    const titles = [message.extra?.append_title && message.extra?.title,
      ...(message.extra?.media || []).filter(media => media.append_title).map(media => media.title)].filter(Boolean);
    return { ...message, mes: titles.length ? `${mes}\n\n${titles.join('\n\n')}` : mes };
  }));
}

async function refreshContextUsage(revision) {
  const chatId = getCurrentChatId();
  const meter = document.getElementById('smp-context-meter');
  if (!meter) return;
  const chat = getCurrentComparableChat().filter(message => !message.extra?.[Symbol.for('ignore')]);
  if (chatId == null || !chat.length) {
    runtime.contextUsage = null;
    meter.textContent = translate('Open a chat to measure context.');
    for (const key of Object.keys(meter.dataset)) delete meter.dataset[key];
    return;
  }
  const settings = getSettings();
  const memory = getChatMemory();
  const valid = settings.enabled && activeMemoryIsValid(chat, memory);
  const messages = valid ? rewriteConversationWithMemory(chat, memory, text => makeSyntheticMemoryMessage(text, settings), settings.includeStructuredMemory).messages : chat;
  const preparedHistory = runtime.preparedHistoryByChat.get(String(chatId));
  const counted = await countCoreChat(messages.map(message => {
    const prepared = !isSynthetic(message) && preparedHistory?.get(message.index);
    return prepared?.hash === fingerprintMessage(message).hash ? { ...message, promptText: prepared.promptText } : message;
  }));
  const factsText = renderPinnedFacts(memory.pinnedFacts);
  const facts = factsText ? await countTextTokens(factsText) : 0;
  // Measurements from a previous chat or an earlier refresh cannot update the UI.
  if (revision !== runtime.contextRevision || chatId !== getCurrentChatId()) return;
  const key = String(chatId);
  showContextUsage(getContextUsage({
    budget: runtime.contextBudgetsByChat.get(key) || getMaxPromptTokens(),
    memory: sumTokens(counted.filter(entry => entry.message.extra?.sillyMemoriesPlus)),
    raw: sumTokens(counted.filter(entry => !entry.message.extra?.sillyMemoriesPlus)),
    facts, other: runtime.fixedPromptTokensByChat.get(key) || 0,
    otherKnown: runtime.fixedPromptTokensByChat.has(key),
    triggerRatio: settings.triggerRatio, automatic: settings.enabled,
  }));
}

function updateStats(memory = getChatMemory()) {
  scheduleContextRefresh();
  const active = getActiveBlocks(memory);
  const activeTokens = active.reduce(
    (total, block) => total + Math.max(0, Number(block.useRaw ? (block.rawTokens ?? block.sourceTokens) : block.summaryTokens) || 0),
    0,
  );
  const stats = document.getElementById('smp-stats');
  if (!stats) return;
  const exposedRaw = active.filter(block => block.useRaw).length;
  stats.textContent = t`Active blocks: ${active.length} (${activeTokens}t) · Using original history: ${exposedRaw}`;
}

function renderLibrary() {
  const container = document.getElementById('smp-library');
  if (!container) return;
  const sameChat = runtime.libraryChatId === getCurrentChatId();
  const openIds = new Set(sameChat ? [...container.querySelectorAll('.smp-block[open]')].map(card => card.dataset.blockId) : []);
  const editingId = runtime.editingBlockId;
  const drafts = sameChat ? [...container.querySelectorAll('.smp-inline-editor:not([hidden]) [data-field]')].map(input => ({ field: input.dataset.field, value: input.value })) : [];
  runtime.libraryChatId = getCurrentChatId();
  const memory = getChatMemory();
  syncPinnedFactsEditor();
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
    container.innerHTML = `<div class="smp-empty">${translate(runtime.libraryTab === 'active' ? 'No active memory blocks.' : 'No archived memory blocks.')}</div>`;
    updateBlockActionBar(memory);
    updateManualRollupControls(memory);
    updateStats(memory);
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
  for (const card of container.querySelectorAll('.smp-block')) if (openIds.has(card.dataset.blockId)) card.open = true;
  if (editingId === runtime.editingBlockId) for (const draft of drafts) {
    const input = container.querySelector('.smp-inline-editor:not([hidden])')?.querySelector(`[data-field="${draft.field}"]`);
    if (input) input.value = draft.value;
  }
  updateBlockActionBar(memory);
  updateManualRollupControls(memory);
  updateStats(memory);
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
  select.replaceChildren(new Option(translate('Current main API'), ''));
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
  setStatus('working', msg('Testing summarizer with synthetic continuity data.'));
  try {
    const prompt = formatRawSources([
      { message: { index: 0, is_user: true, name: 'Mira', mes: 'Mira gives Rowan the brass observatory key and asks him to guard it until dawn.' } },
      { message: { index: 1, is_user: false, name: 'Rowan', mes: 'Rowan accepts, puts the key in his inner coat pocket, and promises to meet Mira at the north gate. Their trust improves, but the missing map remains unresolved.' } },
    ]);
    const text = await requestSummary(prompt, 512, 1, 'raw');
    const structured = parseStructuredSummary(text);
    const tokens = await countTextTokens(JSON.stringify(structured));
    setStatus('success', msg`Summarizer test passed (${tokens}t): ${structured.narrative.slice(0, 140)}`);
    return structured;
  } catch (error) {
    const message = error;
    setStatus('error', msg`Summarizer test failed: ${message}`);
    throw error;
  } finally {
    endMemoryJob();
  }
}

async function renderSettings() {
  if (document.getElementById('smp-settings')) return;
  if (runtime.renderPromise) return runtime.renderPromise;
  runtime.renderPromise = (async () => {
    await initializeI18n(getCurrentLocale(), nativeTranslate);
    setLanguage(getSettings().language);
    const container = document.getElementById('extensions_settings2');
    if (!container) return;
    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    if (!document.getElementById('smp-settings')) container.insertAdjacentHTML('beforeend', html);
    applyTranslations(document.getElementById('smp-settings'));

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
    const language = document.getElementById('smp-language');
    language.value = getSettings().language;
    language.addEventListener('change', () => {
      updateSettings(draft => { draft.language = language.value; });
      refreshLanguage();
    });
    bindPromptInputs();
    populateProfiles();
    document.getElementById('smp-pinned-facts')?.addEventListener('input', updatePinnedFactsControls);
    document.getElementById('smp-save-facts')?.addEventListener('click', () => {
      const chatId = getCurrentChatId();
      void savePinnedFacts().catch(error => {
        if (getCurrentChatId() === chatId) setStatus('error', error);
        console.error(LOG_PREFIX, error);
      });
    });

    for (const submenu of document.querySelectorAll('#smp-settings .smp-submenu')) {
      submenu.addEventListener('toggle', () => {
        if (!submenu.open) return;
        for (const sibling of document.querySelectorAll('#smp-settings .smp-submenu')) {
          if (sibling !== submenu) sibling.removeAttribute('open');
        }
      });
    }

    document.getElementById('smp-compact-now')?.addEventListener('click', async () => {
      if (runtime.summarizing || runtime.queued) return;
      const comparableChat = getCurrentComparableChat();
      if (!comparableChat.length) { setStatus('idle', msg('Nothing to compact.')); return; }
      runtime.forceCompaction = true;
      setStatus('working', msg('Starting forced compaction.'));
      try {
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
      setStatus('warning', msg('Compaction cancellation requested.'));
    });
    document.getElementById('smp-clear')?.addEventListener('click', async () => {
      if (!confirm(t('Clear summaries and pinned facts for this chat?'))) return;
      runtime.selectedBlockId = null;
      runtime.manualRollupIds.clear();
      closeBlockEditor();
      await setChatMemory(createEmptyMemory());
      syncPinnedFactsEditor(true);
      setStatus('idle', msg('Current chat memory cleared.'));
    });
    document.getElementById('smp-reset-prompts')?.addEventListener('click', () => {
      if (!confirm(t('Restore all three built-in summary prompts?'))) return;
      updateSettings(draft => { draft.prompts = { ...DEFAULT_PROMPTS }; });
      updatePromptFields();
      setStatus('success', msg('Default summary prompts restored.'));
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
            setStatus('error', error);
            console.error(LOG_PREFIX, error);
          });
        }
        if (actionName === 'delete') {
          void deleteSelectedMemoryBlock(blockId).catch(error => {
            setStatus('error', error);
            console.error(LOG_PREFIX, error);
          });
        }
        if (actionName === 'toggle-raw') {
          void toggleBlockRawSource(blockId).catch(error => {
            setStatus('error', error);
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
        const message = error;
        if (runtime.regenerationBlockId && displayText(runtime.lastStatus.text) !== displayText(message)) setStatus('error', message);
        console.error(LOG_PREFIX, error);
      });
    });
    document.getElementById('smp-save-preview')?.addEventListener('click', () => {
      void saveRegenerationPreview().catch(error => {
        runtime.regenerationPreview = null;
        setStatus('error', error);
        console.error(LOG_PREFIX, error);
      });
    });
    for (const id of ['smp-discard-preview', 'smp-close-regeneration']) {
      document.getElementById(id)?.addEventListener('click', () => {
        if (runtime.summarizing) return;
        closeRegeneration();
        setStatus('idle', msg('Ready.'));
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
        setStatus('error', error);
        console.error(LOG_PREFIX, error);
      });
    });
    document.getElementById('smp-export-block')?.addEventListener('click', exportSelectedBlock);
    document.getElementById('smp-refresh')?.addEventListener('click', () => { clearCurrentOverheadEstimate(); renderLibrary(); });
    document.getElementById('smp-export')?.addEventListener('click', exportCurrentMemory);
    document.getElementById('smp-download-logs')?.addEventListener('click', () => {
      recordDiagnostic('export');
      downloadJson(exportDiagnostics(getSettings(), runtime.contextUsage), `silly-memories-plus-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    });
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

function refreshLanguage() {
  setLanguage(getSettings().language);
  const root = document.getElementById('smp-settings');
  // Rebuild translated chrome while preserving open cards and unsaved editor values.
  const openIds = new Set([...root.querySelectorAll('.smp-block[open]')].map(card => card.dataset.blockId));
  const drafts = [...root.querySelectorAll('.smp-inline-editor:not([hidden]) [data-field]')]
    .map(input => ({ field: input.dataset.field, value: input.value }));
  applyTranslations(root);
  populateProfiles();
  renderLibrary();
  for (const card of root.querySelectorAll('.smp-block')) card.open = openIds.has(card.dataset.blockId);
  for (const draft of drafts) {
    const input = root.querySelector(`.smp-inline-editor:not([hidden]) [data-field="${draft.field}"]`);
    if (input) input.value = draft.value;
  }
  const preview = runtime.regenerationPreview;
  if (preview) {
    document.getElementById('smp-regeneration-comparison').innerHTML = renderRegenerationComparison(
      getBlockById(getChatMemory(), preview.blockId), getBlockById(preview.memory, preview.blockId),
    );
  }
  if (runtime.contextUsage) showContextUsage(runtime.contextUsage);
  else document.getElementById('smp-context-meter').textContent = translate('Open a chat to measure context.');
  setStatus(runtime.lastStatus.kind, runtime.lastStatus.text);
}

async function onChatChanged() {
  ++runtime.overheadRevision;
  runtime.passivePromptDirty = true;
  recordDiagnostic('chat-changed');
  if (runtime.notice) globalThis.toastr?.remove(runtime.notice);
  runtime.notice = null;
  if (runtime.summarizing) {
    runtime.abortController?.abort();
    if (runtime.fallbackSummaryActive) void eventSource.emit(event_types.GENERATION_STOPPED);
  }
  ++runtime.contextRevision;
  const meter = document.getElementById('smp-context-meter');
  if (meter) {
    runtime.contextUsage = null;
    meter.textContent = translate('Measuring context…');
    for (const key of Object.keys(meter.dataset)) delete meter.dataset[key];
  }
  syncPinnedFactsEditor(true);
  runtime.forceCompaction = false;
  runtime.pendingPromptMeasurement = null;
  runtime.selectedBlockId = null;
  runtime.libraryTab = 'active';
  closeRegeneration();
  runtime.manualRollupIds.clear();
  closeBlockEditor();
  await reconcileChatMemory(getChatMemory());
  renderLibrary();
  setStatus('idle', msg('Ready for this chat.'));
}

function withPromptRoles(messages, preparedHistory = undefined) {
  if (main_api === 'openai') {
    return nativeContext.format(messages, message => setOpenAIMessages([message])[0], preparedHistory);
  }
  return messages.map(message => ({ ...message, promptRole: message.extra?.type === system_message_types.NARRATOR ? 'system' : message.is_user ? 'user' : 'assistant' }));
}

function formatTextMemory(message) {
  const context = getContext();
  const narrator = message.promptRole === 'system';
  if (context.powerUserSettings.instruct.enabled && main_api !== 'openai') {
    return formatInstructModeChat(message.name, message.mes, message.is_user, narrator, message.force_avatar, context.name1, context.name2);
  }
  return narrator ? `${message.mes}\n` : `${message.name}: ${message.mes}\n`;
}

function tracePromptText(requestId, phase, source, conversation, records, native, prompt) {
  if (!getSettings().debug) return;
  try {
    recordDiagnostic('text-trace', { requestId, phase,
      ...inspectChatTextTrace({ source, conversation, records, native, prompt,
        formatted: source.map(message => setOpenAIMessages([message])[0]),
        sourceStage: phase === 'passive' ? 'prompt-processing' : 'interceptor',
        finalStage: phase === 'passive' ? 'passive-prompt' : phase }) });
  } catch (error) {
    // Diagnostics cannot change validation or interrupt a model request.
    recordDiagnostic('text-trace-unavailable', { requestId, phase, code: error.name });
  }
}

async function prepareFinalPrompt(eventData, textMode = false, extraTokens = 0, nativeRequest = false, preparedHistory = undefined) {
  const pending = runtime.pendingPromptMeasurement;
  if (!pending || runtime.summarizing || eventData?.dryRun || pending.chatId !== String(getCurrentChatId())) return;
  // Every payload needs validation, including concurrent CFG/native variants.
  while (runtime.preparingPrompt) await runtime.preparingPrompt;
  if (runtime.pendingPromptMeasurement !== pending) return;
  const original = textMode ? eventData.prompt : eventData.chat;
  if (textMode ? typeof original !== 'string' : !Array.isArray(original)) return;
  // Native prompt-manager dry runs may happen while tokenization or compaction
  // awaits I/O. Keep this request's exact expansions through the transport guard.
  preparedHistory = pending.preparedHistory ?? preparedHistory ?? nativeContext.snapshot();
  pending.preparedHistory = preparedHistory;
  const locate = textMode ? locateTextConversation : locateChatConversation;
  const resolve = conversation => textMode ? conversation : resolveChatConversation(original, conversation);
  let previous = resolve(withPromptRoles(pending.outgoing, preparedHistory));
  let matches = locate(original, previous);
  // CFG and native builder variants can still carry the original frontier
  // after another variant has already completed a late compaction.
  const initial = resolve(withPromptRoles(pending.initialOutgoing, preparedHistory));
  const initialMatches = locate(original, initial);
  if (initialMatches.size > matches.size) { previous = initial; matches = initialMatches; }
  // Quiet generation uses the same event, but not the native chat builder.
  const native = !textMode && (pending.nativeMessages ?? promptManager?.messages?.flatten?.().filter(message => message.content || message.tool_calls));
  if (!matches.size && !nativeRequest && !(native && JSON.stringify(native.map(message => [message.role, message.content])) === JSON.stringify(original.map(message => [message.role, message.content])))) return;
  if (!textMode) pending.nativeMessages = native || [];
  const phase = nativeRequest ? 'transport-preflight' : 'assembled-prompt';
  let inspection = inspectConversation(original, previous, getChatMemory().blocks, textMode);
  let finishPreparation;
  runtime.preparingPrompt = new Promise(resolve => { finishPreparation = resolve; });
  try {
    if (pending.memorySnapshot !== memoryPromptSnapshot()) throw new LocalizedError(msg('Memory changed during context preparation. Start generation again.'));
    if (!fingerprintsStillMatch(pending.fingerprints)) throw new LocalizedError(msg('Source messages changed during compaction. Start generation again.'));
    if (JSON.stringify(pending.excluded) !== JSON.stringify(excludedSourceMessages())) throw new LocalizedError(msg('Source messages changed during compaction. Start generation again.'));
    if (!textMode) tracePromptText(pending.requestId, phase, pending.source, previous, preparedHistory, native || [], original);
    const count = textMode ? value => countTextTokens(value) : value => countChatPrompt(value, countTokensOpenAIAsync, native || []);
    const total = await count(original) + extraTokens;
    const included = await Promise.all([...matches.keys()].map(index => countTextTokens(previous[index].promptText ?? previous[index].mes)));
    if (runtime.pendingPromptMeasurement !== pending) return;
    const fixed = Math.max(0, total - included.reduce((a, b) => a + b, 0));
    runtime.fixedPromptTokensByChat.set(pending.chatId, fixed);
    const detail = textMode ? inspection : await inspectChatPrompt(original, previous, getChatMemory().blocks, native || [], count, countTextTokens);
    if (runtime.pendingPromptMeasurement !== pending) return;
    recordDiagnostic('prompt-measurement', { requestId: pending.requestId, phase, mode: textMode ? 'text' : 'chat', total, fixed, extraTokens, included: matches.size, expected: previous.length,
      environment: diagnosticEnvironment(), inventory: detail.inventory, missing: detail.missing, components: detail.components, excluded: pending.excluded });
    let desired = resolve(withPromptRoles(pending.outgoing, preparedHistory));
    const requiredTokens = (await countCoreChat(desired)).reduce((sum, entry) => sum + entry.tokens, 0);
    if (runtime.pendingPromptMeasurement !== pending) return;
    const missingRaw = missingHistory(desired, locate(original, desired));
    const unverified = textMode ? [] : unverifiedChatHistory(original, desired);
    if (unverified.length) {
      inspection.missing = inspection.missing.map(item => ({ ...item, reason: unverified.find(source => source.index === item.index)?.reason || item.reason }));
      recordDiagnostic('history-match-rejected', { requestId: pending.requestId, phase, messages: unverified });
      throw new LocalizedError(msg('Memory or recent history is missing from the prompt. Check the chat history marker and prompt settings.'));
    }
    if (pending.memorySnapshot !== memoryPromptSnapshot()) throw new LocalizedError(msg('Memory changed during context preparation. Start generation again.'));
    if (fixed + requiredTokens >= pending.budget * getSettings().triggerRatio || missingRaw.length) {
      // Plan and summarize the same expansions that are present in this request.
      // Stored fingerprints remain attached to the original chat, not this text.
      const source = resolve(withPromptRoles(pending.source, preparedHistory)).map(message => ({ ...message, mes: message.promptText ?? message.mes }));
      let aborted = false;
      runtime.forceCompaction = missingRaw.length > 0;
      await runInterceptor(source, pending.budget, () => { aborted = true; }, 'prepared', fixed);
      if (aborted) throw new LocalizedError(runtime.lastStatus.text);
      desired = resolve(withPromptRoles(source, preparedHistory));
      pending.memorySnapshot = memoryPromptSnapshot();
    }
    const present = locate(original, desired);
    const complete = !missingHistory(desired, present).length && desired.every((message, index) => !isSynthetic(message) || present.has(index));
    const same = desired.length === previous.length && desired.every((message, index) => message.mes === previous[index].mes && message.promptRole === previous[index].promptRole && message.index === previous[index].index);
    const result = same && complete ? original
      : textMode ? replaceTextMemory(original, previous, desired, formatTextMemory) : replaceChatMemory(original, previous, desired);
    matches = locate(result, desired);
    inspection = inspectConversation(result, desired, getChatMemory().blocks, textMode);
    if (missingHistory(desired, matches).length || desired.some((message, index) => isSynthetic(message) && !matches.has(index))) {
      throw new LocalizedError(msg('Memory or recent history is missing from the prompt. Check the chat history marker and prompt settings.'));
    }
    const actual = await count(result) + extraTokens;
    const finalInspection = textMode ? inspection : await inspectChatPrompt(result, desired, getChatMemory().blocks, native || [], count, countTextTokens);
    const counted = await countCoreChat(desired);
    if (runtime.pendingPromptMeasurement !== pending) return;
    if (pending.memorySnapshot !== memoryPromptSnapshot()) throw new LocalizedError(msg('Memory changed during context preparation. Start generation again.'));
    if (actual > pending.budget) throw new LocalizedError(msg`Context exceeds the budget by ${actual - pending.budget} tokens.`);
    if (pending.chatId !== String(getCurrentChatId()) || !fingerprintsStillMatch(pending.fingerprints)) throw new LocalizedError(msg('Source messages changed during compaction. Start generation again.'));
    if (JSON.stringify(pending.excluded) !== JSON.stringify(excludedSourceMessages())) throw new LocalizedError(msg('Source messages changed during compaction. Start generation again.'));
    if (textMode) eventData.prompt = result;
    else eventData.chat.splice(0, eventData.chat.length, ...result);
    runtime.preparedHistoryByChat.set(pending.chatId, new Map(desired.filter(message => !isSynthetic(message)).map(message => [message.index, {
      hash: pending.fingerprints.find(item => item.index === message.index)?.hash,
      promptText: message.promptText ?? message.formatted ?? message.mes,
    }])));
    pending.outgoing = desired;
    pending.prepared = true;
    pending.inspection = finalInspection;
    const finalFixed = Math.max(0, actual - sumTokens(counted));
    runtime.fixedPromptTokensByChat.set(pending.chatId, finalFixed);
    runtime.passivePromptDirty = false;
    ++runtime.contextRevision;
    showContextUsage(getContextUsage({ budget: pending.budget,
      memory: sumTokens(counted.filter(entry => isSynthetic(entry.message) && !entry.message.extra?.sillyMemoriesPlusPinnedFacts)),
      facts: sumTokens(counted.filter(entry => entry.message.extra?.sillyMemoriesPlusPinnedFacts)),
      raw: sumTokens(counted.filter(entry => !isSynthetic(entry.message))),
      other: finalFixed, otherKnown: true, triggerRatio: getSettings().triggerRatio, automatic: getSettings().enabled,
    }));
    recordDiagnostic('prompt-ready', { requestId: pending.requestId, phase, mode: textMode ? 'text' : 'chat', tokens: actual, budget: pending.budget, repaired: result !== original,
      inventory: pending.inspection.inventory, missing: pending.inspection.missing, components: pending.inspection.components, excluded: pending.excluded,
      memoryMessages: desired.filter(isSynthetic).length, rawMessages: desired.filter(message => !isSynthetic(message)).length });
  } catch (error) {
    if (runtime.pendingPromptMeasurement !== pending) return;
    setStatus('error', error);
    recordDiagnostic('prompt-blocked', { requestId: pending.requestId, phase, code: error.translationKey || error.name,
      values: error.diagnosticValues, budget: pending.budget, environment: diagnosticEnvironment(),
      inventory: inspection.inventory, missing: inspection.missing, excluded: pending.excluded });
    runtime.pendingPromptMeasurement = null;
    getContext().stopGeneration();
  } finally { runtime.preparingPrompt = null; finishPreparation(); schedulePassivePromptRefresh(); }
}

function captureTextFormatting(data) {
  if (runtime.summarizing || data?.api === 'openai' || !runtime.pendingPromptMeasurement) return;
  for (const message of [...runtime.pendingPromptMeasurement.outgoing, ...runtime.pendingPromptMeasurement.initialOutgoing]) {
    const formatted = data.finalMesSend?.find(item => !item.injected && item.message?.includes(message.mes))?.message;
    if (formatted) message.formatted = formatted;
  }
}

async function prepareChatSettings(payload) {
  const pending = runtime.pendingPromptMeasurement;
  if (!pending?.prepared || runtime.summarizing || !Array.isArray(payload.messages)) return;
  const extra = payload.tools?.length ? await countTextTokens(JSON.stringify(payload.tools)) : 0;
  await prepareFinalPrompt({ chat: payload.messages }, false, extra, true);
  if (runtime.pendingPromptMeasurement !== pending) return;
  recordDiagnostic('chat-request', { requestId: pending.requestId, phase: 'dispatch', delivery: 'handed-to-tavern',
    stream: payload.stream === true, messages: payload.messages.length, maxTokens: payload.max_tokens, tools: payload.tools?.length || 0, toolTokens: extra,
    provider: diagnosticName(payload.chat_completion_source), model: diagnosticName(payload.model), environment: diagnosticEnvironment(),
    inventory: pending.inspection.inventory, components: pending.inspection.components, excluded: pending.excluded });
}

async function prepareTextRequest(data, dryRun) {
  if (main_api === 'openai' || dryRun || runtime.summarizing) return;
  const field = typeof data?.prompt === 'string' ? 'prompt' : typeof data?.input === 'string' ? 'input' : null;
  if (!field) return;
  const event = { prompt: data[field] };
  const pending = runtime.pendingPromptMeasurement;
  await prepareFinalPrompt(event, true, 0, true);
  if (runtime.pendingPromptMeasurement !== pending) return;
  data[field] = event.prompt;
  if (pending?.prepared) recordDiagnostic('text-request', { requestId: pending.requestId, phase: 'dispatch', delivery: 'handed-to-tavern',
    chars: event.prompt.length, inventory: pending.inspection.inventory, environment: diagnosticEnvironment(), excluded: pending.excluded });
}

function prepareChatEvent(data) { return prepareFinalPrompt(data, false, 0, false, nativeContext.snapshot()); }

function clearCurrentOverheadEstimate() {
  ++runtime.overheadRevision;
  runtime.passivePromptDirty = true;
  runtime.fixedPromptTokensByChat.delete(String(getCurrentChatId()));
  runtime.preparedHistoryByChat.delete(String(getCurrentChatId()));
  runtime.contextBudgetsByChat.delete(String(getCurrentChatId()));
  if (runtime.contextUsage) showContextUsage(getContextUsage({ ...runtime.contextUsage, budget: getMaxPromptTokens(), other: 0, otherKnown: false }));
  scheduleContextRefresh();
}

async function validateAfterChatMutation(label) {
  clearCurrentOverheadEstimate();
  const memory = getChatMemory();
  const sourceChanged = !activeMemoryIsValid(getCurrentComparableChat(), memory);
  await reconcileChatMemory(memory, msg`${label}; active memory marked stale.`);
  if (!sourceChanged && getActiveBlocks(memory).length) {
    setStatus('idle', msg`${label}; active memory remains valid.`);
  }
}

const nativeContext = installNativeContextManagement({
  ChatCompletion, promptManager,
  isManaged: () => getSettings().enabled && main_api === 'openai'
    && !runtime.summarizing && !['quiet', 'impersonate'].includes(runtime.generationType),
});

globalThis[INTERCEPTOR_NAME] = runInterceptor;
getSettings();

eventSource.on(event_types.APP_READY, () => setTimeout(() => void renderSettings(), 0));
eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, prepareChatEvent);
eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, captureTextFormatting);
eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, data => {
  if (main_api !== 'openai') return prepareFinalPrompt(data, true);
});
eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, prepareChatSettings);
eventSource.on(event_types.GENERATE_AFTER_DATA, prepareTextRequest);
eventSource.on(event_types.GENERATE_AFTER_DATA, measurePassivePrompt);
eventSource.on(event_types.GENERATION_STARTED, beginPromptMeasurement);
eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, options, dryRun) => {
  if (!dryRun) runtime.liveGeneration = getContext().onlineStatus !== 'no_connection';
});
eventSource.on(event_types.GENERATION_STARTED, () => {
  // Validate after other extensions have contributed to this generation.
  eventSource.makeLast(event_types.CHAT_COMPLETION_PROMPT_READY, prepareChatEvent);
  eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, prepareChatSettings);
  eventSource.makeLast(event_types.GENERATE_AFTER_DATA, prepareTextRequest);
});
for (const event of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) eventSource.on(event, () => {
  runtime.pendingPromptMeasurement = null;
  runtime.liveGeneration = false;
  runtime.generationType = null;
  scheduleContextRefresh();
});
eventSource.on(event_types.PRESET_CHANGED, clearCurrentOverheadEstimate);
eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, clearCurrentOverheadEstimate);
eventSource.on(event_types.CHATCOMPLETION_MODEL_CHANGED, clearCurrentOverheadEstimate);
for (const event of [event_types.SETTINGS_UPDATED, event_types.WORLDINFO_UPDATED, event_types.WORLDINFO_SETTINGS_UPDATED, event_types.MAIN_API_CHANGED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.PERSONA_CHANGED, event_types.CHARACTER_EDITED]) eventSource.on(event, clearCurrentOverheadEstimate);
eventSource.on(event_types.MESSAGE_EDITED, () => void validateAfterChatMutation(msg('Message edited')));
eventSource.on(event_types.MESSAGE_UPDATED, () => void validateAfterChatMutation(msg('Message updated')));
eventSource.on(event_types.MESSAGE_SWIPED, () => void validateAfterChatMutation(msg('Swipe changed')));
eventSource.on(event_types.MESSAGE_DELETED, () => void validateAfterChatMutation(msg('Message deleted')));
eventSource.on(event_types.MESSAGE_SENT, clearCurrentOverheadEstimate);
eventSource.on(event_types.MESSAGE_RECEIVED, clearCurrentOverheadEstimate);

if (document.readyState !== 'loading') setTimeout(() => void renderSettings(), 0);
