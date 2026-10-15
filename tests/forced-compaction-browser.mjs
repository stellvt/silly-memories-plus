import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure cases defined before implementation: one oversized map/reduce block
// instead of independent L1s; stopping below the trigger before cold history is
// exhausted; exceeding the source budget after JSON escaping; crossing coverage
// gaps; overlapping blocks for a single oversized message; losing completed
// batches after failure/cancel; duplicate coverage on retry; cross-chat saves;
// changing automatic compaction or stored chat while handling a manual batch.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
const saves = [];
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save|\/api\/settings\/save/, route => {
  if (!route.request().url().includes('/settings/')) saves.push(route.request().postDataJSON());
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
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
    const summary = await import('/scripts/extensions/third-party/silly-memories-plus/lib/summarizer.mjs');
    const identity = await import('/scripts/extensions/third-party/silly-memories-plus/lib/source-identity.mjs');
    const { countTokensOpenAIAsync } = await import('/scripts/tokenizers.js');
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const c = SillyTavern.getContext();
    c.characters.push({ name: 'Mira', avatar: 'none', chat: 'batch-test', data: {} });
    script.setCharacterId(c.characters.length - 1); script.setCharacterName('Mira'); script.changeMainAPI('openai');
    openai.promptManager.activeCharacter = { id: openai.promptManager.configuration.promptOrder.dummyId };
    const structured = narrative => ({ title: 'The recovered key', narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
    const count = text => countTokensOpenAIAsync({ role: 'system', content: text }, true);
    globalThis.batch = { script, openai, core, summary, identity, c, service, count, structured, calls: [], serial: 0 };
    service.getProfile = () => ({ id: 'batch-test' });
    service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (_, messages, maxTokens, options) => {
      const sources = JSON.parse(messages[1].content);
      const tokens = await count(messages[1].content);
      const systemTokens = await count(messages[0].content);
      batch.calls.push({ sources, tokens, total: tokens + systemTokens + maxTokens + 512, maxTokens, stream: options.stream });
      if (batch.calls.length === 2) {
        if (batch.mode === 'failure') throw new Error('Synthetic second batch failure');
        if (batch.mode === 'cancel') document.getElementById('smp-cancel').click();
        if (batch.mode === 'chat-change') {
          // A loaded chat supplies its own metadata before CHAT_CHANGED. Keep
          // the departed chat separately to inspect its completed checkpoint.
          batch.departedMemory = structuredClone(c.chatMetadata.silly_memories_plus);
          c.chatMetadata.silly_memories_plus = core.createEmptyMemory();
          c.characters.at(-1).chat = 'another-chat';
          await script.eventSource.emit(script.event_types.CHAT_CHANGED);
        }
      }
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structured('Mira recovered the observatory key.')) } }] };
    };
    batch.reset = async mode => {
      await script.eventSource.emit(script.event_types.GENERATION_ENDED);
      c.characters.at(-1).chat = `batch-${mode}-${++batch.serial}`;
      const contextBudget = mode === 'below-trigger' ? 100000 : 12000;
      Object.assign(openai.oai_settings, { chat_completion_source: 'openai', openai_model: 'gpt-4o-mini', openai_max_context: contextBudget + 512, openai_max_tokens: 512 });
      c.extensionSettings.silly_memories_plus = core.normalizeSettings({ summaryProfileId: 'batch-test', blockTargetTokens: 512, minimumSourceTokens: 512, summaryInputBudgetTokens: 20000, summaryMaxOutputTokens: 2048 });
      const texts = mode.startsWith('oversized-') ? [(mode === 'oversized-escaped' ? ' "key"\\door\n'.repeat(6000) : ' scene'.repeat(30000)), ' recent'.repeat(700), ' latest'.repeat(700)]
        : Array.from({ length: 50 }, (_, index) => `Scene ${index}. ` + (mode === 'escaped' ? ' "key"\\door\n' : ' scene').repeat(mode === 'escaped' ? 300 : 1400)).concat([' recent'.repeat(700), ' latest'.repeat(700)]);
      c.chat.splice(0, c.chat.length, ...texts.map((mes, index) => ({ name: index % 2 ? 'User' : 'Mira', mes, is_user: Boolean(index % 2), is_system: false, extra: {} })));
      c.chatMetadata.silly_memories_plus = core.createEmptyMemory();
      if (mode === 'gaps' || mode === 'below-trigger') {
        const fingerprints = c.chat.slice(10, 13).map((message, offset) => identity.fingerprintMessage({ ...message, index: 10 + offset }));
        c.chatMetadata.silly_memories_plus.blocks.push({ id: 'existing', level: 1, sourceFrom: 10, sourceTo: 12, sourceFingerprints: fingerprints, sourceHash: identity.buildSourceHash(fingerprints), sourceTokens: 4200, summaryTokens: 100, structured: structured('Existing saved scene'), status: 'active', children: [] });
        c.chat[20].extra[Symbol.for('ignore')] = true;
      }
      batch.mode = mode; batch.calls = []; batch.departedMemory = null;
      await script.eventSource.emit(script.event_types.CHAT_CHANGED);
      const entries = await Promise.all(c.chat.map(async (message, index) => ({ message: { ...message, index }, index, tokens: await count(message.mes) })));
      const uncovered = entries.filter(entry => !entry.message.extra?.[Symbol.for('ignore')] && !c.chatMetadata.silly_memories_plus.blocks.some(block => entry.index >= block.sourceFrom && entry.index <= block.sourceTo));
      const { source, tail } = core.selectTail(uncovered, contextBudget * 0.25, 2);
      const { sourceBudget } = await summary.getSummarySourceBudget({ settings: c.extensionSettings.silly_memories_plus, stage: 'raw', targetTokens: 512, level: 1, countTokens: count });
      batch.expected = source.map(entry => entry.index); batch.tail = tail.map(entry => entry.index);
      batch.sourceLimit = Math.floor(sourceBudget * 0.9); batch.stored = JSON.stringify(c.chat);
    };
  });
  const runManual = async () => {
    await page.locator('#smp-compact-now').evaluate(button => button.click());
    await page.waitForFunction(() => !document.getElementById('smp-compact-now').disabled && document.getElementById('smp-status').dataset.kind !== 'working');
  };
  for (const mode of ['manual', 'escaped', 'gaps', 'below-trigger', 'oversized-message', 'oversized-escaped', 'failure', 'cancel', 'chat-change', 'automatic']) {
    const saveStart = saves.length;
    await page.evaluate(mode => batch.reset(mode), mode);
    if (mode === 'automatic') await page.evaluate(async () => {
      const outgoing = batch.c.chat.map((message, index) => ({ ...message, index }));
      await sillyMemoriesPlusGenerateInterceptor(outgoing, 12000, () => {}, 'normal');
    });
    else await runManual();
    const snapshot = await page.evaluate(() => {
      const blocks = (batch.departedMemory || batch.c.chatMetadata.silly_memories_plus).blocks;
      const created = blocks.filter(block => block.id !== 'existing');
      return { mode: batch.mode, blocks: created.map(block => ({ id: block.id, from: block.sourceFrom, to: block.sourceTo, level: block.level, status: block.status })),
        existing: blocks.find(block => block.id === 'existing'), calls: batch.calls, expected: batch.expected, tail: batch.tail, sourceLimit: batch.sourceLimit,
        oversizedSourcePreserved: !batch.mode.startsWith('oversized-') || batch.calls.flatMap(call => call.sources).filter(source => typeof source.content === 'string').map(source => source.content).join('') === batch.c.chat[0].mes,
        storedUnchanged: batch.stored === JSON.stringify(batch.c.chat), otherChatEmpty: !batch.departedMemory || batch.c.chatMetadata.silly_memories_plus.blocks.length === 0,
        status: document.getElementById('smp-status').textContent };
    });
    const coverage = snapshot.blocks.flatMap(block => Array.from({ length: block.to - block.from + 1 }, (_, index) => block.from + index));
    const complete = ['manual', 'escaped', 'gaps', 'below-trigger'].includes(mode);
    const independent = complete ? snapshot.blocks.length > 1 && snapshot.blocks.every(block => block.level === 1 && block.status === 'active') : true;
    const coverageCorrect = complete ? JSON.stringify(coverage) === JSON.stringify(snapshot.expected) : true;
    const onePerCall = complete ? snapshot.calls.length === snapshot.blocks.length && snapshot.calls.every(call => call.sources.every(source => typeof source.index === 'number') && call.tokens <= snapshot.sourceLimit) : true;
    const partial = ['failure', 'cancel', 'chat-change'].includes(mode) ? snapshot.blocks.length === 1 && snapshot.calls.length === 2 : true;
    const automatic = mode === 'automatic' ? snapshot.blocks.length === 1 && snapshot.calls.length > 1 : true;
    const oversized = mode.startsWith('oversized-') ? snapshot.blocks.length === 1 && snapshot.blocks[0].from === 0 && snapshot.blocks[0].to === 0 && snapshot.calls.length > 1 : true;
    const safe = snapshot.calls.every(call => call.total <= 20000 && call.stream === false && call.maxTokens === 3072) && new Set(coverage).size === coverage.length && snapshot.storedUnchanged && snapshot.oversizedSourcePreserved;
    const savedRequests = saves.slice(saveStart).map(save => ({ chat: save.file_name,
      blocks: save.chat?.[0]?.chat_metadata?.silly_memories_plus?.blocks?.map(block => ({ id: block.id, from: block.sourceFrom, to: block.sourceTo })) || [] }));
    const saved = snapshot.otherChatEmpty && savedRequests.every(save => save.chat !== 'another-chat' || !save.blocks.length);
    results.push({ mode, passed: independent && coverageCorrect && onePerCall && partial && automatic && oversized && safe && saved,
      blocks: snapshot.blocks, calls: snapshot.calls.map(({ sources, ...call }) => ({ ...call, indices: sources.map(source => source.index).filter(index => index !== undefined) })), expected: snapshot.expected, tail: snapshot.tail, sourceLimit: snapshot.sourceLimit, independent, coverageCorrect, onePerCall, partial, automatic, oversized, safe, saved, savedRequests, status: snapshot.status });
    if (mode === 'manual') {
      await page.locator('#smp-settings').evaluate(root => {
        document.body.append(root); root.style.cssText = 'display:block;width:430px;background:#202225';
        root.querySelector('.inline-drawer-content').style.display = 'block'; root.querySelector('[data-section="memory"]').open = true;
      });
      await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'forced-compaction.png') });
    }
    if (mode === 'failure') {
      await page.evaluate(() => { batch.mode = 'retry'; batch.calls = []; });
      await runManual();
      const retry = await page.evaluate(() => {
        const blocks = batch.c.chatMetadata.silly_memories_plus.blocks;
        return { blocks: blocks.map(block => ({ id: block.id, from: block.sourceFrom, to: block.sourceTo })), calls: batch.calls.length };
      });
      const covered = retry.blocks.flatMap(block => Array.from({ length: block.to - block.from + 1 }, (_, index) => block.from + index));
      results.push({ mode: 'retry', passed: retry.blocks.length > 1 && retry.blocks[0].id === snapshot.blocks[0]?.id && JSON.stringify(covered) === JSON.stringify(snapshot.expected) && new Set(covered).size === covered.length, ...retry });
    }
  }
  assert.ok(results.every(result => result.passed), 'One or more forced compaction checks failed');
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'forced-compaction-report.json'), JSON.stringify({ results, failure, passed: !failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
