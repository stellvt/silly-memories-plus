import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure cases defined before implementation: expanded source lost by late
// planning; hidden messages resurrected; gaps dropping active blocks; nested
// recovery stopping at L2; source edits invalidating unrelated blocks; inconsistent
// counters at padding=0; ambiguous missing-history errors; unclassified injections
// and transport fields; logs claiming preparation was dispatch; credential/text
// leaks; disabled mode and native token labels failing to restore; split/merge
// spanning raw gaps; changed sources during asynchronous work; SSE/schema leaks.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
const results = [];
// Full-disable failures: memory/facts leak, native clipping stays disabled, an
// oversized request is blocked by our guard, background builds continue, manual
// jobs run, late summary results are committed, or re-enabling loses saved data.
let failure;
try {
  await page.goto(process.env.SMP_BASE_URL || 'http://127.0.0.1:8001');
  await page.waitForFunction(() => typeof sillyMemoriesPlusGenerateInterceptor === 'function');
  await page.waitForSelector('#smp-settings', { state: 'attached' });
  await page.locator('#preloader').waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => {
    const { loader } = await import('/scripts/action-loader.js');
    return SillyTavern.getContext().characters.length > 0 && !loader.active().some(handle => handle.slug === 'app-init');
  });
  await page.evaluate(async () => {
    const script = await import('/script.js');
    const openai = await import('/scripts/openai.js');
    const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
    const identity = await import('/scripts/extensions/third-party/silly-memories-plus/lib/source-identity.mjs');
    const diagnostics = await import('/scripts/extensions/third-party/silly-memories-plus/lib/diagnostics.mjs');
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const c = SillyTavern.getContext();
    c.characters.push({ name: 'Mira', avatar: 'none', chat: 'ownership-test', description: '', data: { name: 'Mira', extensions: {} } });
    script.setCharacterId(c.characters.length - 1); script.setCharacterName('Mira'); script.changeMainAPI('openai');
    openai.promptManager.activeCharacter = { id: openai.promptManager.configuration.promptOrder.dummyId };
    const structured = narrative => ({ narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
    globalThis.co = { script, openai, core, identity, diagnostics, c, service, structured, calls: [], requests: [], stops: 0, serial: 0 };
    service.getProfile = () => ({ id: 'ownership-test' });
    service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (_, messages, maxTokens, options, payload) => {
      co.calls.push({ messages, maxTokens, effort: payload.reasoning_effort });
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'Saved scene', ...structured('SAVED-SCENE: Mira recovered the key.') }) } }] };
    };
    script.eventSource.on(script.event_types.GENERATION_STOPPED, () => co.stops++);
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (!String(url).includes('/api/backends/chat-completions/generate')) return nativeFetch.call(globalThis, url, options);
      options.signal?.throwIfAborted();
      co.requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Reply.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    co.reset = async (texts, blocks = [], budget = 8000) => {
      script.activateSendButtons();
      await script.eventSource.emit(script.event_types.GENERATION_ENDED);
      c.characters.at(-1).chat = `ownership-${++co.serial}`;
      c.chat.splice(0, c.chat.length, ...texts.map((mes, index) => ({ name: index % 2 ? 'User' : 'Mira', mes, is_user: index % 2 === 1, extra: {}, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }] })));
      c.chatMetadata.silly_memories_plus = { schemaVersion: 3, blocks };
      c.chatMetadata.variables = {};
      c.extensionSettings.silly_memories_plus = core.normalizeSettings({ messageValidation: 'content', summaryProfileId: 'ownership-test', blockTargetTokens: 256, minimumSourceTokens: 512, summaryInputBudgetTokens: 50000 });
      Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', openai_max_context: budget + 512, openai_max_tokens: 512, stream_openai: false, squash_system_messages: false, names_behavior: 0, reasoning_effort: 'medium' });
      c.powerUserSettings.token_padding = 64;
      co.calls = []; co.requests = []; co.stops = 0;
      await script.eventSource.emit(script.event_types.CHAT_CHANGED);
    };
    co.block = (id, from, to, level = 1, status = 'active', children = []) => {
      const fingerprints = c.chat.slice(from, to + 1).map((message, offset) => identity.fingerprintMessage({ ...message, index: from + offset }));
      return { id, level, status, children, structured: structured(`MEMORY-${id}`), sourceFrom: from, sourceTo: to, sourceFingerprints: fingerprints, sourceHash: identity.buildSourceHash(fingerprints), sourceTokens: 1000, summaryTokens: 100, createdAt: 1 };
    };
    co.build = async (budget = 8000) => {
      // This calls the native builder directly, outside Generate's foreground
      // lifecycle. Keep idle dry runs out until this request has finished.
      document.body.dataset.generating = 'context-ownership-audit';
      try {
        script.setExternalAbortController(new AbortController());
        await script.eventSource.emit(script.event_types.GENERATION_STARTED, 'normal', {}, false);
        const outgoing = c.chat.map((message, index) => ({ ...message, index, extra: { ...message.extra } }));
        let aborted = false;
        await sillyMemoriesPlusGenerateInterceptor(outgoing, budget, () => { aborted = true; }, 'normal');
        if (aborted) return { aborted, chat: [] };
        const [chat] = await openai.prepareOpenAIMessages({ name2: 'Mira', charDescription: 'PRIVATE-PRESET An archivist.', charPersonality: '', scenario: '', worldInfoBefore: 'PRIVATE-LORE The observatory is locked.', worldInfoAfter: '', bias: '', type: 'normal', quietPrompt: '', extensionPrompts: {}, cyclePrompt: '', systemPromptOverride: '', jailbreakPromptOverride: '', messages: openai.setOpenAIMessages(outgoing), messageExamples: [] }, false);
        return { aborted, chat };
      } finally { delete document.body.dataset.generating; }
    };
    const root = document.getElementById('smp-settings');
    document.body.append(root);
    root.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:430px;max-height:100vh;overflow:auto;background:#202225;z-index:99999';
    root.querySelector('.inline-drawer-content').style.display = 'block';
  });
  async function check(name, passed, details) { results.push({ name, passed: Boolean(passed), details }); }
  const macro = await page.evaluate(async () => {
    await co.reset(['{{getvar::ownership_expansion}}', ' recent'.repeat(100), ' latest'.repeat(100)], [], 1800);
    co.c.chatMetadata.variables.ownership_expansion = ' expanded-scene'.repeat(1800);
    const before = co.c.chat.map((message, index) => co.identity.fingerprintMessage({ ...message, index }));
    const result = await co.build(1800);
    return { aborted: result.aborted, stops: co.stops, calls: co.calls.length, memory: JSON.stringify(result.chat).includes('memory_block'), sourceExpanded: co.calls.some(call => call.messages[1].content.includes('expanded-scene')), active: co.c.chatMetadata.silly_memories_plus.blocks.filter(block => block.status === 'active').length,
      before, after: co.c.chat.map((message, index) => co.identity.fingerprintMessage({ ...message, index })) };
  });
  await check('late-planner-summarizes-exact-expanded-history', !macro.aborted && !macro.stops && macro.calls > 0 && macro.memory && macro.sourceExpanded, macro);
  const gaps = await page.evaluate(async () => {
    await co.reset(Array.from({ length: 7 }, (_, index) => `PRIVATE-RAW-${index}`));
    co.c.chatMetadata.silly_memories_plus.blocks = [co.block('later', 3, 4)];
    const result = await co.build();
    const body = JSON.stringify(result.chat);
    await co.script.sendGenerationRequest('normal', { prompt: result.chat });
    return { stops: co.stops, requests: co.requests.length, memory: body.includes('MEMORY-later'), raw: [0, 1, 2, 5, 6].every(index => body.includes(`PRIVATE-RAW-${index}`)), coveredExcluded: !body.includes('PRIVATE-RAW-3') && !body.includes('PRIVATE-RAW-4'), wireMatches: JSON.stringify(co.requests.at(-1)?.messages) === JSON.stringify(result.chat) };
  });
  await check('active-block-after-gap-reaches-actual-request', !gaps.stops && gaps.requests === 1 && gaps.memory && gaps.raw && gaps.coveredExcluded && gaps.wireMatches, gaps);
  const nested = await page.evaluate(async () => {
    await co.reset(['Original 0', 'Original 1', 'Original 2', 'Original 3', 'Recent']);
    co.c.chatMetadata.silly_memories_plus.blocks = [co.block('a', 0, 0, 1, 'retired'), co.block('b', 1, 1, 1, 'retired'), co.block('c', 2, 2, 1, 'retired'), co.block('d', 3, 3, 1, 'retired'), co.block('ab', 0, 1, 2, 'retired', ['a', 'b']), co.block('cd', 2, 3, 2, 'retired', ['c', 'd']), co.block('abcd', 0, 3, 3, 'active', ['ab', 'cd'])];
    co.c.chat[0].mes = 'Actually edited';
    await co.script.eventSource.emit(co.script.event_types.CHAT_CHANGED);
    const result = await co.build();
    const blocks = co.c.chatMetadata.silly_memories_plus.blocks;
    return { active: blocks.filter(block => block.status === 'active').map(block => block.id).sort(), body: JSON.stringify(result.chat), stops: co.stops };
  });
  await check('nested-recovery-descends-to-valid-L1-and-keeps-L2', !nested.stops && JSON.stringify(nested.active) === '["b","cd"]' && nested.body.includes('MEMORY-b') && nested.body.includes('MEMORY-cd') && nested.body.includes('Actually edited'), { active: nested.active, stops: nested.stops });
  const hidden = await page.evaluate(async () => {
    await co.reset(['PRIVATE-HIDDEN', 'Visible user', 'Visible answer']);
    co.c.chat[0].extra[Symbol.for('ignore')] = true;
    const result = await co.build();
    return { stops: co.stops, hiddenLeaked: JSON.stringify(result.chat).includes('PRIVATE-HIDDEN'), visible: JSON.stringify(result.chat).includes('Visible user') };
  });
  await check('deliberately-excluded-message-is-not-required-or-resurrected', !hidden.stops && !hidden.hiddenLeaked && hidden.visible, hidden);
  const hiddenBlock = await page.evaluate(async () => {
    await co.reset(['PRIVATE-HIDDEN-SOURCE', 'Visible', 'Latest']);
    co.c.chatMetadata.silly_memories_plus.blocks = [co.block('hidden-source', 0, 0)];
    co.c.chat[0].extra[Symbol.for('ignore')] = true;
    const result = await co.build();
    const block = co.c.chatMetadata.silly_memories_plus.blocks[0];
    return { status: block.status, reason: block.staleReason, leaked: JSON.stringify(result.chat).includes('MEMORY-hidden-source'), stops: co.stops };
  });
  await check('summary-of-excluded-source-is-not-sent', !hiddenBlock.stops && !hiddenBlock.leaked && hiddenBlock.status === 'stale' && hiddenBlock.reason === 'source-hidden', hiddenBlock);
  const runs = await page.evaluate(async () => {
    await co.reset([' cold-first'.repeat(1000), 'Covered', ' cold-second'.repeat(1000), ' recent'.repeat(70), ' latest'.repeat(70)], [], 2500);
    co.c.chatMetadata.silly_memories_plus.blocks = [co.block('middle', 1, 1)];
    const result = await co.build(2500);
    return { stops: co.stops, calls: co.calls.length, active: co.c.chatMetadata.silly_memories_plus.blocks.filter(block => block.status === 'active').map(block => ({ id: block.id, from: block.sourceFrom, to: block.sourceTo })), hasMiddle: JSON.stringify(result.chat).includes('MEMORY-middle') };
  });
  await check('compaction-stages-disjoint-raw-runs-without-covering-gap', !runs.stops && runs.calls >= 2 && runs.hasMiddle && runs.active.every(block => block.id === 'middle' || block.from === block.to), runs);
  const padding = await page.evaluate(async () => {
    await co.reset(['Старинная обсерватория. '.repeat(90), ' recent'.repeat(100), 'Latest']);
    await co.build();
    const before = { ...document.getElementById('smp-context-meter').dataset };
    co.c.powerUserSettings.token_padding = 0;
    await co.build();
    const after = { ...document.getElementById('smp-context-meter').dataset };
    return { before: Number(before.other), after: Number(after.other), rawBefore: Number(before.raw), rawAfter: Number(after.raw), stops: co.stops };
  });
  await check('zero-padding-does-not-change-tokenizer-or-fixed-cost', !padding.stops && padding.before === padding.after && padding.rawBefore === padding.rawAfter, padding);
  const invalidation = await page.evaluate(async () => {
    await co.reset(['Source A', 'Source B', 'Recent']);
    co.c.chatMetadata.silly_memories_plus.blocks = [co.block('independent-a', 0, 0), co.block('independent-b', 1, 1)];
    co.c.chat[0].mes = 'Source A changed';
    await co.script.eventSource.emit(co.script.event_types.CHAT_CHANGED);
    await co.build();
    return co.c.chatMetadata.silly_memories_plus.blocks.map(({ id, status }) => ({ id, status }));
  });
  await check('source-edit-only-invalidates-own-block', invalidation[0].status === 'stale' && invalidation[1].status === 'active', invalidation);
  const metadata = await page.evaluate(async () => {
    await co.reset(['First', 'Second', 'Latest'], [], 16000);
    co.script.setExtensionPrompt('ownership-injection', 'PRIVATE-INJECTION', 1, 1, false, 0);
    const result = await co.build(16000);
    co.script.setExtensionPrompt('ownership-injection', '', 1, 1, false, 0);
    const latest = result.chat.at(-1);
    latest.signature = 'PRIVATE-SIGNATURE-' + 'abc123'.repeat(100);
    latest.content = [{ type: 'text', text: latest.content }, { type: 'image_url', image_url: { url: 'https://PRIVATE-IMAGE.invalid/test.png', detail: 'low' } }];
    await co.script.eventSource.emit(co.script.event_types.CHAT_COMPLETION_PROMPT_READY, { chat: result.chat, dryRun: false });
    await co.script.sendGenerationRequest('normal', { prompt: result.chat });
    return { stops: co.stops, injection: JSON.stringify(result.chat).includes('PRIVATE-INJECTION') };
  });
  await check('in-chat-injection-and-media-survive-preflight', !metadata.stops && metadata.injection, metadata);
  const changed = await page.evaluate(async () => {
    await co.reset(['Original cold text', 'Recent', 'Latest']);
    const result = await co.build();
    co.c.chat[1].mes = 'Edited during preparation';
    await co.script.eventSource.emit(co.script.event_types.CHAT_COMPLETION_PROMPT_READY, { chat: result.chat, dryRun: false });
    const events = co.diagnostics.exportDiagnostics(co.c.extensionSettings.silly_memories_plus, null).events;
    const failure = events.filter(event => event.type === 'source-check-failed').at(-1);
    return { failure, blocked: events.some(event => event.type === 'prompt-blocked' && event.requestId === failure?.requestId),
      dispatched: events.some(event => event.type === 'chat-request' && event.requestId === failure?.requestId) };
  });
  await check('changed-source-guard-logs-exact-index-and-hashes', changed.blocked && !changed.dispatched && changed.failure?.missing?.some(item => item.index === 1 && item.reason === 'content-changed' && item.expectedHash !== item.actualHash), changed);
  await page.evaluate(async () => {
    await co.reset(['First', 'Second', 'PRIVATE-MISSING-TAIL']);
    const result = await co.build();
    result.chat.at(-1).content = 'Different late content';
    await co.script.eventSource.emit(co.script.event_types.CHAT_COMPLETION_PROMPT_READY, { chat: result.chat, dryRun: false });
    document.querySelector('[data-section="debug"]').open = true;
  });
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#smp-download-logs').evaluate(button => button.click())]);
  const logPath = resolve(directory, 'diagnostics.json');
  await download.saveAs(logPath);
  const logText = await readFile(logPath, 'utf8');
  const logs = JSON.parse(logText);
  const blocked = logs.events.filter(event => event.type === 'prompt-blocked').at(-1);
  await check('missing-log-identifies-index-role-phase-and-reason', blocked?.requestId && blocked.missing?.some(item => item.index === 2 && item.role === 'assistant' && item.reason), blocked);
  const reconciled = logs.events.filter(event => event.type === 'memory-reconciled');
  await check('invalidation-log-identifies-block-range-and-source-change', reconciled.some(event => event.blocks?.some(block => block.id === 'independent-a' && block.from === 0 && block.to === 0 && block.reason === 'content-changed' && block.source?.index === 0)), reconciled.map(event => event.blocks));
  const request = logs.events.find(event => event.type === 'chat-request');
  await check('actual-request-log-lists-history-memory-and-token-components', request?.requestId && request.inventory?.some(item => item.kind === 'memory' && item.blockIds?.includes('later')) && request.inventory?.some(item => item.kind === 'history' && item.index === 0) && request.components?.length > 0, request);
  await check('logs-separate-preparation-from-dispatch', blocked?.requestId && !logs.events.some(event => event.type === 'chat-request' && event.requestId === blocked.requestId));
  await check('logs-identify-injection-and-transport-costs-without-content', logs.events.some(event => event.type === 'chat-request' && event.components?.some(item => item.source === 'unmatched-chat-history')) && logs.events.some(event => event.components?.some(item => item.fields?.some(field => field.field === 'signature' && field.chars > 0 && field.tokens > 0) && item.mediaParts?.some(part => part.type === 'image_url'))));
  await check('logs-contain-no-chat-prompt-or-credential-text', !/PRIVATE-|ownership-test|expanded-scene|Actually edited|SAVED-SCENE/.test(logText));
  const labels = await page.evaluate(async () => {
    const manager = co.openai.promptManager;
    await manager.renderPromptManager(); await manager.renderPromptManagerListItems();
    const active = manager.containerElement.querySelector('[data-pm-identifier="chatHistory"] .prompt_manager_prompt_tokens')?.textContent;
    const header = manager.containerElement.querySelector('.completion_prompt_manager_header')?.lastElementChild.textContent;
    const nativeCount = manager.containerElement.querySelector('[data-pm-identifier="chatHistory"] .prompt_manager_prompt_tokens')?.dataset.pmTokens;
    co.c.extensionSettings.silly_memories_plus.enabled = false;
    await manager.renderPromptManager(); await manager.renderPromptManagerListItems();
    const disabled = manager.containerElement.querySelector('[data-pm-identifier="chatHistory"] .prompt_manager_prompt_tokens')?.textContent;
    co.c.extensionSettings.silly_memories_plus.enabled = true;
    await manager.renderPromptManager(); await manager.renderPromptManagerListItems();
    document.body.append(manager.containerElement);
    manager.containerElement.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:320px;background:#202225;z-index:100000';
    const counter = manager.containerElement.querySelector('[data-pm-identifier="chatHistory"] .prompt_manager_prompt_tokens');
    return { active, disabled, header, nativeCount, overflow: counter.scrollWidth > counter.clientWidth + 1 };
  });
  await check('manager-label-is-header-only-with-native-history-counter', labels.header === 'Silly' && labels.nativeCount !== undefined && !labels.active.includes('Silly') && !labels.disabled.includes('Silly'), labels);
  await check('native-history-counter-fits-320px', !labels.overflow, labels);
  await page.locator('[data-pm-identifier="chatHistory"]').screenshot({ path: resolve(directory, 'managed-history-row.png') });
  const disabled = await page.evaluate(async () => {
    await co.reset(['PRIVATE-ORIGINAL', 'Recent', 'Latest']);
    co.c.chatMetadata.silly_memories_plus.blocks = [co.block('disabled-memory', 0, 0)];
    co.c.chatMetadata.silly_memories_plus.pinnedFacts = 'PRIVATE-PINNED';
    const saved = JSON.stringify(co.core.normalizeMemory(co.c.chatMetadata.silly_memories_plus));
    const control = document.getElementById('smp-enabled');
    const validation = document.getElementById('smp-message-validation');
    validation.value = 'presence'; validation.dispatchEvent(new Event('change', { bubbles: true }));
    const validationSaved = co.c.extensionSettings.silly_memories_plus.messageValidation === 'presence' && co.core.normalizeSettings().messageValidation === 'presence';
    control.checked = false; control.dispatchEvent(new Event('change', { bubbles: true }));
    let aborted = false;
    const outgoing = co.c.chat.map((message, index) => ({ ...message, index }));
    const before = JSON.stringify(outgoing);
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 1, () => { aborted = true; }, 'normal');
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 1, () => { aborted = true; }, 'manual');
    const result = await co.build();
    await co.script.sendGenerationRequest('normal', { prompt: result.chat });
    await co.openai.promptManager.renderPromptManager();
    const header = co.openai.promptManager.containerElement.querySelector('.completion_prompt_manager_header')?.lastElementChild.textContent;
    const native = new co.openai.ChatCompletion(); native.setTokenBudget(1234, 0);
    return { unchanged: JSON.stringify(outgoing) === before && JSON.stringify(co.c.chatMetadata.silly_memories_plus) === saved,
      noInjection: !JSON.stringify(co.requests.at(-1)?.messages).includes('memory_block') && !JSON.stringify(co.requests.at(-1)?.messages).includes('PRIVATE-PINNED'),
      raw: JSON.stringify(co.requests.at(-1)?.messages).includes('PRIVATE-ORIGINAL'), nativeBudget: native.tokenBudget,
      aborted, stops: co.stops, calls: co.calls.length, header, controlInSummarizer: control.closest('[data-section]')?.dataset.section === 'summarizer',
      validationSaved, manualDisabled: document.getElementById('smp-compact-now').disabled && document.getElementById('smp-test-summarizer').disabled };
  });
  await check('disabled-is-native-tavern-without-memory-or-guards', disabled.unchanged && disabled.noInjection && disabled.raw && disabled.nativeBudget === 1234 && !disabled.aborted && !disabled.stops && !disabled.calls && disabled.header !== 'Silly' && disabled.controlInSummarizer && disabled.manualDisabled && disabled.validationSaved, disabled);
  let dryRuns = 0;
  const watchDryRun = request => { if (request.url().includes('/api/backends/chat-completions/generate')) dryRuns++; };
  page.on('request', watchDryRun);
  await page.evaluate(async () => {
    co.idleBefore = co.diagnostics.exportDiagnostics(co.c.extensionSettings.silly_memories_plus, null).events.filter(event => ['prompt-estimate', 'prompt-estimate-rejected'].includes(event.type)).length;
    await co.script.eventSource.emit(co.script.event_types.GENERATION_ENDED);
    await co.script.eventSource.emit(co.script.event_types.SETTINGS_UPDATED);
  });
  await page.waitForTimeout(1200);
  await check('disabled-does-not-build-background-prompts', await page.evaluate(() => co.diagnostics.exportDiagnostics(co.c.extensionSettings.silly_memories_plus, null).events.filter(event => ['prompt-estimate', 'prompt-estimate-rejected'].includes(event.type)).length === co.idleBefore) && dryRuns === 0);
  page.off('request', watchDryRun);
  const restored = await page.evaluate(async () => {
    const control = document.getElementById('smp-enabled'); control.checked = true; control.dispatchEvent(new Event('change', { bubbles: true }));
    co.requests = []; co.stops = 0;
    const result = await co.build();
    const body = JSON.stringify(result.chat);
    return !result.aborted && !co.stops && body.includes('MEMORY-disabled-memory') && body.includes('PRIVATE-PINNED') && !body.includes('PRIVATE-ORIGINAL');
  });
  await check('reenabling-restores-saved-memory-and-facts', restored);
  const cancelled = await page.evaluate(async () => {
    await co.reset([' old-scene'.repeat(4000), ' recent'.repeat(100), ' latest'.repeat(100)], [], 4000);
    co.service.sendRequest = async () => {
      const control = document.getElementById('smp-enabled'); control.checked = false; control.dispatchEvent(new Event('change', { bubbles: true }));
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'Discard', ...co.structured('Late summary result.') }) } }] };
    };
    await co.build(4000);
    return co.c.chatMetadata.silly_memories_plus.blocks.length === 0;
  });
  await check('disabling-discards-in-flight-summary-results', cancelled);
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'context-ui.png') });
  assert.ok(results.every(result => result.passed), 'One or more context ownership checks failed');
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'context-ownership-report.json'), JSON.stringify({ results, failure, passed: !failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
