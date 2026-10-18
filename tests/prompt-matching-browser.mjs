import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure matrix, before the matcher implementation:
// - final-event whitespace/comment cleanup blocks intact history or inflates Other;
// - a copied payload loses ownership; native duplicate messages steal each other;
// - injections masquerade as history, reordered/ambiguous candidates are accepted;
// - deleted words, visible HTML, role changes or entirely removed replies pass;
// - memory/facts are silently normalized; unclosed comments hide narrative loss;
// - literal comments or significant indentation disappear inside code examples;
// - replacement leaves covered raw history or strips lore/media/tool fields;
// - late compaction summarizes a different body than the request contains;
// - a large damaged reply is compacted instead of blocked, including copied data;
// - transport-only changes break SSE or skip validation; passive counts differ;
// - matching changes stored text/fingerprints, evaluates macros again, or leaks text.
// Presence-mode failures: changed text/code is rejected despite proven identity;
// missing/reordered messages or corrupted memory pass; a merged history match
// consumes preset/lore; copied history changes lose bounded association; passive
// counts charge changed history to Other; strict mode loses its content checks.
const validation = process.env.SMP_MESSAGE_VALIDATION || 'content';
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
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
  await page.evaluate(async validation => {
    const script = await import('/script.js');
    const openai = await import('/scripts/openai.js');
    const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
    const identity = await import('/scripts/extensions/third-party/silly-memories-plus/lib/source-identity.mjs');
    const diagnostics = await import('/scripts/extensions/third-party/silly-memories-plus/lib/diagnostics.mjs');
    const { countTokensOpenAIAsync, getTokenCountAsync } = await import('/scripts/tokenizers.js');
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const c = SillyTavern.getContext();
    c.characters.push({ name: 'Mira', avatar: 'none', chat: 'matching', description: 'An archivist.', data: { name: 'Mira', description: 'An archivist.', extensions: {} } });
    script.setCharacterId(c.characters.length - 1); script.setCharacterName('Mira'); script.changeMainAPI('openai');
    openai.promptManager.activeCharacter = { id: openai.promptManager.configuration.promptOrder.dummyId };
    const structured = narrative => ({ title: 'Observatory', narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
    globalThis.pm = { validation, script, openai, core, identity, diagnostics, c, serial: 0, requests: [], calls: [], stops: 0, mutation: null, transport: null, passive: null, structured, countTokensOpenAIAsync, getTokenCountAsync };
    pm.memoryState = () => JSON.stringify({ facts: c.chatMetadata.silly_memories_plus.pinnedFacts,
      blocks: c.chatMetadata.silly_memories_plus.blocks.map(({ id, status, sourceFrom, sourceTo, sourceHash, children, structured }) => ({ id, status, sourceFrom, sourceTo, sourceHash, children, structured })) });
    service.getProfile = () => ({ id: 'matching-test' }); service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (_, messages) => {
      pm.calls.push(structuredClone(messages));
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structured('MATCH-SUMMARY: Mira keeps the key.')) } }] };
    };
    const fetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (!String(url).includes('/api/backends/chat-completions/generate')) return fetch.call(globalThis, url, options);
      options.signal?.throwIfAborted();
      pm.requests.push(JSON.parse(options.body));
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        for (const content of ['matched ', 'stream']) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    script.eventSource.on(script.event_types.GENERATION_STOPPED, () => pm.stops++);
    const mutate = data => { if (data.dryRun ? pm.passive : pm.mutation) (data.dryRun ? pm.passive : pm.mutation)(data); };
    script.eventSource.on(script.event_types.GENERATION_STARTED, () => script.eventSource.makeFirst(script.event_types.CHAT_COMPLETION_PROMPT_READY, mutate));
    const mutateTransport = data => { if (pm.transport) pm.transport(data); };
    script.eventSource.on(script.event_types.CHAT_COMPLETION_SETTINGS_READY, mutateTransport);
    const listeners = script.eventSource.events[script.event_types.CHAT_COMPLETION_SETTINGS_READY];
    listeners.splice(listeners.indexOf(mutateTransport), 1); listeners.unshift(mutateTransport);
    pm.clean = text => text.replace(/\s*<!--[\s\S]*?-->/g, '').replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n').trim();
    pm.reset = async (scenario, budget = 16000) => {
      document.body.dataset.generating = 'matching-e2e';
      await script.eventSource.emit(script.event_types.GENERATION_ENDED);
      script.activateSendButtons(); script.setExternalAbortController(new AbortController());
      c.characters.at(-1).chat = `matching-${++pm.serial}`;
      const texts = ['PRIVATE-COVERED: The observatory opened.\n\n<!-- META old -->', 'PRIVATE-ANCHOR: What did Mira find?', '\n\nPRIVATE-STORY: Mira kept the brass key.\n\n\n\n\n\nRowan waited.\n\n<!-- META clock=09:30 place=observatory -->\n\n', 'PRIVATE-QUESTION: What happens next?', 'PRIVATE-RECENT: Rowan opened the door.', 'PRIVATE-LATEST: Continue.'];
      if (scenario === 'duplicates') texts[4] = texts[2];
      if (scenario === 'consecutive') texts[3] = texts[2].replace('Mira kept', 'Mira carried');
      if (scenario === 'native-impostor') { texts[0] = texts[2]; texts[2] = 'PRIVATE-OTHER: A distinct reply.'; }
      if (scenario === 'late-compaction' || scenario.startsWith('long-loss')) texts[2] = texts[2].replace('Rowan waited.', 'Rowan waited. ' + ' brass-key-event'.repeat(2000));
      if (scenario === 'unclosed-comment') texts[2] = 'PRIVATE-STORY: Mira kept the key.\n<!-- unfinished metadata and actual story';
      if (scenario === 'code-comment') texts[2] = 'PRIVATE-STORY: Preserve this example.\n```html\n<!-- literal value -->\n```';
      if (scenario === 'code-space') texts[2] = 'PRIVATE-STORY: Preserve this code.\n```python\nif True:\n    return key\n```';
      c.chat.splice(0, c.chat.length, ...texts.map((mes, index) => ({ name: index % 2 ? 'User' : 'Mira', mes, is_user: Boolean(index % 2), extra: {}, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }] })));
      if (scenario === 'consecutive') { c.chat[3].is_user = false; c.chat[3].name = 'Mira'; }
      if (scenario === 'visible-html') c.chat[2].mes += '<strong>Never surrender the key.</strong>';
      c.chatMetadata.silly_memories_plus = core.createEmptyMemory(); c.chatMetadata.variables = {};
      c.extensionSettings.regex = [];
      c.extensionSettings.silly_memories_plus = core.normalizeSettings({ messageValidation: validation, debug: true, language: 'en', summaryProfileId: 'matching-test', blockTargetTokens: 256, minimumSourceTokens: 512 });
      Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', openai_max_context: budget + 512, openai_max_tokens: 512, names_behavior: 0, squash_system_messages: scenario.startsWith('squashed'), stream_openai: true });
      if (scenario.startsWith('squashed')) for (const m of c.chat) m.extra.type = 'narrator';
      if (scenario === 'native-impostor') c.chat[0].extra.type = 'narrator';
      const fingerprints = c.chat.slice(0, 1).map((m, index) => identity.fingerprintMessage({ ...m, index }));
      c.chatMetadata.silly_memories_plus.blocks = [{ id: 'matching-block', level: 1, status: 'active', children: [], structured: structured('PRIVATE-MEMORY: The observatory opened.'), sourceFrom: 0, sourceTo: 0, sourceTokens: 1000, summaryTokens: 100, sourceFingerprints: fingerprints, sourceHash: identity.buildSourceHash(fingerprints), createdAt: 1 }];
      if (scenario === 'native-impostor') c.chatMetadata.silly_memories_plus.blocks = [];
      if (scenario === 'facts-changed') c.chatMetadata.silly_memories_plus.pinnedFacts = 'PRIVATE-FACT: Keep the key.\n\n';
      pm.calls = []; pm.requests = []; pm.stops = 0; pm.mutation = null; pm.transport = null; pm.passive = null;
      await script.eventSource.emit(script.event_types.CHAT_CHANGED);
      pm.original = JSON.stringify(c.chat);
      pm.memoryOriginal = pm.memoryState();
    };
    pm.build = async (budget = 16000) => {
      await script.eventSource.emit(script.event_types.GENERATION_STARTED, 'normal', {}, false);
      const outgoing = c.chat.map((m, index) => ({ ...m, index, extra: { ...m.extra } }));
      let aborted = false;
      await sillyMemoriesPlusGenerateInterceptor(outgoing, budget, () => { aborted = true; }, 'normal');
      if (aborted) return { chat: [], aborted };
      const quoted = c.chat[0].extra.type === 'narrator' && !openai.oai_settings.squash_system_messages ? ` Quoted example: ${c.chat[0].mes}` : '';
      const [chat] = await openai.prepareOpenAIMessages({ name2: 'Mira', charDescription: 'PRIVATE-PRESET An archivist.' + quoted, charPersonality: '', scenario: '', worldInfoBefore: 'PRIVATE-LORE The tower is locked.', worldInfoAfter: '', bias: '', type: 'normal', quietPrompt: '', extensionPrompts: {}, cyclePrompt: '', systemPromptOverride: '', jailbreakPromptOverride: '', messages: openai.setOpenAIMessages(outgoing), messageExamples: [] }, false);
      return { chat, aborted };
    };
  }, validation);
  const scenarios = ['unchanged', 'line-runs', 'edge-space', 'comments', 'combined', 'copied', 'consecutive', 'duplicates', 'media-tools', 'squashed', 'transport-only', 'late-compaction', 'words-deleted', 'words-replaced', 'visible-html', 'role-changed', 'removed', 'reordered', 'ambiguous', 'unclosed-comment', 'memory-changed', 'facts-changed', 'native-impostor', 'code-comment', 'code-space', 'long-loss', 'long-loss-copied', 'squashed-memory-changed'];
  if (validation === 'presence') scenarios.push('rewrite', 'rewrite-copied', 'squashed-rewrite', 'transport-rewrite');
  for (const scenario of scenarios.filter(scenario => !process.env.SMP_SCENARIOS || process.env.SMP_SCENARIOS.split(',').includes(scenario))) {
    const result = await page.evaluate(async scenario => {
      const budget = scenario === 'late-compaction' ? 12000 : 16000;
      await pm.reset(scenario, budget);
      const blocked = ['role-changed', 'removed', 'reordered', 'ambiguous', 'native-impostor', 'squashed-memory-changed'].includes(scenario)
        || pm.validation === 'content' && (['words-deleted', 'words-replaced', 'visible-html', 'unclosed-comment', 'code-comment', 'code-space'].includes(scenario) || scenario.startsWith('long-loss'));
      const modify = data => {
        const list = data.chat || data.messages;
        let at = list.findIndex(m => typeof m.content === 'string' && m.content.includes('PRIVATE-STORY:'));
        if (scenario.endsWith('memory-changed')) at = list.findIndex(m => typeof m.content === 'string' && m.content.includes('PRIVATE-MEMORY:'));
        if (scenario === 'facts-changed') at = list.findIndex(m => typeof m.content === 'string' && m.content.includes('PRIVATE-FACT:'));
        if (at < 0) return;
        const message = list[at];
        if (['rewrite', 'rewrite-copied', 'transport-rewrite'].includes(scenario)) {
          message.content = 'PRIVATE-REWRITTEN: A replacement by another extension.';
          if (scenario === 'rewrite-copied') list.splice(0, list.length, ...structuredClone(list));
        }
        else if (scenario === 'squashed-rewrite') message.content = message.content.replace('Mira kept the brass key.', 'Mira returned the key to Rowan.');
        else if (scenario === 'line-runs') message.content = message.content.replace(/\n{3,}/g, '\n\n');
        else if (scenario === 'edge-space') message.content = message.content.trim();
        else if (scenario === 'comments') message.content = message.content.replace(/\s*<!--[\s\S]*?-->/g, '');
        else if (scenario === 'words-deleted') message.content = message.content.replace('brass key', '');
        else if (scenario.startsWith('long-loss')) {
          message.content = message.content.replace('kept', 'destroyed');
          if (scenario.endsWith('copied')) list.splice(0, list.length, ...structuredClone(list));
        }
        else if (scenario === 'words-replaced') message.content = message.content.replace('kept', 'destroyed');
        else if (scenario === 'visible-html') message.content = message.content.replace(/<strong>[\s\S]*?<\/strong>/g, '');
        else if (scenario === 'role-changed') message.role = 'user';
        else if (scenario === 'removed' || scenario === 'native-impostor') {
          if (scenario === 'native-impostor') at = list.findIndex(m => typeof m.content === 'string' && m.content === pm.c.chat[0].mes);
          list.splice(at, 1);
        }
        else if (scenario === 'reordered') [list[at], list[at + 2]] = [list[at + 2], list[at]];
        else if (scenario === 'ambiguous') list.splice(at, 1, { ...message, content: pm.clean(message.content) }, { ...message, content: pm.clean(message.content) });
        else if (scenario === 'unclosed-comment') message.content = message.content.slice(0, message.content.indexOf('<!--')).trim();
        else if (scenario === 'code-comment') message.content = message.content.replace(/<!--[\s\S]*?-->/g, '');
        else if (scenario === 'code-space') message.content = message.content.replace('    return', ' return');
        else if (scenario === 'squashed') message.content = message.content.replace(/\n{3,}/g, '\n\n').replace(/\s*<!-- META[\s\S]*?-->/g, '');
        else if (scenario.endsWith('memory-changed')) message.content = message.content.replace('PRIVATE-MEMORY: The observatory', 'PRIVATE-MEMORY: The tower');
        else if (scenario === 'facts-changed') message.content = message.content.replace(/\n+/g, ' ');
        else if (scenario !== 'unchanged') {
          for (const m of list) if (typeof m.content === 'string' && !m.content.includes('memory_block')) m.content = pm.clean(m.content);
        }
        if (scenario === 'copied') list.splice(0, list.length, ...structuredClone(list));
        if (scenario === 'media-tools') {
          const m = list.find(m => m.content?.includes?.('PRIVATE-STORY:'));
          m.content = [{ type: 'text', text: m.content }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'low' } }];
          m.signature = 'PRIVATE-SIGNATURE';
          m.tool_calls = [{ id: 'matching-tool', type: 'function', function: { name: 'inspect', arguments: '{}' } }];
          list.splice(list.indexOf(m) + 1, 0, { role: 'tool', tool_call_id: 'matching-tool', content: 'PRIVATE-TOOL-RESULT' });
        }
        if (scenario === 'late-compaction') list.unshift({ role: 'system', content: 'PRIVATE-LATE-LORE ' + ' lore-token'.repeat(3200) });
        if (!blocked) list.splice(1, 0, { role: 'system', content: 'PRIVATE-INJECTION Preserve this.' });
      };
      if (!['transport-only', 'transport-rewrite'].includes(scenario)) pm.mutation = modify;
      else pm.transport = modify;
      const built = await pm.build(budget);
      let output = '', error = null;
      if (!pm.stops && !built.aborted) try {
        const generator = await pm.script.sendGenerationRequest('normal', { prompt: built.chat });
        for await (const chunk of generator()) output = chunk.text;
      } catch (e) { error = e.name; }
      const events = pm.diagnostics.exportDiagnostics(pm.c.extensionSettings.silly_memories_plus, null).events;
      const requestId = events.filter(e => e.type === 'plan' && e.phase === 'normal').at(-1)?.requestId;
      const own = events.filter(e => e.requestId === requestId);
      const sent = pm.requests.at(-1);
      const body = JSON.stringify(sent?.messages || []);
      const unchangedSource = JSON.stringify(pm.c.chat) === pm.original;
      const checks = {
        dispatched: pm.requests.length === 1 && output === 'matched stream' && !pm.stops,
        blocked: pm.requests.length === 0 && pm.stops > 0 && own.some(e => e.type === 'prompt-blocked'),
        noUnsafeCompaction: !blocked || !scenario.startsWith('long-loss') || pm.calls.length === 0 && pm.memoryState() === pm.memoryOriginal,
        impostor: scenario !== 'native-impostor' || own.some(e => e.type === 'prompt-blocked' && e.missing?.some(m => m.index === 0)),
        storedUnchanged: unchangedSource,
        preset: body.includes('PRIVATE-PRESET') && body.includes('PRIVATE-LORE'),
        injection: scenario === 'unchanged' || body.includes('PRIVATE-INJECTION'),
        memory: body.includes('PRIVATE-MEMORY:') || body.includes('MATCH-SUMMARY:'),
        syntheticStrict: scenario !== 'memory-changed' && scenario !== 'facts-changed' || !body.includes('PRIVATE-MEMORY: The tower opened.') && (scenario !== 'facts-changed' || sent.messages.some(m => m.content.includes('PRIVATE-FACT: Keep the key.'))),
        tail: body.includes('PRIVATE-LATEST:'),
        stream: sent?.stream === true && sent?.max_tokens === 512 && !sent?.json_schema,
        media: scenario !== 'media-tools' || body.includes('data:image/png;base64,AA==') && body.includes('PRIVATE-SIGNATURE') && body.includes('matching-tool') && body.includes('PRIVATE-TOOL-RESULT'),
        compacted: scenario !== 'late-compaction' || pm.calls.length > 0 && pm.calls.some(messages => messages.some(m => m.content.includes('brass-key-event'))) && !body.includes('brass-key-event'),
        covered: !body.includes('PRIVATE-COVERED:'),
      };
      return { scenario, passed: checks.storedUnchanged && (blocked ? checks.blocked && checks.noUnsafeCompaction : Object.entries(checks).every(([key, value]) => key === 'blocked' || value)), checks, stops: pm.stops, requests: pm.requests.length, calls: pm.calls.length, error, events: own };
    }, scenario);
    results.push(result);
  }
  const passive = await page.evaluate(async () => {
    await pm.reset('passive');
    pm.passive = data => { for (const m of data.chat) if (typeof m.content === 'string') m.content = pm.clean(m.content); };
    delete document.body.dataset.generating;
    await pm.script.eventSource.emit(pm.script.event_types.SETTINGS_UPDATED);
    return pm.serial;
  });
  await page.waitForFunction(() => pm.diagnostics.exportDiagnostics(pm.c.extensionSettings.silly_memories_plus, null).events.some(e => e.type === 'prompt-estimate' && e.phase === 'passive' && e.expected === 6));
  const passiveResult = await page.evaluate(() => {
    const events = pm.diagnostics.exportDiagnostics(pm.c.extensionSettings.silly_memories_plus, null).events;
    const measured = events.filter(e => e.type === 'prompt-estimate' && e.phase === 'passive').at(-1);
    return { passed: measured.included === measured.expected && !measured.missing.length && JSON.stringify(pm.c.chat) === pm.original && pm.requests.length === 0, measured };
  });
  results.push({ scenario: `passive-${passive}`, ...passiveResult });
  const badChat = await page.evaluate(async () => {
    await pm.reset('passive-damaged');
    pm.passive = data => { const m = data.chat.find(m => m.content?.includes?.('PRIVATE-STORY:')); m.content = m.content.replace('kept', 'destroyed'); };
    delete document.body.dataset.generating;
    await pm.script.eventSource.emit(pm.script.event_types.SETTINGS_UPDATED);
    return pm.diagnostics.exportDiagnostics(pm.c.extensionSettings.silly_memories_plus, null).events.filter(e => e.type === 'chat-changed').at(-1).chat;
  });
  await page.waitForFunction(chat => pm.diagnostics.exportDiagnostics(pm.c.extensionSettings.silly_memories_plus, null).events.some(e => e.chat === chat && ['prompt-estimate', 'prompt-estimate-rejected'].includes(e.type)), badChat);
  const damaged = await page.evaluate(chat => {
    const own = pm.diagnostics.exportDiagnostics(pm.c.extensionSettings.silly_memories_plus, null).events.filter(e => e.chat === chat);
    const measured = own.find(e => e.type === 'prompt-estimate');
    return { passed: (pm.validation === 'presence' ? measured?.included === measured?.expected && Boolean(measured) : own.some(e => e.type === 'prompt-estimate-rejected' && e.messages?.some(m => m.index === 2)) && !measured) && pm.calls.length === 0 && pm.requests.length === 0 && pm.memoryState() === pm.memoryOriginal, events: own };
  }, badChat);
  results.push({ scenario: 'passive-damaged-is-not-fixed-overhead', ...damaged });
  const exported = await page.evaluate(() => pm.diagnostics.exportDiagnostics(pm.c.extensionSettings.silly_memories_plus, null));
  await writeFile(resolve(directory, 'downloaded-logs.json'), JSON.stringify(exported, null, 2));
  results.push({ scenario: 'logs-private', passed: !JSON.stringify(exported).includes('PRIVATE-') });
  await page.screenshot({ path: resolve(directory, 'context.png') });
  assert.ok(results.every(result => result.passed), `Failed: ${results.filter(result => !result.passed).map(result => result.scenario).join(', ')}`);
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'prompt-matching-report.json'), JSON.stringify({ results, failure, passed: !failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results: results.map(({ events, measured, ...result }) => result), failure }, null, 2));
if (failure) throw new Error(failure);
