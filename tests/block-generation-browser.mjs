import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failures: lost Claude tools, oversized narrative/ledger/intermediate sources,
// soft-target rejection, failed reduction, invalid/truncated responses, unsafe
// partial saves, cancellation, chat changes and edits during generation.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
assert.ok(directory && process.env.SMP_BROWSER_EXECUTABLE);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const saves = [];
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => {
  if (!route.request().url().includes('/settings/')) saves.push(route.request().postDataJSON());
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
const results = [];
let failure;
try {
  await page.goto(process.env.SMP_BASE_URL || 'http://127.0.0.1:8001');
  await page.waitForFunction(() => typeof sillyMemoriesPlusGenerateInterceptor === 'function');
  await page.waitForSelector('#smp-settings', { state: 'attached' });
  await page.locator('#preloader').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const { getTokenCountAsync } = await import('/scripts/tokenizers.js');
    await getTokenCountAsync(' memory'.repeat(100), 0);
  });
  for (const scenario of ['baseline', 'claude-tool', 'fallback-claude', 'oversized-narrative', 'oversized-ledger', 'oversized-intermediate', 'soft-target', 'soft-overflow', 'reduce-failure', 'truncated', 'invalid-tool', 'partial-merge-failure', 'partial-overflow', 'partial-cancel', 'partial-chat-change', 'cancel', 'chat-change', 'source-edit']) {
    const saveStart = saves.length;
    const result = await page.evaluate(async scenario => {
      const context = SillyTavern.getContext();
      const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
      const script = await import('/script.js');
      const openai = await import('/scripts/openai.js');
      const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
      const { getTokenCountAsync } = await import('/scripts/tokenizers.js');
      const key = 'silly_memories_plus';
      const original = { chat: [...context.chat], memory: context.chatMetadata[key], settings: context.extensionSettings[key], characterId: context.characterId, getProfile: service.getProfile, validateProfile: service.validateProfile, sendRequest: service.sendRequest, fetch: globalThis.fetch, api: script.main_api, openai: structuredClone(openai.oai_settings) };
      const structured = narrative => ({ title: 'The observatory key', narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
      const text = count => ' memory'.repeat(count);
      const calls = [];
      const expected = {};
      const captured = {};
      let aborted = false;
      let fallbackSchema = false;
      try {
        context.characters.push({ name: 'Block test', avatar: 'none', chat: 'block-e2e', data: {} });
        script.setCharacterId(context.characters.length - 1);
        context.extensionSettings[key] = core.normalizeSettings({ summaryProfileId: 'block-e2e', blockTargetTokens: 1024, summaryMaxOutputTokens: scenario === 'oversized-intermediate' ? 4096 : 2048, summaryInputBudgetTokens: scenario.startsWith('oversized') ? 8192 : 50000 });
        const stored = (scenario === 'oversized-intermediate' ? [1500, 1500, 1000, 1000] : [12000, 12000, 1000, 1000]).map((size, index) => ({ name: 'Mira', mes: text(size), is_user: index % 2 === 0, is_system: false, extra: {} }));
        context.chat.splice(0, context.chat.length, ...stored);
        context.chatMetadata[key] = core.createEmptyMemory();
        let budget = scenario === 'soft-overflow' ? 3200 : scenario === 'oversized-intermediate' ? 6000 : 30000;
        if (scenario === 'oversized-narrative' || scenario === 'oversized-ledger') {
          context.chatMetadata[key].blocks = [0, 1].map(index => {
            const content = `BEGIN-${index}` + (scenario === 'oversized-ledger' ? ' "quoted"\\line\n'.repeat(1600) : text(6500)) + `END-${index}`;
            expected[index] = content;
            const data = structured(scenario === 'oversized-ledger' ? 'The key changed hands.' : content);
            if (scenario === 'oversized-ledger') data.importantItems = [content];
            return { id: `block-${index}`, level: 1, structured: data, sourceFrom: index, sourceTo: index, sourceTokens: 13000, rawTokens: 13000, summaryTokens: 6500, sourceFingerprints: [], children: [], status: 'active' };
          });
          stored[0].mes = stored[1].mes = 'Covered history.';
          budget = 16000;
        }
        if (scenario.startsWith('partial')) {
          const sizes = scenario === 'partial-overflow' ? [2400, 2400, 10, 2400, 2400] : Array(14).fill(4180);
          context.extensionSettings[key] = core.normalizeSettings({ summaryProfileId: 'block-e2e', blockTargetTokens: scenario === 'partial-overflow' ? 1000 : 4000, summaryMaxOutputTokens: 8192, summaryInputBudgetTokens: 1000000 });
          const blocks = sizes.map((size, index) => ({ id: `block-${index}`, level: 1, structured: structured(text(size)), sourceFrom: index, sourceTo: index, sourceTokens: size * 4, rawTokens: index === 2 ? 14500 : size * 4, summaryTokens: size, sourceFingerprints: [], children: [], status: 'active', useRaw: scenario === 'partial-overflow' && index === 2 }));
          context.chatMetadata[key].blocks = blocks;
          stored.splice(0, stored.length, ...sizes.map((_, index) => ({ name: 'Mira', mes: text(scenario === 'partial-overflow' && index === 2 ? 14500 : 20), is_user: true, is_system: false, extra: {} })), ...(scenario === 'partial-overflow' ? [7000, 7000] : [8000, 6000, 6000]).map(size => ({ name: 'Mira', mes: text(size), is_user: false, is_system: false, extra: {} })));
          context.chat.splice(0, context.chat.length, ...stored);
          budget = scenario === 'partial-overflow' ? 30000 : 80000;
        }
        const initialCount = context.chatMetadata[key].blocks.length;
        service.getProfile = () => ({ id: 'block-e2e' });
        service.validateProfile = () => ({ selected: 'openai' });
        service.sendRequest = async (profile, messages, maxTokens, options) => {
          const inputTokens = await getTokenCountAsync(messages[0].content, 0) + await getTokenCountAsync(messages[1].content, 0) + maxTokens + 512;
          calls.push({ maxTokens, inputTokens, stream: options.stream });
          if (['partial-merge-failure', 'partial-overflow', 'reduce-failure'].includes(scenario) && calls.length === 2) throw new Error('Synthetic downstream failure');
          if (scenario === 'cancel' || scenario === 'partial-cancel' && calls.length === 2) document.getElementById('smp-cancel').click();
          if (scenario === 'chat-change' || scenario === 'partial-chat-change' && calls.length === 2) context.characters.at(-1).chat = 'another-e2e-chat';
          if (scenario === 'source-edit') context.chat[0].mes = 'Edited while the request was running.';
          const sources = JSON.parse(messages[1].content);
          if (scenario === 'oversized-narrative' || scenario === 'oversized-ledger') for (const source of sources) {
            if (!source.source) continue;
            const index = source.source[0];
            const value = scenario === 'oversized-ledger' ? source.structured?.importantItems?.join('') : source.structured?.narrative;
            if (value) captured[index] = (captured[index] || '') + value;
          }
          if (scenario === 'truncated') return { choices: [{ finish_reason: 'length', message: { content: '{"narrative":"unfinished' } }] };
          const data = structured(['soft-target', 'soft-overflow', 'reduce-failure'].includes(scenario) ? text(1200) : scenario === 'oversized-intermediate' && calls.length <= 7 ? text(1200) : scenario.startsWith('partial') ? text(250) : 'Mira recovered the observatory key.');
          if (['claude-tool', 'fallback-claude', 'invalid-tool'].includes(scenario)) return { choices: [{ message: { content: '' } }], content: [{ type: 'tool_use', name: core.SUMMARY_JSON_SCHEMA.name, input: scenario === 'invalid-tool' ? {} : data }] };
          return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] };
        };
        if (scenario === 'fallback-claude') {
          script.changeMainAPI('openai');
          openai.oai_settings.chat_completion_source = 'claude';
          context.extensionSettings[key].summaryProfileId = '';
          globalThis.fetch = async (url, options) => {
            if (String(url).includes('/api/backends/chat-completions/generate')) {
              const payload = JSON.parse(options.body);
              fallbackSchema = payload.json_schema?.name === core.SUMMARY_JSON_SCHEMA.name;
              const response = await service.sendRequest('', payload.messages, payload.max_tokens, { stream: payload.stream });
              return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return original.fetch(url, options);
          };
        }
        const outgoing = stored.map((message, index) => ({ ...message, index, extra: { ...message.extra } }));
        await sillyMemoriesPlusGenerateInterceptor(outgoing, budget, () => { aborted = true; }, 'normal');
        const memory = context.chatMetadata[key];
        const active = core.getActiveBlocks(memory);
        const outgoingTokens = (await Promise.all(outgoing.map(message => getTokenCountAsync(message.mes, 0)))).reduce((a, b) => a + b, 0);
        const status = document.getElementById('smp-status');
        return { scenario, calls, aborted, initialCount, fallbackSchema, savedCount: memory.blocks.length, active: active.map(block => ({ id: block.id, from: block.sourceFrom, to: block.sourceTo, level: block.level, tokens: block.summaryTokens })), status: status.textContent, outgoingTokens, budget, inputBudget: context.extensionSettings[key].summaryInputBudgetTokens, sourcesPreserved: Object.keys(expected).every(index => expected[index] === captured[index]), tailPreserved: outgoing.slice(-2).every((message, index) => message.mes === stored.at(-2 + index).mes), storedUnchanged: scenario === 'source-edit' || JSON.stringify(context.chat) === JSON.stringify(stored) };
      } finally {
        service.getProfile = original.getProfile;
        service.validateProfile = original.validateProfile;
        service.sendRequest = original.sendRequest;
        globalThis.fetch = original.fetch;
        if (scenario === 'fallback-claude') {
          Object.assign(openai.oai_settings, original.openai);
          script.changeMainAPI(original.api);
        }
        context.chat.splice(0, context.chat.length, ...original.chat);
        context.chatMetadata[key] = original.memory;
        context.extensionSettings[key] = original.settings;
        script.setCharacterId(original.characterId);
        context.characters.pop();
      }
    }, scenario);
    result.savedRequests = saves.slice(saveStart).map(data => ({ chat: data.file_name,
      blocks: data.chat?.[0]?.chat_metadata?.silly_memories_plus?.blocks?.map(block => ({ id: block.id, status: block.status })) || [] }));
    results.push(result);
    console.log(`${scenario}: ${result.savedCount} block(s), ${result.calls.length} request(s), ${result.status}`);
  }
  for (const result of results) {
    const rejected = ['truncated', 'invalid-tool', 'cancel', 'chat-change', 'source-edit'].includes(result.scenario);
    assert.ok(result.storedUnchanged, `${result.scenario}: saved transcript changed`);
    assert.ok(result.calls.every(call => call.stream === false && call.inputTokens <= result.inputBudget), `${result.scenario}: request exceeds budget or streams`);
    if (rejected) assert.equal(result.savedCount, 0, `${result.scenario}: unsafe block saved`);
    else if (result.scenario.startsWith('partial')) assert.ok(result.active.some(block => !block.id.startsWith('block-')), `${result.scenario}: valid progress lost`);
    else assert.ok(result.active.length > 0 && result.active.every(block => !block.id.startsWith('block-')), `${result.scenario}: generation did not finish`);
    if (result.scenario.startsWith('partial')) assert.equal(result.calls.length, 2, `${result.scenario}: downstream stage was not exercised`);
    if (!rejected) assert.ok(result.savedRequests.some(request => request.blocks.some(block => !block.id.startsWith('block-'))), `${result.scenario}: completed block not sent for persistence`);
    if (rejected) assert.equal(result.savedRequests.length, 0, `${result.scenario}: unsafe save request`);
    if (result.scenario === 'partial-chat-change') assert.ok(result.savedRequests.every(request => request.chat === 'block-e2e'), 'block was written to another chat');
    if (result.scenario === 'fallback-claude') assert.ok(result.fallbackSchema, 'fallback request has no schema');
    if (result.scenario === 'partial-overflow') assert.ok(result.status.includes('Synthetic downstream failure'), 'provider failure was hidden');
    assert.equal(result.aborted, ['cancel', 'chat-change', 'source-edit', 'partial-overflow', 'partial-cancel', 'partial-chat-change', 'soft-overflow'].includes(result.scenario), `${result.scenario}: incorrect abort`);
    if (!result.aborted) assert.ok(result.outgoingTokens <= result.budget && result.tailPreserved, `${result.scenario}: unsafe context rewrite`);
    assert.ok(result.sourcesPreserved, `${result.scenario}: split source lost text`);
  }
} catch (error) {
  failure = String(error.stack || error);
} finally {
  await writeFile(resolve(directory, 'block-generation-report.json'), JSON.stringify({ results, failure, passed: !failure }, null, 2));
  await page.screenshot({ path: resolve(directory, 'block-generation.png'), fullPage: true }).catch(() => {});
  await browser.close();
}
if (failure) throw new Error(failure);
console.log(`Block generation checks passed (${results.length} scenarios). Artifacts: ${directory}`);
