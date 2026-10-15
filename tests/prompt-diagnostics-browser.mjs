import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failures defined before implementation: stale/double-counted preset budgets,
// first-request lore pressure, omitted memory/facts/history, squashed system
// messages, ignored dry runs/quiet calls, stream mutation, popup spam/XSS,
// missing downloads, leaked chat/prompt/credential text and unbounded logs.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
assert.ok(directory && process.env.SMP_BROWSER_EXECUTABLE);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
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
    const { getTokenCountAsync: count, countTokensOpenAIAsync: countChat } = await import('/scripts/tokenizers.js');
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const c = SillyTavern.getContext();
    c.characters.push({ name: 'Prompt test', avatar: 'none', chat: 'prompt-test', data: {} });
    script.setCharacterId(c.characters.length - 1);
    script.changeMainAPI('openai');
    openai.oai_settings.chat_completion_source = 'openai';
    openai.oai_settings.openai_model = 'gpt-4o-mini';
    const structured = narrative => ({ title: 'Memory', narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
    globalThis.pd = { script, openai, core, c, count, countChat, service, structured, calls: [], stops: 0, notices: [] };
    script.eventSource.on(script.event_types.GENERATION_STOPPED, () => pd.stops++);
    service.getProfile = () => ({ id: 'prompt-test' });
    service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (_, messages, maxTokens, options) => {
      pd.calls.push({ maxTokens, stream: options.stream });
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structured('Mira recovered the observatory key.')) } }] };
    };
    const root = document.getElementById('smp-settings');
    document.body.append(root);
    root.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:430px;max-height:100vh;overflow:auto;background:#202225;z-index:99999';
    root.querySelector('.inline-drawer-content').style.display = 'block';
    for (const kind of ['info', 'success', 'warning', 'error']) {
      const native = toastr[kind];
      toastr[kind] = (...args) => { if (args[1] === 'Silly Memories Plus') pd.notices.push({ kind, text: args[0], options: args[2] }); return native(...args); };
    }
    await count(' prime tokens');
  });
  for (const scenario of ['first-lore', 'clipped-memory', 'clipped-cold-history', 'squashed', 'duplicate-history', 'media', 'dry-run', 'quiet', 'native-builder', 'native-squashed', 'static-change', 'text-completion']) {
    const result = await page.evaluate(async scenario => {
      const t = pd;
      t.calls.length = 0; t.stops = 0;
      t.c.characters.at(-1).chat = `prompt-${scenario}`;
      const raw = scenario === 'clipped-cold-history' ? [100, 1800, 500, 500] : [100, 500, 500];
      t.c.chat.splice(0, t.c.chat.length, ...raw.map((size, index) => ({ name: 'Mira', mes: `RAW-${index} ` + ' history'.repeat(size), is_user: index % 2 === 0, is_system: false, extra: {} })));
      if (scenario === 'duplicate-history') t.c.chat[2].mes = t.c.chat[1].mes;
      t.c.chatMetadata.silly_memories_plus = { schemaVersion: 3, pinnedFacts: 'PRIVATE-FACT: Mira holds the silver key.', blocks: [{ id: 'original-memory', level: 1, structured: t.structured('PRIVATE-MEMORY: Mira trusted Rowan.'), sourceFrom: 0, sourceTo: 0, sourceTokens: 8000, summaryTokens: 100, sourceFingerprints: [], children: [], status: 'active' }] };
      t.c.extensionSettings.silly_memories_plus = t.core.normalizeSettings({ summaryProfileId: 'prompt-test', summaryInputBudgetTokens: 50000, blockTargetTokens: 256, minimumSourceTokens: 512, debug: true });
      await t.script.eventSource.emit(t.script.event_types.CHAT_CHANGED);
      const budget = scenario === 'text-completion' ? 10000 : 5000;
      t.openai.oai_settings.openai_max_context = budget + 512;
      t.openai.oai_settings.openai_max_tokens = 512;
      t.openai.oai_settings.squash_system_messages = scenario === 'native-squashed';
      const outgoing = t.c.chat.map((message, index) => ({ ...message, index }));
      let aborted = false;
      await sillyMemoriesPlusGenerateInterceptor(outgoing, budget, () => { aborted = true; }, 'normal');
      const api = outgoing.map(message => ({ role: message.extra?.type ? 'system' : message.is_user ? 'user' : 'assistant', content: message.mes }));
      const header = { role: 'system', content: 'PRIVATE-PRESET ' + ' preset'.repeat(1300) };
      const lore = { role: 'system', content: 'PRIVATE-LORE ' + ' lore'.repeat(900) };
      let event = { chat: [header, lore, ...api], dryRun: scenario === 'dry-run' };
      if (['clipped-memory', 'clipped-cold-history', 'first-lore'].includes(scenario)) event.chat = [header, lore, ...api.filter(message => !message.content.includes('memory_block') && (scenario !== 'clipped-cold-history' || !message.content.startsWith('RAW-1')))];
      if (scenario === 'squashed') event.chat = [{ role: 'system', content: [header.content, lore.content, ...api.filter(message => message.role === 'system').map(message => message.content)].join('\n') }, ...api.filter(message => message.role !== 'system')];
      if (scenario === 'media') event.chat.at(-1).content = [{ type: 'text', text: api.at(-1).content }, { type: 'image_url', image_url: { url: 'https://example.invalid/image.png', detail: 'low' } }];
      const before = JSON.stringify(event.chat);
      if (scenario === 'quiet') {
        await t.script.eventSource.emit(t.script.event_types.GENERATION_ENDED);
        event = { chat: [{ role: 'user', content: 'Unrelated quiet task.' }], dryRun: false };
      }
      if (scenario.startsWith('native-')) {
        [event.chat] = await t.openai.prepareOpenAIMessages({ name2: 'Mira', charDescription: header.content, charPersonality: '', scenario: '', worldInfoBefore: lore.content, worldInfoAfter: 'AFTER-LORE', bias: '', type: 'normal', quietPrompt: '', extensionPrompts: {}, cyclePrompt: '', systemPromptOverride: '', jailbreakPromptOverride: '', messages: api.slice().reverse().map(message => ({ ...message, name: 'Mira' })), messageExamples: [] }, false);
      } else if (scenario === 'text-completion') {
        t.script.changeMainAPI('textgenerationwebui');
        const textEvent = { prompt: [header.content, lore.content, ...outgoing.map(message => `${message.name}: ${message.mes}`)].join('\n'), dryRun: false };
        await t.script.eventSource.emit(t.script.event_types.GENERATE_AFTER_COMBINE_PROMPTS, textEvent);
        event.chat = [{ role: 'system', content: textEvent.prompt }];
        t.script.changeMainAPI('openai');
      } else {
        // Deliberately stale counters must never override the actual request.
        t.openai.promptManager.tokenHandler.counts = { chatHistory: 99999, conversation: 99999, main: 99999 };
        await t.script.eventSource.emit(t.script.event_types.CHAT_COMPLETION_PROMPT_READY, event);
      }
      if (scenario === 'static-change') {
        const next = t.c.chat.map((message, index) => ({ ...message, index }));
        await sillyMemoriesPlusGenerateInterceptor(next, budget, () => { aborted = true; }, 'normal');
        event = { chat: [{ role: 'system', content: 'A small current preset.' }, ...next.map(message => ({ role: message.extra?.type ? 'system' : message.is_user ? 'user' : 'assistant', content: message.mes }))], dryRun: false };
        await t.script.eventSource.emit(t.script.event_types.CHAT_COMPLETION_PROMPT_READY, event);
      }
      const text = JSON.stringify(event.chat);
      const meter = document.getElementById('smp-context-meter');
      const usage = Object.fromEntries(['used', 'budget', 'other', 'facts'].map(key => [key, Number(meter.dataset[key])]));
      return { scenario, aborted, stops: t.stops, calls: t.calls.length, memory: text.includes('memory_block'), facts: text.includes('PRIVATE-FACT'), tail: t.c.chat.slice(-2).every(message => text.includes(message.mes)), preset: text.includes('PRIVATE-PRESET'), lore: text.includes('PRIVATE-LORE'), media: text.includes('image_url'), unchanged: JSON.stringify(event.chat) === before, usage, status: document.getElementById('smp-status').textContent };
    }, scenario);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  await page.evaluate(() => {
    pd.c.extensionSettings.silly_memories_plus.summaryProfileId = 'PRIVATE-CREDENTIAL-sk-test-123';
    pd.service.sendRequest = async () => ({ choices: [{ message: { content: JSON.stringify({ ...pd.structured('Valid narrative'), '<img src=x onerror="window.smpXss=1">': 'malicious' }) } }] });
    document.getElementById('smp-test-summarizer').click();
  });
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'error');
  results.push({ scenario: 'escaped-error-popup', passed: await page.evaluate(() => !window.smpXss && !document.querySelector('#toast-container img') && document.getElementById('toast-container')?.textContent.includes('<img')) });
  await page.screenshot({ path: resolve(directory, 'error-popup.png'), fullPage: true });
  // The exported file is the repeatable diagnostic artifact users can share.
  await page.evaluate(() => { document.querySelector('[data-section="debug"]').open = true; });
  assert.ok(await page.locator('#smp-download-logs').count(), 'Download logs button is missing');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#smp-download-logs').evaluate(button => button.click())]);
  const logPath = resolve(directory, 'diagnostics.json');
  await download.saveAs(logPath);
  const logText = await readFile(logPath, 'utf8');
  const logs = JSON.parse(logText);
  results.push({ scenario: 'download-logs', passed: Array.isArray(logs.events) && logs.events.length > 0 && logs.events.length <= 500 && !/PRIVATE-(?:PRESET|LORE|FACT|MEMORY|CREDENTIAL)|RAW-\d|onerror/.test(logText) });
  await page.evaluate(async () => { for (let index = 0; index < 600; index++) await pd.script.eventSource.emit(pd.script.event_types.CHAT_CHANGED); });
  const [boundedDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#smp-download-logs').evaluate(button => button.click())]);
  const boundedPath = resolve(directory, 'bounded-diagnostics.json');
  await boundedDownload.saveAs(boundedPath);
  const bounded = JSON.parse(await readFile(boundedPath, 'utf8'));
  results.push({ scenario: 'bounded-log-buffer', passed: bounded.events.length === 500 });
  await page.waitForFunction(() => Number(document.getElementById('smp-context-meter').dataset.used) > 0);
  await page.evaluate(() => { document.getElementById('smp-debug').checked = pd.c.extensionSettings.silly_memories_plus.debug; });
  const notices = await page.evaluate(() => pd.notices);
  results.push({ scenario: 'short-safe-notices', passed: notices.length > 0 && notices.every(notice => String(notice.text).length <= 240 && notice.options?.escapeHtml === true) });
  for (const result of results) {
    if ('passed' in result) assert.ok(result.passed, result.scenario);
    else if (result.scenario === 'dry-run') assert.ok(result.unchanged, 'dry run changed');
    else if (result.scenario === 'quiet') assert.ok(!result.memory && !result.facts, 'quiet request polluted');
    else {
      assert.ok(result.memory && result.facts && result.tail && result.stops === 0 && !result.aborted, `${result.scenario}: required context lost: ${JSON.stringify(result)}`);
      assert.ok(result.usage.other > 0 && result.usage.other < 10000 && result.usage.used <= result.usage.budget, `${result.scenario}: wrong accounting`);
      if (!result.scenario.startsWith('native-') && result.scenario !== 'static-change') assert.ok(result.preset && result.lore, `${result.scenario}: static text lost`);
      if (result.scenario === 'media') assert.ok(result.media, 'media was lost');
      if (result.scenario === 'static-change') assert.ok(result.usage.other < 200, 'stale static budget survived');
    }
  }
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'prompt-diagnostics-report.json'), JSON.stringify({ results, failure, passed: !failure }, null, 2));
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'diagnostics-ui.png') }).catch(() => {});
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
