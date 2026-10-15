import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure matrix before implementation: stale retired children blessed with new
// fingerprints by edit/delete; async raw toggles writing into another chat;
// async edits overwriting newer facts; refresh losing editor drafts; simultaneous
// manual preflights starting duplicate jobs; tiny cold gaps blocking large ones;
// archived rollup regeneration blessing stale child summaries; late native tool
// removal leaving orphan results; manual compaction reading literal macros;
// concurrent/final preflights skipping validation or publishing after cancellation;
// hidden sources being sent or checkpointed; injected memory reused as raw input;
// passive prompt assembly interfering with a queued manual preflight;
// an empty manual request leaking forced mode into the next automatic request.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
let holdMarker;
let holdOwner;
let held;
await page.route('**/api/tokenizers/openai/count*', async route => {
  if (holdMarker && route.request().postData()?.includes(holdMarker) && (!holdOwner || route.request().headers()['x-smp-audit-owner'] === holdOwner)) {
    holdMarker = null;
    await new Promise(resolve => { held = resolve; });
  }
  await route.continue();
});
const gate = async (marker, owner) => { holdMarker = marker; holdOwner = owner; held = null; };
const waitGate = async () => { for (let i = 0; !held && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(held, 'Token gate was not reached'); };
const release = () => { held?.(); held = null; };
const results = [];
let failure;
try {
  await page.goto(process.env.SMP_BASE_URL || 'http://127.0.0.1:8001');
  await page.waitForFunction(() => typeof sillyMemoriesPlusGenerateInterceptor === 'function');
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
    c.characters.push({ name: 'Mira', avatar: 'none', chat: 'audit', data: {} });
    script.setCharacterId(c.characters.length - 1); script.setCharacterName('Mira'); script.changeMainAPI('openai');
    const structured = narrative => ({ narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
    globalThis.audit = { script, openai, core, identity, diagnostics, service, c, structured, calls: [], serial: 0 };
    audit.dryRuns = 0;
    script.eventSource.on(script.event_types.GENERATION_STARTED, (_, options, dryRun) => { if (dryRun) audit.dryRuns++; });
    const ajax = jQuery.ajax;
    Error.stackTraceLimit = 50;
    jQuery.ajax = function (options, ...args) {
      if (typeof options === 'object' && String(options.url).includes('/api/tokenizers/openai/count')) {
        const owner = new Error().stack.match(/toggleBlockRawSource|saveSelectedBlockEdit|inspectChatPrompt/)?.[0];
        if (owner) options = { ...options, headers: { ...options.headers, 'X-SMP-Audit-Owner': owner } };
      }
      return ajax.call(this, options, ...args);
    };
    service.getSupportedProfiles = () => [{ id: 'audit', name: 'Audit test' }]; service.getProfile = () => ({ id: 'audit' }); service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (_, messages, maxTokens) => {
      audit.calls.push({ messages, maxTokens });
      if (audit.modelGate) await audit.modelGate;
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structured('Mira recovered the key.')) } }] };
    };
    globalThis.confirm = () => true;
    audit.reset = async (texts = ['Original A', 'Original B', 'Recent', 'Latest']) => {
      c.characters.at(-1).chat = `audit-${++audit.serial}`;
      c.chat.splice(0, c.chat.length, ...texts.map((mes, index) => ({ name: index % 2 ? 'User' : 'Mira', mes, is_user: Boolean(index % 2), is_system: false, extra: {} })));
      c.chatMetadata.silly_memories_plus = core.createEmptyMemory(); audit.calls = []; audit.modelGate = null;
      c.extensionSettings.silly_memories_plus = core.normalizeSettings({ summaryProfileId: 'audit', blockTargetTokens: 512, minimumSourceTokens: 512, summaryInputBudgetTokens: 50000, summaryMaxOutputTokens: 2048, language: 'en' });
      Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', openai_max_context: 8512, openai_max_tokens: 512, names_behavior: 0 });
      await script.eventSource.emit(script.event_types.GENERATION_ENDED);
      await script.eventSource.emit(script.event_types.CHAT_CHANGED);
      document.querySelector('[data-section="memory"]').open = true;
    };
    audit.block = (id, from, to = from, level = 1, status = 'active', children = []) => {
      const sourceFingerprints = c.chat.slice(from, to + 1).map((message, offset) => identity.fingerprintMessage({ ...message, index: from + offset }));
      return { id, sourceFrom: from, sourceTo: to, level, status, children, structured: structured(`Saved ${id}`), sourceTokens: 5000, summaryTokens: 100, sourceFingerprints, sourceHash: identity.buildSourceHash(sourceFingerprints), createdAt: 1 };
    };
    audit.graph = () => { c.chatMetadata.silly_memories_plus.blocks = [audit.block('a', 0, 0, 1, 'retired'), audit.block('b', 1, 1, 1, 'retired'), audit.block('p', 0, 1, 2, 'active', ['a', 'b'])]; };
    audit.refresh = () => document.getElementById('smp-refresh').click();
    const root = document.getElementById('smp-settings'); document.body.append(root);
    root.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:430px;max-height:100vh;overflow:auto;background:#202225;z-index:99999';
    root.querySelector('.inline-drawer-content').style.display = 'block';
    document.getElementById('smp-language').value = 'en'; document.getElementById('smp-language').dispatchEvent(new Event('change', { bubbles: true }));
  });
  const card = id => page.locator(`.smp-block[data-block-id="${id}"]`);
  const check = (name, passed, details) => results.push({ name, passed: Boolean(passed), details });
  await page.evaluate(async () => { await audit.reset(); audit.graph(); audit.c.chat[0].mes = 'Changed A'; audit.refresh(); });
  await card('p').locator('[data-smp-block-action="delete"]').evaluate(button => button.click());
  await page.waitForFunction(() => !audit.c.chatMetadata.silly_memories_plus.blocks.some(block => block.id === 'p'));
  const deleted = await page.evaluate(() => audit.c.chatMetadata.silly_memories_plus.blocks.map(({ id, status, staleReason }) => ({ id, status, staleReason })));
  check('delete-parent-does-not-bless-edited-child', deleted.find(block => block.id === 'a')?.status !== 'active' && deleted.find(block => block.id === 'b')?.status === 'active', deleted);
  await page.evaluate(async () => { await audit.reset(); audit.graph(); audit.c.chat[1].mes = 'Changed B'; audit.refresh(); });
  await page.locator('[data-smp-tab="archive"]').click();
  await card('a').locator('[data-smp-block-action="edit"]').evaluate(button => button.click());
  await card('a').locator('[data-field="narrative"]').fill('Edited saved A');
  await card('a').locator('[data-smp-block-action="save-edit"]').evaluate(button => button.click());
  await page.waitForFunction(() => audit.c.chatMetadata.silly_memories_plus.blocks.find(block => block.id === 'a').structured.narrative === 'Edited saved A');
  const edited = await page.evaluate(() => audit.c.chatMetadata.silly_memories_plus.blocks.map(({ id, status, staleReason }) => ({ id, status, staleReason })));
  check('edit-child-does-not-bless-stale-sibling', edited.find(block => block.id === 'b')?.status !== 'active', edited);
  const rawMarker = `RAW-RACE-${Date.now()}`;
  await page.evaluate(async () => { await audit.reset(['Before raw toggle', 'Recent', 'Latest']); audit.c.chatMetadata.silly_memories_plus.blocks = [audit.block('a', 0)]; audit.refresh(); });
  await gate(rawMarker, 'toggleBlockRawSource');
  // Change the source and click in one task so idle measurements cannot cache it.
  await page.evaluate(marker => {
    audit.c.chat[0].mes = marker;
    audit.c.chatMetadata.silly_memories_plus.blocks = [audit.block('a', 0)];
    document.querySelector('[data-smp-block-action="toggle-raw"]').click();
  }, rawMarker); await waitGate();
  await page.evaluate(async () => { audit.c.characters.at(-1).chat = 'other-chat'; audit.c.chatMetadata.silly_memories_plus = audit.core.createEmptyMemory(); await audit.script.eventSource.emit(audit.script.event_types.CHAT_CHANGED); });
  await page.evaluate(() => { document.getElementById('smp-status').textContent = 'Audit pending action'; });
  release(); await page.waitForFunction(() => document.getElementById('smp-status').textContent !== 'Audit pending action');
  check('raw-toggle-cannot-write-into-another-chat', await page.evaluate(() => audit.c.chatMetadata.silly_memories_plus.blocks.length === 0));
  await page.evaluate(async () => { await audit.reset(); audit.c.chatMetadata.silly_memories_plus.blocks = [audit.block('a', 0)]; audit.refresh(); });
  await card('a').locator('[data-smp-block-action="edit"]').evaluate(button => button.click());
  const editMarker = `EDIT-RACE-${Date.now()}`;
  await card('a').locator('[data-field="narrative"]').fill(editMarker);
  await gate(editMarker, 'saveSelectedBlockEdit');
  await card('a').locator('[data-smp-block-action="save-edit"]').evaluate(button => button.click()); await waitGate();
  await page.evaluate(() => { audit.c.chatMetadata.silly_memories_plus = { ...audit.c.chatMetadata.silly_memories_plus, pinnedFacts: 'Newer facts' }; document.getElementById('smp-status').textContent = 'Audit pending action'; });
  release(); await page.waitForFunction(() => document.getElementById('smp-status').textContent !== 'Audit pending action');
  check('async-edit-cannot-overwrite-newer-facts', await page.evaluate(() => audit.c.chatMetadata.silly_memories_plus.pinnedFacts === 'Newer facts'));
  await page.evaluate(async () => { await audit.reset(); audit.c.chatMetadata.silly_memories_plus.blocks = [audit.block('a', 0)]; audit.refresh(); });
  await card('a').locator('[data-smp-block-action="edit"]').evaluate(button => button.click());
  await card('a').locator('[data-field="narrative"]').fill('Unsaved audit draft');
  await page.locator('#smp-refresh').evaluate(button => button.click());
  check('refresh-preserves-open-editor-draft', await card('a').locator('[data-field="narrative"]').inputValue() === 'Unsaved audit draft');
  await page.evaluate(async () => { await audit.reset([' scene'.repeat(6000), ' recent'.repeat(900), ' latest'.repeat(900)]); audit.modelGate = new Promise(resolve => { audit.releaseModel = resolve; }); });
  const doubleMarker = `DOUBLE-RACE-${Date.now()}`;
  await gate(doubleMarker);
  await page.locator('#smp-compact-now').evaluate(async (button, marker) => {
    await audit.script.eventSource.emit(audit.script.event_types.SETTINGS_UPDATED);
    audit.dryRuns = 0; audit.c.chat[0].mes = marker + ' scene'.repeat(6000); button.click(); button.click();
  }, doubleMarker); await waitGate();
  await page.waitForTimeout(850);
  check('passive-prompt-assembly-waits-for-manual-preflight', await page.evaluate(() => audit.dryRuns === 0));
  release(); await page.waitForTimeout(300);
  await page.evaluate(() => audit.releaseModel());
  await page.waitForFunction(() => audit.calls.length > 0 && !document.getElementById('smp-compact-now').disabled);
  const doubled = await page.evaluate(() => ({ calls: audit.calls.length, blocks: audit.c.chatMetadata.silly_memories_plus.blocks.length }));
  check('manual-double-click-starts-one-job', doubled.calls === 1 && doubled.blocks === 1, doubled);
  const gap = await page.evaluate(async () => {
    await audit.reset(['Tiny gap', 'Covered', ' large-cold'.repeat(5000), ' recent'.repeat(700), ' latest'.repeat(700)]);
    audit.c.chatMetadata.silly_memories_plus.blocks = [audit.block('middle', 1)];
    let aborted = false; const outgoing = audit.c.chat.map((message, index) => ({ ...message, index }));
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 5000, () => { aborted = true; }, 'normal');
    return { aborted, calls: audit.calls.length, blocks: audit.c.chatMetadata.silly_memories_plus.blocks.map(({ id, sourceFrom, sourceTo }) => ({ id, from: sourceFrom, to: sourceTo })), tinyKept: outgoing.some(message => message.mes === 'Tiny gap') };
  });
  check('small-cold-gap-does-not-block-later-large-source', !gap.aborted && gap.calls && gap.tinyKept && gap.blocks.some(block => block.from === 2 && block.to === 2), gap);
  const repeated = await page.evaluate(async () => {
    await audit.reset(['Covered source', ' recent'.repeat(700), ' latest'.repeat(700)]);
    const block = audit.block('large', 0); block.structured.narrative = ' saved-memory'.repeat(2300);
    audit.c.chatMetadata.silly_memories_plus.blocks = [block];
    const outgoing = audit.c.chat.map((message, index) => ({ ...message, index }));
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 9000, () => {}, 'normal');
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 9000, () => {}, 'normal');
    return { calls: audit.calls.length, blocks: audit.c.chatMetadata.silly_memories_plus.blocks.length };
  });
  check('repeated-interceptor-does-not-summarize-injected-memory-as-raw', repeated.calls === 0 && repeated.blocks === 1, repeated);
  await page.evaluate(async () => { await audit.reset(); audit.graph(); audit.c.chat[0].mes = 'Changed before rollup regeneration'; await audit.script.eventSource.emit(audit.script.event_types.CHAT_CHANGED); document.querySelector('[data-section="memory"]').open = true; });
  await page.locator('[data-smp-tab="archive"]').click();
  await card('p').locator('summary').click(); await page.locator('#smp-regenerate-block').click(); await page.locator('#smp-generate-preview').click();
  await page.waitForFunction(() => !document.getElementById('smp-generate-preview').disabled);
  const staleRollup = await page.evaluate(() => ({ calls: audit.calls.length, preview: !document.getElementById('smp-regeneration-preview').hidden, prompt: audit.calls.map(call => call.messages[1].content) }));
  check('rollup-regeneration-rebuilds-unverified-child-summaries', staleRollup.calls >= 2 && staleRollup.preview && staleRollup.prompt[0]?.includes('Changed before rollup regeneration') && !staleRollup.prompt.at(-1)?.includes('Saved a'), { calls: staleRollup.calls, preview: staleRollup.preview });
  await page.evaluate(async () => { await audit.reset(); audit.c.chatMetadata.silly_memories_plus.blocks = [audit.block('a', 0)]; audit.c.chat[0].extra[Symbol.for('ignore')] = true; await audit.script.eventSource.emit(audit.script.event_types.CHAT_CHANGED); document.querySelector('[data-section="memory"]').open = true; });
  await page.locator('[data-smp-tab="archive"]').click(); await card('a').locator('summary').click();
  await page.locator('#smp-regenerate-block').click(); await page.locator('#smp-generate-preview').click();
  await page.waitForFunction(() => !document.getElementById('smp-generate-preview').disabled);
  check('hidden-source-is-not-regenerated-or-sent', await page.evaluate(() => !audit.calls.length && document.getElementById('smp-regeneration-preview').hidden));
  await page.evaluate(async () => {
    await audit.reset([' source-to-hide'.repeat(5000), ' recent'.repeat(700), ' latest'.repeat(700)]);
    audit.modelGate = new Promise(resolve => { audit.releaseModel = resolve; });
    const outgoing = audit.c.chat.map((message, index) => ({ ...message, index }));
    audit.hiding = sillyMemoriesPlusGenerateInterceptor(outgoing, 8000, () => {}, 'normal');
  });
  await page.waitForFunction(() => audit.calls.length > 0);
  await page.evaluate(() => { audit.c.chat[0].extra[Symbol.for('ignore')] = true; audit.releaseModel(); return audit.hiding; });
  check('source-hidden-during-summary-cannot-be-checkpointed', await page.evaluate(() => audit.c.chatMetadata.silly_memories_plus.blocks.length === 0));
  const tools = await page.evaluate(async () => {
    const { replaceChatMemory } = await import('/scripts/extensions/third-party/silly-memories-plus/lib/prompt.mjs');
    const previous = [{ index: 0, mes: 'Old tool request', promptRole: 'assistant' }, { index: 1, mes: 'Latest', promptRole: 'user' }];
    const next = [{ index: -1, mes: 'Saved memory', promptRole: 'system', extra: { sillyMemoriesPlus: true } }, previous[1]];
    const prompt = [{ role: 'assistant', content: 'Old tool request', tool_calls: [{ id: 'old-tool', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', content: 'Old result', tool_call_id: 'old-tool' }, { role: 'user', content: 'Latest' }];
    return replaceChatMemory(prompt, previous, next);
  });
  check('late-compaction-does-not-leave-orphan-tool-results', !tools.some(message => message.role === 'tool') && tools.some(message => message.role === 'system'), tools.map(message => ({ role: message.role, toolCallId: message.tool_call_id })));
  await page.evaluate(async () => {
    await audit.reset(['{{getvar::audit_manual_source}}', ' recent'.repeat(700), ' latest'.repeat(700)]);
    audit.c.chatMetadata.variables = { audit_manual_source: ' manual-expanded-scene'.repeat(1500) };
  });
  await page.locator('#smp-compact-now').evaluate(button => button.click());
  await page.waitForFunction(() => !document.getElementById('smp-compact-now').disabled && document.getElementById('smp-status').dataset.kind !== 'working');
  check('manual-compaction-summarizes-expanded-history', await page.evaluate(() => audit.calls.length > 0 && audit.calls.every(call => !call.messages[1].content.includes('{{getvar')) && audit.calls.some(call => call.messages[1].content.includes('manual-expanded-scene'))));
  await page.evaluate(async () => {
    await audit.reset(); const outgoing = audit.c.chat.map((message, index) => ({ ...message, index }));
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 8000, () => {}, 'normal');
    audit.prompt = audit.c.chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes }));
  });
  const readyMarker = `READY-RACE-${Date.now()}`;
  await gate(readyMarker);
  await page.evaluate(marker => {
    audit.firstReady = audit.script.eventSource.emit(audit.script.event_types.CHAT_COMPLETION_PROMPT_READY, { chat: [{ role: 'system', content: marker }, ...audit.prompt], dryRun: false });
  }, readyMarker);
  await waitGate();
  await page.evaluate(() => {
    const chat = structuredClone(audit.prompt); chat.at(-1).content = 'Missing latest history'; audit.secondDone = false;
    audit.secondReady = audit.script.eventSource.emit(audit.script.event_types.CHAT_COMPLETION_PROMPT_READY, { chat, dryRun: false }).finally(() => { audit.secondDone = true; });
  });
  const skipped = await page.evaluate(() => audit.secondDone);
  release(); await page.evaluate(() => Promise.all([audit.firstReady, audit.secondReady]));
  check('concurrent-preflight-waits-and-checks-second-payload', !skipped && await page.evaluate(() => audit.diagnostics.exportDiagnostics(audit.c.extensionSettings.silly_memories_plus, null).events.some(event => event.type === 'prompt-blocked' && event.missing?.some(item => item.index === 3))));
  await page.evaluate(async () => {
    await audit.reset(); const outgoing = audit.c.chat.map((message, index) => ({ ...message, index }));
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 8000, () => {}, 'normal');
    audit.cancelId = audit.diagnostics.exportDiagnostics(audit.c.extensionSettings.silly_memories_plus, null).events.filter(event => event.type === 'plan').at(-1).requestId;
    audit.prompt = audit.c.chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes }));
  });
  const cancelMarker = `CANCEL-PREFLIGHT-${Date.now()}`;
  await gate(cancelMarker);
  await page.evaluate(marker => { audit.cancelReady = audit.script.eventSource.emit(audit.script.event_types.CHAT_COMPLETION_PROMPT_READY, { chat: [{ role: 'system', content: marker }, ...audit.prompt], dryRun: false }); }, cancelMarker);
  await waitGate(); await page.evaluate(() => audit.script.eventSource.emit(audit.script.event_types.GENERATION_STOPPED));
  release(); await page.evaluate(() => audit.cancelReady);
  check('cancelled-preflight-cannot-publish-stale-result', await page.evaluate(() => !audit.diagnostics.exportDiagnostics(audit.c.extensionSettings.silly_memories_plus, null).events.some(event => event.type === 'prompt-ready' && event.requestId === audit.cancelId)));
  await page.evaluate(async () => {
    await audit.reset([' old'.repeat(3000), 'Middle', 'Recent', 'Latest']);
    const outgoing = audit.c.chat.map((message, index) => ({ ...message, index }));
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 8000, () => {}, 'normal');
    audit.prompt = audit.c.chat.slice(-2).map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes }));
  });
  const inspectionMarker = `CANCEL-INSPECTION-${Date.now()}`;
  await gate(inspectionMarker, 'inspectChatPrompt');
  await page.evaluate(marker => { audit.cancelReady = audit.script.eventSource.emit(audit.script.event_types.CHAT_COMPLETION_PROMPT_READY, { chat: [{ role: 'system', content: 'Preset', reasoning: marker }, ...audit.prompt], dryRun: false }); }, inspectionMarker);
  await waitGate(); await page.evaluate(() => audit.script.eventSource.emit(audit.script.event_types.GENERATION_STOPPED));
  release(); await page.evaluate(() => audit.cancelReady);
  check('cancellation-during-inspection-cannot-start-late-compaction', await page.evaluate(() => audit.calls.length === 0 && audit.c.chatMetadata.silly_memories_plus.blocks.length === 0));
  await page.evaluate(async () => { await audit.reset([]); document.getElementById('smp-compact-now').click(); });
  const emptyRequest = await page.evaluate(async () => {
    audit.c.chat.push(...[' old'.repeat(3000), ' recent'.repeat(700), ' latest'.repeat(700)].map((mes, index) => ({ mes, name: 'Mira', is_user: Boolean(index % 2), extra: {} })));
    const outgoing = audit.c.chat.map((message, index) => ({ ...message, index }));
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 8000, () => {}, 'normal');
    return { calls: audit.calls.length, status: document.getElementById('smp-status').dataset.kind };
  });
  check('empty-manual-request-cannot-force-next-generation', emptyRequest.calls === 0 && emptyRequest.status !== 'working', emptyRequest);
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'audit-ui.png') });
  assert.ok(results.every(result => result.passed), 'Regression audit cases failed');
} catch (error) { failure = String(error.stack || error); }
finally {
  release();
  const debug = failure ? await page.evaluate(() => ({ api: audit.script.main_api, status: document.getElementById('smp-status').textContent, busy: document.getElementById('smp-compact-now').disabled })).catch(() => null) : undefined;
  await writeFile(resolve(directory, 'regression-audit-report.json'), JSON.stringify({ results, failure, passed: !failure, debug }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
