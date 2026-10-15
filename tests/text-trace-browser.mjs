import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure matrix before implementation: four removed edge newlines unclassified;
// changed words leaked into logs; CRLF confused with deletion; native macro/input
// and final-event changes attributed to the same stage; duplicate candidates
// reported as certain; diagnostics changing validation, payloads or macro runs;
// absent transport/passive traces; debug-off tracing; cross-request identity loss.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
await page.route(/\/api\/backends\/.+\/generate/, route => route.abort());
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
    const diagnostics = await import('/scripts/extensions/third-party/silly-memories-plus/lib/diagnostics.mjs');
    const { getRegexedString } = await import('/scripts/extensions/regex/engine.js');
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const c = SillyTavern.getContext();
    c.characters.push({ name: 'Mira', avatar: 'none', chat: 'trace', data: {} });
    script.setCharacterId(c.characters.length - 1); script.setCharacterName('Mira'); script.changeMainAPI('openai');
    openai.promptManager.activeCharacter = { id: openai.promptManager.configuration.promptOrder.dummyId };
    globalThis.tt = { script, openai, core, diagnostics, c, serial: 0, mutate: null, prepareMode: null };
    const prepare = openai.promptManager.preparePrompt;
    openai.promptManager.preparePrompt = function (prompt, ...args) {
      if (/^chatHistory-/.test(prompt.identifier)) tt.nativeCalls++;
      if (tt.prepareMode === 'input-trim' && /^chatHistory-/.test(prompt.identifier) && prompt.role === 'assistant') prompt = { ...prompt, content: prompt.content.trim() };
      return prepare.call(this, prompt, ...args);
    };
    const mutateEvent = data => { if (tt.mutate) tt.mutate(data); };
    script.eventSource.on(script.event_types.GENERATION_STARTED, () => script.eventSource.makeFirst(script.event_types.CHAT_COMPLETION_PROMPT_READY, mutateEvent));
    tt.reset = async (debug = true) => {
      await script.eventSource.emit(script.event_types.GENERATION_ENDED);
      c.characters.at(-1).chat = `trace-${++tt.serial}`;
      c.chat.splice(0, c.chat.length, ...['First', 'Question', '\n\nPRIVATE-TRACE-ANSWER\n\n', 'Latest'].map((mes, index) => ({ name: index % 2 ? 'User' : 'Mira', mes, is_user: Boolean(index % 2), extra: {}, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }] })));
      c.chatMetadata.silly_memories_plus = core.createEmptyMemory(); c.chatMetadata.variables = {};
      c.extensionSettings.silly_memories_plus = core.normalizeSettings({ debug, language: 'en' });
      Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', openai_max_context: 8512, openai_max_tokens: 512, names_behavior: 0, squash_system_messages: false });
      tt.mutate = null; tt.prepareMode = null; tt.nativeCalls = 0; c.extensionSettings.regex = [];
      await script.eventSource.emit(script.event_types.CHAT_CHANGED);
      // These synthetic foreground calls bypass Generate's button lifecycle.
      document.body.dataset.generating = 'text-trace-audit';
    };
    tt.build = async () => {
      script.setExternalAbortController(new AbortController());
      await script.eventSource.emit(script.event_types.GENERATION_STARTED, 'normal', {}, false);
      const outgoing = c.chat.map((message, index) => ({ ...message, index,
        mes: getRegexedString(message.mes, message.is_user ? 1 : 2, { isPrompt: true, depth: c.chat.length - index - 1 }) }));
      await sillyMemoriesPlusGenerateInterceptor(outgoing, 8000, () => {}, 'normal');
      const [chat] = await openai.prepareOpenAIMessages({ name2: 'Mira', charDescription: 'PRIVATE-TRACE-PRESET', charPersonality: '', scenario: '', worldInfoBefore: '', worldInfoAfter: '', bias: '', type: 'normal', quietPrompt: '', extensionPrompts: {}, cyclePrompt: '', systemPromptOverride: '', jailbreakPromptOverride: '', messages: openai.setOpenAIMessages(outgoing), messageExamples: [] }, false);
      const events = diagnostics.exportDiagnostics(c.extensionSettings.silly_memories_plus, null).events;
      const requestId = events.filter(event => event.type === 'plan' && event.phase === 'normal').at(-1).requestId;
      return { chat, requestId, events: events.filter(event => event.requestId === requestId) };
    };
  });
  const check = (name, value, details) => { results.push({ name, passed: Boolean(value), details }); assert.ok(value, name); };
  const unchanged = await page.evaluate(async () => { await tt.reset(); return tt.build(); });
  check('trace-records-native-stages-without-changing-payload', unchanged.events.some(e => e.type === 'text-trace') && unchanged.chat.some(m => m.content === '\n\nPRIVATE-TRACE-ANSWER\n\n') && !unchanged.events.some(e => e.type === 'prompt-blocked'));
  const edge = await page.evaluate(async () => {
    await tt.reset(); tt.mutate = data => { for (const m of data.chat) if (m.role === 'assistant' && typeof m.content === 'string') m.content = m.content.trim(); };
    return tt.build();
  });
  const edgeRows = edge.events.filter(e => e.type === 'text-trace').flatMap(e => e.messages || []);
  check('four-newlines-identified-at-assembled-stage', edgeRows.some(row => row.index === 2 && row.changes?.some(c => c.to === 'assembled-prompt' && c.kind === 'edge-whitespace' && c.deltaChars === -4 && c.removed?.whitespace === '\\n\\n\\n\\n' && c.edges.before.leading.whitespace === '\\n\\n' && c.edges.before.trailing.whitespace === '\\n\\n')), edgeRows);
  check('diagnostics-do-not-relax-missing-history-guard', edge.events.some(e => e.type === 'prompt-blocked'));
  const input = await page.evaluate(async () => { await tt.reset(); tt.prepareMode = 'input-trim'; return tt.build(); });
  check('native-input-trim-distinguished-from-final-event', input.events.filter(e => e.type === 'text-trace').flatMap(e => e.messages || []).some(row => row.index === 2 && row.changes?.some(c => c.to === 'native-input' && c.kind === 'edge-whitespace')));
  const macro = await page.evaluate(async () => {
    await tt.reset(); tt.c.chat[2].mes = 'Macro: {{getvar::trace_secret}}'; tt.c.chatMetadata.variables.trace_secret = 'PRIVATE-MACRO-VALUE';
    return tt.build();
  });
  check('macro-expansion-recorded-at-native-expanded-stage', macro.events.filter(e => e.type === 'text-trace').flatMap(e => e.messages || []).some(row => row.index === 2 && row.changes?.some(c => c.from === 'native-input' && c.to === 'native-expanded' && c.kind === 'text-changed')) && macro.chat.some(m => m.content === 'Macro: PRIVATE-MACRO-VALUE'));
  check('tracing-does-not-reevaluate-native-macros', await page.evaluate(() => tt.nativeCalls === 4));
  const regex = await page.evaluate(async () => {
    await tt.reset(); tt.c.chat[2].mes = 'PRIVATE-REGEX-INPUT';
    tt.c.extensionSettings.regex = [{ id: 'trace-regex', scriptName: 'PRIVATE-REGEX-NAME', findRegex: '/PRIVATE-REGEX-INPUT/g', replaceString: 'PRIVATE-REGEX-OUTPUT', trimStrings: [], placement: [2], disabled: false, promptOnly: true, markdownOnly: false, minDepth: null, maxDepth: null }];
    return tt.build();
  });
  check('regex-change-traced-before-native-input', regex.events.some(e => e.type === 'text-trace' && e.fromStage === 'stored-history' && e.toStage === 'interceptor' && e.messages.some(row => row.index === 2 && row.kind === 'text-changed')) && regex.chat.some(m => m.content === 'PRIVATE-REGEX-OUTPUT'));
  const word = await page.evaluate(async () => {
    await tt.reset(); tt.mutate = data => { const m = data.chat.find(m => m.content === tt.c.chat[2].mes); m.content = '\n\nPRIVATE-CHANGED-ANSWER\n\n'; };
    return tt.build();
  });
  check('changed-word-candidate-is-explicitly-inferred', word.events.filter(e => e.type === 'text-trace').flatMap(e => e.messages || []).some(row => row.index === 2 && row.requestMatch?.basis === 'single-role-between-anchors' && row.changes?.some(c => c.kind === 'text-changed' && c.to === 'assembled-prompt')));
  const ambiguous = await page.evaluate(async () => {
    await tt.reset(); tt.mutate = data => { const position = data.chat.findIndex(m => m.content === tt.c.chat[2].mes); data.chat.splice(position, 1, { role: 'assistant', content: 'PRIVATE-CANDIDATE-A' }, { role: 'assistant', content: 'PRIVATE-CANDIDATE-B' }); };
    return tt.build();
  });
  check('ambiguous-candidates-are-not-assigned-to-history', ambiguous.events.filter(e => e.type === 'text-trace').flatMap(e => e.messages || []).some(row => row.index === 2 && row.requestMatch?.basis === 'ambiguous' && row.requestMatch.candidateCount === 2 && !row.changes?.some(c => c.to === 'assembled-prompt')), ambiguous.events.filter(e => e.type === 'text-trace'));
  const transport = await page.evaluate(async () => {
    await tt.reset(); const built = await tt.build();
    const payload = { messages: structuredClone(built.chat), stream: true, max_tokens: 512 };
    const original = JSON.stringify(payload);
    await tt.script.eventSource.emit(tt.script.event_types.CHAT_COMPLETION_SETTINGS_READY, payload);
    return { unchanged: original === JSON.stringify(payload), events: tt.diagnostics.exportDiagnostics(tt.c.extensionSettings.silly_memories_plus, null).events.filter(e => e.requestId === built.requestId) };
  });
  check('transport-stage-traced-with-stream-and-settings-preserved', transport.unchanged && transport.events.some(e => e.type === 'text-trace' && e.phase === 'transport-preflight'));
  const transportChange = await page.evaluate(async () => {
    await tt.reset(); const built = await tt.build();
    const payload = { messages: structuredClone(built.chat), stream: true, max_tokens: 512 };
    payload.messages.find(m => m.content === tt.c.chat[2].mes).content = tt.c.chat[2].mes.trim();
    await tt.script.eventSource.emit(tt.script.event_types.CHAT_COMPLETION_SETTINGS_READY, payload);
    return tt.diagnostics.exportDiagnostics(tt.c.extensionSettings.silly_memories_plus, null).events.filter(e => e.requestId === built.requestId);
  });
  check('transport-only-change-is-distinguished-from-assembled-prompt', transportChange.filter(e => e.type === 'text-trace').flatMap(e => e.messages || []).some(row => row.index === 2 && row.changes.some(c => c.to === 'transport-preflight' && c.kind === 'edge-whitespace')) && !transportChange.filter(e => e.type === 'text-trace' && e.phase === 'assembled-prompt').flatMap(e => e.messages || []).some(row => row.changes.some(c => c.to === 'assembled-prompt')));
  const disabled = await page.evaluate(async () => { await tt.reset(false); return tt.build(); });
  check('debug-off-does-not-create-detailed-traces', !disabled.events.some(e => e.type === 'text-trace'));
  const diffs = await page.evaluate(async () => {
    const { describeTextChange } = await import('/scripts/extensions/third-party/silly-memories-plus/lib/text-trace.mjs');
    return { crlf: describeTextChange('A\r\nB', 'A\nB'), removed: describeTextChange('PRIVATE-REMOVED', ''), white: describeTextChange('\n\n', '\n'), long: describeTextChange(' '.repeat(20000) + 'PRIVATE-MIDDLE', 'PRIVATE-MIDDLE') };
  });
  check('line-ending-change-and-deletion-are-distinct', diffs.crlf.kind === 'line-endings' && diffs.removed.kind === 'removed');
  check('large-whitespace-descriptions-are-bounded', JSON.stringify(diffs.long).length < 1500);
  check('whitespace-only-change-has-correct-fragment-count', diffs.white.removed.chars === 1 && diffs.white.added.chars === 0);
  await page.evaluate(async () => { await tt.reset(); delete document.body.dataset.generating; await tt.script.eventSource.emit(tt.script.event_types.SETTINGS_UPDATED); });
  await page.waitForFunction(() => tt.diagnostics.exportDiagnostics(tt.c.extensionSettings.silly_memories_plus, null).events.some(e => e.type === 'text-trace' && e.phase === 'passive'));
  check('native-idle-build-has-separate-passive-trace', true);
  check('trace-rows-are-capped', await page.evaluate(() => {
    tt.diagnostics.recordDiagnostic('text-trace', { requestId: 999999, phase: 'test-bound', messages: Array.from({ length: 3000 }, (_, index) => ({ index })) });
    const event = tt.diagnostics.exportDiagnostics(tt.c.extensionSettings.silly_memories_plus, null).events.at(-1);
    return event.messages.length === 2000 && event.messagesTotal === 3000 && event.truncated;
  }));
  const download = page.waitForEvent('download');
  await page.locator('#smp-download-logs').evaluate(button => button.click());
  await (await download).saveAs(resolve(directory, 'downloaded-logs.json'));
  const exported = await page.evaluate(() => tt.diagnostics.exportDiagnostics(tt.c.extensionSettings.silly_memories_plus, null));
  const serialized = JSON.stringify(exported);
  check('traces-contain-no-chat-prompt-or-macro-text', !['PRIVATE-TRACE-ANSWER', 'PRIVATE-TRACE-PRESET', 'PRIVATE-MACRO-VALUE', 'PRIVATE-CHANGED-ANSWER', 'PRIVATE-CANDIDATE', 'PRIVATE-REGEX', 'trace_secret'].some(secret => serialized.includes(secret)));
  check('export-has-request-ids-and-release-version', exported.version === '0.8.3.1' && exported.events.filter(e => e.type === 'text-trace').every(e => Number.isInteger(e.requestId)));
  await writeFile(resolve(directory, 'trace-examples.json'), JSON.stringify({ edge: edgeRows, macro: macro.events.filter(e => e.type === 'text-trace') }, null, 2));
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'text-trace-report.json'), JSON.stringify({ results, failure, passed: !failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
