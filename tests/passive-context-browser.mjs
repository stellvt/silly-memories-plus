import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure cases: no idle measurement, stale preset/lore/model counts, clipped
// history counted as fixed overhead, regex text counted twice, cross-chat races,
// accidental provider/summarizer requests, chat mutations, background work during
// generation, idle refresh overwriting a validated generation measurement, and
// native dry runs expanding macros into the first stored message.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
const requests = [];
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.route(/\/api\/backends\/.+\/generate/, route => { requests.push(route.request().url()); return route.abort(); });
await page.route('**/api/worldinfo/get', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: { 0: { uid: 0, key: [], keysecondary: [], content: 'PASSIVE-LORE ' + ' brass-key-lore'.repeat(150), constant: true, selective: false, order: 100, position: 0, disable: false, probability: 100, useProbability: true } } }) }));
const results = [];
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
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const c = SillyTavern.getContext();
    const character = { name: 'Mira', avatar: 'none', chat: 'passive-a', description: ' observatory'.repeat(200), personality: '', scenario: '', first_mes: '', mes_example: '', data: { name: 'Mira', description: ' observatory'.repeat(200), extensions: {} } };
    c.characters.push(character);
    script.setCharacterId(c.characters.length - 1);
    script.setCharacterName('Mira');
    script.changeMainAPI('openai');
    Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', openai_max_context: 8512, openai_max_tokens: 512 });
    openai.promptManager.activeCharacter = { id: openai.promptManager.configuration.promptOrder.dummyId };
    c.chat.splice(0, c.chat.length, { name: 'Mira', mes: 'Mira found the brass key.', is_user: false, is_system: false, extra: {} }, { name: 'User', mes: 'What opens with that key?', is_user: true, is_system: false, extra: {} });
    for (const message of c.chat) Object.assign(message, { swipe_id: 0, swipes: [message.mes], swipe_info: [{ extra: {} }] });
    c.chatMetadata.silly_memories_plus = { schemaVersion: 3, blocks: [] };
    c.extensionSettings.silly_memories_plus = core.normalizeSettings({ minimumSourceTokens: 512 });
    globalThis.pc = { script, openai, core, c, dryRuns: 0, notices: 0, original: JSON.stringify(c.chat), snapshots: [] };
    script.eventSource.on(script.event_types.GENERATION_STARTED, (_, __, dryRun) => { if (dryRun) pc.dryRuns++; });
    script.eventSource.on(script.event_types.CHAT_COMPLETION_PROMPT_READY, data => { if (data.dryRun) pc.snapshots.push(structuredClone(data.chat)); });
    const root = document.getElementById('smp-settings');
    document.body.append(root);
    root.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:390px;max-height:100vh;overflow:auto;background:#202225;z-index:99999';
    root.querySelector('.inline-drawer-content').style.display = 'block';
    await script.eventSource.emit(script.event_types.CHAT_CHANGED);
  });
  async function check(name, condition) { results.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); }
  async function waitMeasured() { await page.waitForFunction(() => Number(document.getElementById('smp-context-meter').dataset.other) > 0 && !document.querySelector('.smp-context-legend').textContent.includes('Other prompt: —')); }
  const other = () => page.evaluate(() => Number(document.getElementById('smp-context-meter').dataset.other));
  await waitMeasured();
  const first = await other();
  await check('idle-chat-load-measures-current-prompt', first > 150 && await page.evaluate(() => pc.dryRuns > 0));
  await check('dry-run-does-not-mutate-chat', await page.evaluate(() => JSON.stringify(pc.c.chat) === pc.original && pc.c.chatMetadata.silly_memories_plus.blocks.length === 0));
  await page.evaluate(async () => {
    pc.c.characters.at(-1).description += ' additional-character-context'.repeat(250);
    pc.c.characters.at(-1).data.description = pc.c.characters.at(-1).description;
    await pc.script.eventSource.emit(pc.script.event_types.SETTINGS_UPDATED);
  });
  await page.waitForFunction(first => Number(document.getElementById('smp-context-meter').dataset.other) > first + 200, first);
  await check('settings-refresh-without-generation', await other() > first + 200);
  const beforeRace = await other();
  await page.evaluate(() => {
    let armed = true;
    pc.hold = async data => {
      if (!data.dryRun || !armed) return;
      armed = false; pc.blocked = true;
      await new Promise(resolve => { pc.release = resolve; });
    };
    pc.script.eventSource.on(pc.script.event_types.CHAT_COMPLETION_PROMPT_READY, pc.hold);
    document.getElementById('smp-refresh').click();
  });
  await page.waitForFunction(() => pc.blocked);
  await page.evaluate(async () => {
    pc.c.characters.at(-1).description += ' changed-during-measurement'.repeat(100);
    pc.c.characters.at(-1).data.description = pc.c.characters.at(-1).description;
    await pc.script.eventSource.emit(pc.script.event_types.SETTINGS_UPDATED);
    pc.release();
    pc.script.eventSource.removeListener(pc.script.event_types.CHAT_COMPLETION_PROMPT_READY, pc.hold);
  });
  await page.waitForFunction(before => Number(document.getElementById('smp-context-meter').dataset.other) > before + 100, beforeRace);
  await check('settings-changed-during-build-are-remeasured', true);
  const beforeRefresh = await page.evaluate(() => pc.dryRuns);
  await page.evaluate(() => document.getElementById('smp-refresh').click());
  await page.waitForFunction(before => pc.dryRuns > before, beforeRefresh);
  await waitMeasured();
  await check('refresh-rebuilds-prompt', true);
  const unclippedOther = await other();
  await page.evaluate(async () => {
    pc.c.chat[0].mes = ' old-history'.repeat(20000);
    await pc.script.eventSource.emit(pc.script.event_types.MESSAGE_EDITED);
  });
  await waitMeasured();
  await check('clipped-history-does-not-inflate-other-prompt', Math.abs(await other() - unclippedOther) < 100);
  await check('idle-overflow-does-not-create-memory', await page.evaluate(() => pc.c.chatMetadata.silly_memories_plus.blocks.length === 0));
  await page.evaluate(async () => {
    pc.c.extensionSettings.regex = [{ id: 'passive-regex', scriptName: 'Passive test', findRegex: '/REGEX_SOURCE/g', replaceString: ' transformed-history'.repeat(500), trimStrings: [], placement: [1, 2], disabled: false, promptOnly: true, markdownOnly: false, minDepth: null, maxDepth: null }];
    pc.c.chat[0].mes = 'REGEX_SOURCE';
    await pc.script.eventSource.emit(pc.script.event_types.MESSAGE_EDITED);
  });
  await waitMeasured();
  await check('prompt-regex-is-not-counted-twice', Math.abs(await other() - unclippedOther) < 100 && await page.evaluate(() => JSON.stringify(pc.snapshots.at(-1)).includes('transformed-history')));
  await page.evaluate(async () => {
    pc.c.characters.at(-1).data.extensions.world = 'Passive Lore';
    const { world_names } = await import('/scripts/world-info.js');
    if (!world_names.includes('Passive Lore')) world_names.push('Passive Lore');
    await pc.script.eventSource.emit(pc.script.event_types.WORLDINFO_SETTINGS_UPDATED);
  });
  await waitMeasured();
  await check('active-lore-is-counted-while-idle', await other() > unclippedOther + 150 && await page.evaluate(() => JSON.stringify(pc.snapshots.at(-1)).includes('PASSIVE-LORE')));
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'passive-lore.png') });
  await page.evaluate(() => { delete pc.c.characters.at(-1).data.extensions.world; });
  await page.evaluate(async () => {
    pc.c.characters.at(-1).chat = 'passive-b';
    pc.c.characters.at(-1).description = pc.c.characters.at(-1).data.description = 'Brief character.';
    pc.c.chat.splice(0, pc.c.chat.length, { name: 'User', mes: 'New chat.', is_user: true, extra: {} });
    pc.c.chatMetadata.silly_memories_plus = { schemaVersion: 3, blocks: [] };
    await pc.script.eventSource.emit(pc.script.event_types.CHAT_CHANGED);
  });
  await waitMeasured();
  await check('new-chat-measures-own-context', await other() < first);
  const beforeLive = await page.evaluate(async () => {
    pc.script.deactivateSendButtons();
    await pc.script.eventSource.emit(pc.script.event_types.GENERATION_STARTED, 'normal', {}, false);
    await pc.script.eventSource.emit(pc.script.event_types.SETTINGS_UPDATED);
    return pc.dryRuns;
  });
  // Allow several debounce windows to prove idle work is gated during generation.
  await page.waitForTimeout(1800);
  await check('no-background-build-during-generation', await page.evaluate(() => pc.dryRuns) === beforeLive);
  await page.evaluate(async () => { pc.script.activateSendButtons(); await pc.script.eventSource.emit(pc.script.event_types.GENERATION_ENDED); });
  await page.waitForFunction(before => pc.dryRuns > before, beforeLive);
  await waitMeasured();
  await check('idle-refresh-resumes-after-generation', true);
  await page.evaluate(async () => {
    pc.script.changeMainAPI('textgenerationwebui');
    await pc.script.eventSource.emit(pc.script.event_types.MAIN_API_CHANGED);
  });
  await waitMeasured();
  await check('text-completion-has-idle-measurement', await other() > 0);
  const beforeOffline = await page.evaluate(async () => {
    if (SillyTavern.getContext().onlineStatus !== 'no_connection') throw new Error('Offline fixture required');
    await pc.script.Generate('normal');
    await pc.script.eventSource.emit(pc.script.event_types.SETTINGS_UPDATED);
    return pc.dryRuns;
  });
  await page.waitForFunction(before => pc.dryRuns > before, beforeOffline);
  await waitMeasured();
  await check('offline-generation-does-not-block-idle-refresh', true);
  const beforeFirstMacro = await page.evaluate(async () => {
    pc.c.chat[0].mes = '{{getvar::passive_first_message}}';
    pc.c.chatMetadata.variables = { passive_first_message: 'Expanded first message.' };
    await pc.script.eventSource.emit(pc.script.event_types.MESSAGE_EDITED, 0);
    return pc.dryRuns;
  });
  await page.waitForTimeout(1400);
  await check('first-message-macros-stay-stored-during-idle-measurement', await page.evaluate(before => pc.dryRuns === before && pc.c.chat[0].mes === '{{getvar::passive_first_message}}', beforeFirstMacro));
  await page.evaluate(async () => {
    pc.c.chat[0].mes = 'Expanded first message.';
    await pc.script.eventSource.emit(pc.script.event_types.MESSAGE_EDITED, 0);
  });
  await page.waitForFunction(before => pc.dryRuns > before, beforeFirstMacro);
  await waitMeasured();
  await check('idle-measurement-resumes-after-first-message-is-expanded', true);
  await check('no-provider-requests', requests.length === 0);
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'passive-context.png') });
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'passive-context-report.json'), JSON.stringify({ results, requests, failure, passed: !failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, requests, failure }, null, 2));
if (failure) throw new Error(failure);
