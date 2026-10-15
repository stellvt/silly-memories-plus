import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Transport failures: missing memory on the wire, modified streaming/schema or
// response limits, duplicated injections, late tools/lore overflow, disabled
// history markers, raw-exposed blocks, cancelled/changed sources, log leaks,
// wrong summary reasoning effort in either request path, and chat effort leakage.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage();
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
let results = [];
let failure;
try {
  await page.goto(process.env.SMP_BASE_URL || 'http://127.0.0.1:8001');
  await page.waitForFunction(() => typeof sillyMemoriesPlusGenerateInterceptor === 'function');
  await page.waitForSelector('#smp-settings', { state: 'attached' });
  await page.locator('#preloader').waitFor({ state: 'hidden' });
  results = await page.evaluate(async () => {
    const script = await import('/script.js');
    const openai = await import('/scripts/openai.js');
    const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
    const c = SillyTavern.getContext();
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const structured = narrative => ({ title: 'Observatory key', narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
    c.characters.push({ name: 'Transport test', avatar: 'none', chat: 'transport-test', data: {} });
    script.setCharacterId(c.characters.length - 1);
    script.changeMainAPI('openai');
    Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', stream_openai: true, openai_max_context: 5512, openai_max_tokens: 512, squash_system_messages: false, reasoning_effort: 'medium' });
    const summaryRequests = [];
    service.getProfile = () => ({ id: 'transport-test' });
    service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (profileId, messages, maxTokens, options, payload) => {
      summaryRequests.push({ path: 'profile', effort: payload.reasoning_effort });
      if (payload.reasoning_effort !== 'low' || payload.include_reasoning !== false || options.stream !== false) throw new Error('Invalid profile summarizer reasoning settings');
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structured('Mira recovered the key.')) } }] };
    };
    const results = [];
    const nativeFetch = globalThis.fetch;
    let payloads = [];
    let stopped = 0;
    script.eventSource.on(script.event_types.GENERATION_STOPPED, () => stopped++);
    globalThis.fetch = async (url, options) => {
      if (!String(url).includes('/api/backends/chat-completions/generate')) return nativeFetch(url, options);
      options.signal?.throwIfAborted();
      const payload = JSON.parse(options.body);
      if (payload.json_schema) {
        summaryRequests.push({ path: 'main-api', effort: payload.reasoning_effort });
        if (payload.reasoning_effort !== 'low' || payload.include_reasoning !== false || payload.stream !== false) throw new Error('Invalid main-API summarizer reasoning settings');
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structured('Mira recovered the key.')) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      payloads.push(payload);
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        for (const content of ['one ', 'two ', 'three']) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    try {
      for (const scenario of ['sse', 'fallback-sse', 'raw-exposed', 'squashed-narrators', 'late-prompt', 'tools', 'too-large-preset', 'disabled-history', 'source-edited', 'memory-edited', 'facts-edited']) {
        payloads = []; stopped = 0;
        script.setExternalAbortController(new AbortController());
        c.characters.at(-1).chat = `transport-${scenario}`;
        c.chat.splice(0, c.chat.length, ...Array.from({ length: 4 }, (_, index) => ({ name: 'Mira', mes: `Source ${index}: ` + ' history'.repeat(index === 1 ? 1600 : 300), is_user: index % 2 === 0, is_system: false, extra: {} })));
        openai.oai_settings.squash_system_messages = scenario === 'squashed-narrators';
        if (scenario === 'squashed-narrators') for (const message of c.chat) message.extra.type = 'narrator';
        c.chatMetadata.silly_memories_plus = { schemaVersion: 3, pinnedFacts: 'Mira holds the key.', blocks: [{ id: 'transport-memory', level: 1, structured: structured('Rowan trusts Mira.'), sourceFrom: 0, sourceTo: 0, sourceTokens: 8000, summaryTokens: 100, status: 'active', sourceFingerprints: [], children: [], useRaw: ['raw-exposed', 'squashed-narrators'].includes(scenario) }] };
        c.extensionSettings.silly_memories_plus = core.normalizeSettings({ summaryProfileId: 'transport-test', blockTargetTokens: 256, minimumSourceTokens: 512 });
        if (scenario === 'fallback-sse') c.extensionSettings.silly_memories_plus.summaryProfileId = '';
        await script.eventSource.emit(script.event_types.CHAT_CHANGED);
        const outgoing = c.chat.map((message, index) => ({ ...message, index }));
        let aborted = false;
        await sillyMemoriesPlusGenerateInterceptor(outgoing, 5000, () => { aborted = true; }, 'normal');
        if (aborted) {
          results.push({ scenario, aborted, passed: false, requests: 0, status: document.getElementById('smp-status').textContent });
          continue;
        }
        const order = openai.promptManager.getPromptOrderForCharacter(openai.promptManager.activeCharacter);
        const history = order.find(item => item.identifier === 'chatHistory');
        const wasEnabled = history?.enabled;
        if (scenario === 'disabled-history' && history) history.enabled = false;
        const messages = outgoing.map(message => ({ role: message.extra?.type ? 'system' : message.is_user ? 'user' : 'assistant', content: message.mes, name: 'Mira' })).reverse();
        let [chat] = await openai.prepareOpenAIMessages({ name2: 'Mira', charDescription: ' header'.repeat(scenario === 'too-large-preset' ? 4700 : 800), charPersonality: '', scenario: '', worldInfoBefore: ' lore'.repeat(800), worldInfoAfter: '', bias: '', type: 'normal', quietPrompt: '', extensionPrompts: {}, cyclePrompt: '', messages, messageExamples: [] }, false);
        if (history) history.enabled = wasEnabled;
        if (scenario === 'late-prompt') chat.unshift({ role: 'system', content: ' late-lore'.repeat(800) });
        if (scenario === 'source-edited') c.chat[2].mes = 'Edited after preparation.';
        if (scenario === 'memory-edited') c.chatMetadata.silly_memories_plus.blocks[0].structured.narrative = 'Manually edited memory.';
        if (scenario === 'facts-edited') c.chatMetadata.silly_memories_plus.pinnedFacts = 'Changed pinned facts.';
        const addTools = payload => { if (scenario === 'tools') payload.tools = [{ type: 'function', function: { name: 'lookup', description: ' schema'.repeat(800), parameters: { type: 'object', properties: {} } } }]; };
        script.eventSource.on(script.event_types.CHAT_COMPLETION_SETTINGS_READY, addTools);
        // Put the guard last, as it is in the application before dispatch.
        const listeners = script.eventSource.events[script.event_types.CHAT_COMPLETION_SETTINGS_READY];
        listeners.splice(listeners.indexOf(addTools), 1); listeners.unshift(addTools);
        let output = '';
        try {
          const generator = await script.sendGenerationRequest('normal', { prompt: chat });
          for await (const chunk of generator()) output = chunk.text;
        } catch (error) {
          if (!stopped) throw error;
        } finally { script.eventSource.removeListener(script.event_types.CHAT_COMPLETION_SETTINGS_READY, addTools); }
        const sent = payloads[0];
        const body = JSON.stringify(sent?.messages || []);
        const invalid = ['too-large-preset', 'disabled-history', 'source-edited', 'memory-edited', 'facts-edited'].includes(scenario);
        results.push({ scenario, aborted, stopped, requests: payloads.length, output,
          passed: invalid ? stopped > 0 && payloads.length === 0 : !aborted && !stopped && output === 'one two three' && payloads.length === 1 && sent.stream === true && sent.max_tokens === 512 && sent.reasoning_effort !== 'low' && openai.oai_settings.reasoning_effort === 'medium' && !sent.json_schema && body.includes('Mira holds the key.') && c.chat.slice(-2).every(message => body.includes(message.mes)) && (!['raw-exposed', 'squashed-narrators'].includes(scenario) || body.includes(c.chat[0].mes)), status: document.getElementById('smp-status').textContent });
      }
    } finally { globalThis.fetch = nativeFetch; }
    for (const path of ['profile', 'main-api']) {
      const requests = summaryRequests.filter(request => request.path === path);
      results.push({ scenario: `low-reasoning-${path}`, requests: requests.length, passed: requests.length > 0 && requests.every(request => request.effort === 'low') });
    }
    return results;
  });
  for (const result of results) assert.ok(result.passed, JSON.stringify(result));
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'prompt-transport-report.json'), JSON.stringify({ results, failure, passed: !failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
