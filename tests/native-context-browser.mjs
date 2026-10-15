import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const results = [];
const requests = [];
let failure;
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.route(/\/api\/backends\/.+\/generate/, route => { requests.push(route.request().url()); return route.abort(); });
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
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const c = SillyTavern.getContext();
    c.characters.push({ name: 'Mira', avatar: 'none', chat: 'native-context-test', description: 'An archivist.', data: { name: 'Mira', description: 'An archivist.', extensions: {} } });
    script.setCharacterId(c.characters.length - 1); script.setCharacterName('Mira'); script.changeMainAPI('openai');
    Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', openai_max_context: 8512, openai_max_tokens: 512, names_behavior: 2 });
    openai.promptManager.activeCharacter = { id: openai.promptManager.configuration.promptOrder.dummyId };
    c.chat.splice(0, c.chat.length, ...['First message.', 'Short history.', 'Recent question?'].map((mes, index) => ({ name: 'Mira', mes, is_user: index % 2 === 1, is_system: false, extra: {}, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }] })));
    c.chatMetadata.silly_memories_plus = { schemaVersion: 3, blocks: [] };
    c.extensionSettings.silly_memories_plus = core.normalizeSettings({ minimumSourceTokens: 512 });
    globalThis.nc = { script, openai, core, identity, c, snapshots: [] };
    script.eventSource.on(script.event_types.CHAT_COMPLETION_PROMPT_READY, data => { if (data.dryRun) nc.snapshots.push(structuredClone(data.chat)); });
    await script.eventSource.emit(script.event_types.CHAT_CHANGED);
  });
  const check = (name, passed, details) => { results.push({ name, passed: Boolean(passed), details }); assert.ok(passed, name); };
  const waitMeasured = () => page.waitForFunction(() => Number(document.getElementById('smp-context-meter').dataset.other) > 0 && !document.querySelector('.smp-context-legend').textContent.includes('Other prompt: —'));
  await waitMeasured();
  const baseline = await page.evaluate(() => Number(document.getElementById('smp-context-meter').dataset.other));
  await page.evaluate(async () => {
    nc.c.chat[1].mes = ('Memory {{char}} / {{random::alpha::beta}}.\n').repeat(300);
    await nc.script.eventSource.emit(nc.script.event_types.MESSAGE_EDITED);
  });
  await waitMeasured();
  const expanded = await page.evaluate(() => ({ other: Number(document.getElementById('smp-context-meter').dataset.other), raw: Number(document.getElementById('smp-context-meter').dataset.raw), prompt: JSON.stringify(nc.snapshots.at(-1)) }));
  check('expanded-history-is-not-other-prompt', Math.abs(expanded.other - baseline) < 100 && expanded.prompt.includes('Memory Mira') && !expanded.prompt.includes('{{random'), { baseline, other: expanded.other, raw: expanded.raw });
  const live = await page.evaluate(async () => {
    let stops = 0;
    const onStop = () => { stops++; };
    nc.script.eventSource.on(nc.script.event_types.GENERATION_STOPPED, onStop);
    await nc.script.eventSource.emit(nc.script.event_types.GENERATION_STARTED, 'normal', {}, false);
    const outgoing = nc.c.chat.map((message, index) => ({ ...message, index }));
    let aborted = false;
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 8000, () => { aborted = true; }, 'normal');
    const [chat] = await nc.openai.prepareOpenAIMessages({ name2: 'Mira', charDescription: 'An archivist.', charPersonality: '', scenario: '', worldInfoBefore: '', worldInfoAfter: '', bias: '', type: 'normal', quietPrompt: '', extensionPrompts: {}, cyclePrompt: '', systemPromptOverride: '', jailbreakPromptOverride: '', messages: nc.openai.setOpenAIMessages(outgoing), messageExamples: [] }, false);
    nc.script.eventSource.removeListener(nc.script.event_types.GENERATION_STOPPED, onStop);
    await nc.script.eventSource.emit(nc.script.event_types.GENERATION_ENDED);
    return { aborted, stops, expanded: JSON.stringify(chat).includes('Memory Mira'), other: Number(document.getElementById('smp-context-meter').dataset.other) };
  });
  check('live-macro-history-passes-final-preflight', !live.aborted && live.stops === 0 && live.expanded && live.other < baseline + 100, live);
  const native = await page.evaluate(async () => {
    const o = nc.openai;
    const args = { name2: 'Mira', charDescription: 'An archivist.', charPersonality: '', scenario: '', worldInfoBefore: '', worldInfoAfter: '', bias: '', type: 'normal', quietPrompt: '', extensionPrompts: {}, cyclePrompt: '', systemPromptOverride: '', jailbreakPromptOverride: '', messages: [{ role: 'assistant', name: 'Mira', content: 'OLDEST-CONTENT ' + ' long-history'.repeat(3000) }, { role: 'user', name: 'User', content: 'NEWEST-CONTENT' }], messageExamples: [] };
    o.oai_settings.openai_max_context = 1024; o.oai_settings.openai_max_tokens = 512;
    const [managed] = await o.prepareOpenAIMessages(structuredClone(args), true);
    await o.promptManager.renderPromptManager();
    const label = o.promptManager.containerElement.querySelector('.completion_prompt_manager_header').lastElementChild.textContent;
    const settings = JSON.stringify({ context: o.oai_settings.openai_max_context, output: o.oai_settings.openai_max_tokens });
    nc.c.extensionSettings.silly_memories_plus.enabled = false;
    const [unmanaged] = await o.prepareOpenAIMessages(structuredClone(args), true);
    await o.promptManager.renderPromptManager();
    const restoredLabel = o.promptManager.containerElement.querySelector('.completion_prompt_manager_header').lastElementChild.textContent;
    nc.c.extensionSettings.silly_memories_plus.enabled = true;
    return { managed: JSON.stringify(managed).includes('OLDEST-CONTENT'), unmanaged: JSON.stringify(unmanaged).includes('OLDEST-CONTENT'), label, restoredLabel, settings };
  });
  check('native-builder-keeps-old-history-under-pressure', native.managed && !native.unmanaged, native);
  check('native-token-tab-shows-manager-and-restores-on-disable', native.label === 'Managed by Silly Memories' && native.restoredLabel.includes('Total Tokens'), native);
  check('real-context-and-output-settings-are-unchanged', native.settings === '{"context":1024,"output":512}');
  const recovery = await page.evaluate(async () => {
    const structured = { narrative: 'Original saved memory', relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] };
    const sources = nc.c.chat.map((message, index) => ({ ...message, index }));
    const blocks = [[0, 0], [1, 1]].map(([from, to], index) => ({ id: `recover-${index}`, level: 1, sourceFrom: from, sourceTo: to, sourceHash: nc.identity.buildSourceHash(sources.slice(from, to + 1).map(nc.identity.fingerprintMessage)), sourceFingerprints: [], children: [], status: 'stale', structured }));
    nc.c.chatMetadata.silly_memories_plus = { schemaVersion: 3, blocks };
    await nc.script.eventSource.emit(nc.script.event_types.CHAT_CHANGED);
    const restored = structuredClone(nc.c.chatMetadata.silly_memories_plus);
    nc.c.chat[0].mes = 'Actually edited';
    await nc.script.eventSource.emit(nc.script.event_types.MESSAGE_EDITED);
    // The event adapter is intentionally fire-and-forget. Wait for saved metadata.
    await new Promise(resolve => setTimeout(resolve, 100));
    return { restored, afterEdit: nc.c.chatMetadata.silly_memories_plus };
  });
  check('chat-load-restores-legacy-blocks-without-summarizing', recovery.restored.blocks.every(block => block.status === 'active' && block.structured.narrative === 'Original saved memory' && block.sourceFingerprints.length === 1));
  check('editing-one-source-preserves-the-other-block', recovery.afterEdit.blocks[0].status === 'stale' && recovery.afterEdit.blocks[1].status === 'active');
  check('recovery-and-measurement-send-no-provider-requests', requests.length === 0);
  await page.evaluate(async () => {
    const manager = nc.openai.promptManager;
    await manager.renderPromptManager();
    await manager.renderPromptManagerListItems();
    document.body.append(manager.containerElement);
    manager.containerElement.style.cssText = 'display:block;position:fixed;inset:20px auto auto 20px;width:470px;max-height:90vh;overflow:auto;background:#202225;z-index:99999;padding:16px';
  });
  await page.locator('.completion_prompt_manager_header').screenshot({ path: resolve(directory, 'managed-context.png') });
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'native-context-report.json'), JSON.stringify({ results, requests, failure, passed: !failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
