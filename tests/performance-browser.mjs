import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure matrix, written before optimization:
// - diagnostic lookup serializes long strings quadratically or changes which duplicate wins;
// - simultaneous identical history counts cause duplicate tokenizer HTTP requests;
// - failed counts poison a retry, or chat/model changes share a pending count;
// - diagnostic reuse overlooks changed content, roles, fields or native media costs;
// - reuse skips transport validation, loses history/memory, changes SSE or leaks text.
// Existing matching/transport/passive suites cover actual native prompt assembly,
// late mutations, media/tools, source edits and chat switches with mocked providers.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage();
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
const requests = [];
let rejectCount = false;
let countDelay = 40;
await page.route('**/api/tokenizers/openai/count?*', async route => {
  const messages = route.request().postDataJSON();
  if (!messages.some(m => String(m.content).startsWith('PERF-COUNT:'))) return route.continue();
  requests.push({ model: new URL(route.request().url()).searchParams.get('model'), role: messages[0].role });
  await new Promise(resolve => setTimeout(resolve, countDelay));
  if (rejectCount) { rejectCount = false; return route.fulfill({ status: 500, body: '{}' }); }
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{"token_count":42}' });
});
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
  results.push(...await page.evaluate(async () => {
    const { inspectChatPrompt, createChatPromptInspector } = await import('/scripts/extensions/third-party/silly-memories-plus/lib/prompt-inspection.mjs');
    const results = [];
    const native = Array.from({ length: 300 }, (_, i) => ({ identifier: `chatHistory-${i}`, role: i % 2 ? 'user' : 'assistant', content: `MESSAGE-${i} ` + ' observatory-key'.repeat(800) }));
    const prompt = native.map(({ role, content }) => ({ role, content }));
    const stringify = JSON.stringify;
    let serializations = 0;
    JSON.stringify = (...args) => { serializations++; return stringify(...args); };
    const started = performance.now();
    try { await inspectChatPrompt(prompt, [], [], native, async () => 32, async () => 20); }
    finally { JSON.stringify = stringify; }
    results.push({ scenario: 'linear-diagnostic-serialization', serializations, durationMs: performance.now() - started, passed: serializations <= 1200 });
    const duplicates = [{ role: 'system', content: 'same', identifier: 'main' }, { role: 'system', content: 'same', identifier: 'scenario' }];
    const inspected = await inspectChatPrompt([{ role: 'system', content: 'same' }], [], [], duplicates, async () => 32, async () => 20);
    results.push({ scenario: 'first-native-duplicate-wins', passed: inspected.components[0].source === 'main' });
    if (typeof createChatPromptInspector !== 'function') results.push({ scenario: 'request-scoped-diagnostic-reuse', passed: false });
    else {
      let calls = 0;
      const inspect = createChatPromptInspector();
      const count = async () => { calls++; return 32; };
      const input = [{ role: 'system', content: [{ type: 'text', text: 'same' }, { type: 'image_url', image_url: { detail: 'low', url: 'https://example.invalid/x' } }] }];
      let mediaTokens = 100;
      const nativeMedia = [{ ...input[0], identifier: 'main', getTokens: () => mediaTokens }];
      const first = await inspect(input, [], [], nativeMedia, count, count);
      const before = calls;
      const second = await inspect(structuredClone(input), [], [], nativeMedia, count, count);
      results.push({ scenario: 'request-scoped-diagnostic-reuse', passed: !first.reused && second.reused && calls === before && stringify(first.components) === stringify(second.components) });
      for (const [scenario, mutate] of [
        ['text', () => { input[0].content[0].text = 'changed'; }],
        ['role', () => { input[0].role = 'user'; }],
        ['tool-fields', () => { input[0].tool_calls = [{ id: 'tool', type: 'function', function: { name: 'lookup', arguments: '{}' } }]; }],
        ['native-media-cost', () => { mediaTokens++; }],
      ]) {
        mutate();
        const before = calls;
        const result = await inspect(input, [], [], nativeMedia, count, count);
        results.push({ scenario: `diagnostic-invalidates-${scenario}`, passed: !result.reused && calls > before });
      }
    }
    return results;
  }));
  await page.evaluate(async () => {
    const script = await import('/script.js');
    const openai = await import('/scripts/openai.js');
    const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
    const c = SillyTavern.getContext();
    c.characters.push({ name: 'Performance', avatar: 'none', chat: 'performance', data: {} });
    script.setCharacterId(c.characters.length - 1); script.changeMainAPI('openai');
    Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', openai_max_context: 50000, openai_max_tokens: 512 });
    globalThis.perf = { script, openai, core, c, serial: 0 };
    perf.run = async (text, chat = `performance-${++perf.serial}`) => {
      document.body.dataset.generating = 'performance-e2e';
      await script.eventSource.emit(script.event_types.GENERATION_ENDED);
      c.characters.at(-1).chat = chat;
      c.extensionSettings.silly_memories_plus = core.normalizeSettings({ debug: false });
      c.chatMetadata.silly_memories_plus = core.createEmptyMemory();
      c.chat.splice(0, c.chat.length, ...Array.from({ length: 30 }, (_, index) => ({ name: 'User', mes: text, is_user: Boolean(index % 2), extra: {} })));
      await script.eventSource.emit(script.event_types.CHAT_CHANGED);
      const outgoing = c.chat.map((m, index) => ({ ...m, index }));
      let aborted = false;
      await sillyMemoriesPlusGenerateInterceptor(outgoing, 50000, () => { aborted = true; }, 'normal');
      return { aborted, preserved: outgoing.length === 30 && outgoing.every(m => m.mes === text) };
    };
  });
  const before = requests.length;
  const concurrent = await page.evaluate(() => perf.run('PERF-COUNT: simultaneous identical source'));
  results.push({ scenario: 'identical-history-counts-share-http', requests: requests.length - before, passed: requests.length - before === 1 && !concurrent.aborted && concurrent.preserved });
  rejectCount = true;
  const failed = await page.evaluate(() => perf.run('PERF-COUNT: failed count can be retried', 'retry-scope'));
  const retry = await page.evaluate(() => perf.run('PERF-COUNT: failed count can be retried', 'retry-scope'));
  results.push({ scenario: 'failed-count-can-retry', passed: failed.aborted && !retry.aborted && retry.preserved });
  const initial = requests.length;
  countDelay = 250;
  const scopeStarted = page.waitForRequest(request => request.url().includes('/api/tokenizers/openai/count?') && request.postData()?.includes('PERF-COUNT: distinct scopes'));
  await page.evaluate(() => { perf.pending = perf.run('PERF-COUNT: distinct scopes', 'scope-a'); });
  await scopeStarted;
  await page.evaluate(async () => {
    perf.c.characters.at(-1).chat = 'scope-b';
    await perf.script.eventSource.emit(perf.script.event_types.CHAT_CHANGED);
    await perf.pending;
    await new Promise(resolve => setTimeout(resolve, 400));
  });
  results.push({ scenario: 'chat-scopes-do-not-share-counts', requests: requests.length - initial, passed: requests.length - initial >= 2 });
  const modelStart = requests.length;
  const modelStarted = page.waitForRequest(request => request.url().includes('/api/tokenizers/openai/count?') && request.postData()?.includes('PERF-COUNT: model scopes'));
  await page.evaluate(() => { perf.pending = perf.run('PERF-COUNT: model scopes', 'model-scope'); });
  await modelStarted;
  await page.evaluate(async () => {
    perf.openai.oai_settings.openai_model = 'gpt-3.5-turbo';
    await perf.script.eventSource.emit(perf.script.event_types.CHAT_CHANGED);
    await perf.pending;
    await new Promise(resolve => setTimeout(resolve, 400));
  });
  results.push({ scenario: 'model-scopes-do-not-share-counts', passed: new Set(requests.slice(modelStart).map(request => request.model)).size === 2 });
  assert.ok(results.every(result => result.passed), `Failed: ${results.filter(result => !result.passed).map(result => result.scenario).join(', ')}`);
} catch (error) { failure = String(error.stack || error); }
finally {
  await page.screenshot({ path: resolve(directory, 'performance.png') }).catch(() => {});
  await writeFile(resolve(directory, 'performance-report.json'), JSON.stringify({ results, requests, failure, passed: !failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
