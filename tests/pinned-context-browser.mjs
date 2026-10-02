import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure cases defined before implementation: lost facts on graph operations,
// chat leakage, duplicate injections, accidental summarization of facts, uncounted
// facts, double-counted prompt overhead, stale asynchronous measurements, wrong
// trigger/free-space values, disabled automatic compaction, overflowing facts,
// lost drafts, missing persistence/export, misleading unknown-overhead values,
// stale preset measurements, narrow-panel overflow, and edits during a job.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
assert.ok(directory && process.env.SMP_BROWSER_EXECUTABLE);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
const saves = [];
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save/, route => {
  saves.push(route.request().postDataJSON());
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});
const results = [];
let failure = null;
try {
  await page.goto(process.env.SMP_BASE_URL || 'http://127.0.0.1:8001');
  await page.waitForFunction(() => typeof globalThis.sillyMemoriesPlusGenerateInterceptor === 'function');
  await page.waitForSelector('#smp-settings', { state: 'attached' });
  await page.locator('#preloader').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const script = await import('/script.js');
    const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
    const { getTokenCountAsync: count } = await import('/scripts/tokenizers.js');
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const { promptManager } = await import('/scripts/openai.js');
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const context = SillyTavern.getContext();
    context.characters.push({ name: 'Pinned test', avatar: 'none', chat: 'pins-a', data: {} });
    script.setCharacterId(context.characters.length - 1);
    const structured = narrative => ({ narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
    globalThis.pinsTest = { script, core, count, context, service, promptManager, structured, calls: [], pending: null, mode: 'ok' };
    service.getProfile = () => ({ id: 'pins-e2e' });
    service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (_, messages, maxTokens, options) => {
      pinsTest.calls.push({ messages, stream: options.stream });
      if (pinsTest.mode === 'wait') await new Promise((resolve, reject) => {
        pinsTest.pending = resolve;
        options.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      });
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'Observatory visit', ...structured('The group reached the observatory.') }) } }] };
    };
    globalThis.confirm = () => true;
    const root = document.getElementById('smp-settings');
    document.body.append(root);
    root.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:430px;max-height:100vh;overflow:auto;background:#202225;z-index:99999';
    root.querySelector('.inline-drawer-content').style.display = 'block';
  });
  async function reset({ raw = [100, 100, 100], facts = '', blocks = [], enabled = true } = {}) {
    await page.evaluate(async state => {
      const t = pinsTest;
      t.context.characters.at(-1).chat = 'pins-a';
      t.context.chat.splice(0, t.context.chat.length, ...state.raw.map((size, index) => ({ name: 'Mira', mes: ' memory'.repeat(size), is_user: index % 2 === 0, is_system: false, extra: {} })));
      t.context.chatMetadata.silly_memories_plus = { schemaVersion: 3, blocks: state.blocks, ...(state.facts ? { pinnedFacts: state.facts } : {}) };
      t.context.extensionSettings.silly_memories_plus = t.core.normalizeSettings({ enabled: state.enabled, summaryProfileId: 'pins-e2e', summaryInputBudgetTokens: 100000 });
      t.calls.length = 0; t.mode = 'ok'; t.pending = null;
      await t.script.eventSource.emit(t.script.event_types.CHAT_CHANGED);
      document.getElementById('smp-refresh').click();
    }, { raw, facts, blocks, enabled });
  }
  async function check(name, value) {
    results.push({ name, passed: Boolean(value) });
    assert.equal(Boolean(value), true, name);
  }
  async function openSection(name) {
    const section = page.locator(`[data-section="${name}"].smp-submenu`);
    if (!await section.evaluate(element => element.open)) await section.locator(':scope > summary').click();
  }
  async function generate(budget = 40000, type = 'normal') {
    return page.evaluate(async ({ budget, type }) => {
      const outgoing = pinsTest.context.chat.map((message, index) => ({ ...message, index, extra: { ...message.extra } }));
      const original = JSON.stringify(pinsTest.context.chat);
      let aborted = false;
      await sillyMemoriesPlusGenerateInterceptor(outgoing, budget, () => { aborted = true; }, type);
      const meter = document.getElementById('smp-context-meter');
      return {
        outgoing, aborted, unchanged: JSON.stringify(pinsTest.context.chat) === original,
        facts: pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts,
        meter: { used: Number(meter.dataset.used), facts: Number(meter.dataset.facts), raw: Number(meter.dataset.raw), memory: Number(meter.dataset.memory), other: Number(meter.dataset.other), budget: Number(meter.dataset.budget), free: Number(meter.dataset.free), trigger: Number(meter.dataset.triggerRemaining) },
      };
    }, { budget, type });
  }
  await reset();
  await openSection('facts');
  const facts = 'Mira owns the brass key.\nRowan promised to return by dawn.\n<world> Time stops at midnight. </world>';
  await page.locator('#smp-pinned-facts').fill(facts);
  await page.locator('#smp-save-facts').click();
  await page.waitForFunction(() => SillyTavern.getContext().chatMetadata.silly_memories_plus.pinnedFacts?.includes('Mira owns'));
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  await check('facts-saved-in-chat-metadata', await page.evaluate(() => pinsTest.context.chatMetadata.silly_memories_plus.schemaVersion === 3 && document.getElementById('smp-pinned-facts').value === pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts));
  await check('facts-in-save-request', saves.some(data => JSON.stringify(data).includes('Mira owns the brass key.')));
  const first = await generate();
  const pinned = first.outgoing.filter(x => x.extra?.sillyMemoriesPlusPinnedFacts);
  await check('single-exact-facts-message-and-chat-untouched', pinned.length === 1 && JSON.parse(pinned[0].mes).facts === facts && first.unchanged && !first.aborted);
  await check('meter-counts-facts-and-trigger', first.meter.facts > 0 && first.meter.used === first.meter.raw + first.meter.memory + first.meter.facts + first.meter.other && first.meter.free === 40000 - first.meter.used && first.meter.trigger === Math.max(0, 30000 - first.meter.used));
  await check('unknown-other-prompt-is-labelled', await page.evaluate(() => document.getElementById('smp-context-note').textContent.includes('next generation')));
  await check('repeated-injection-is-idempotent', await page.evaluate(async () => {
    const outgoing = pinsTest.context.chat.map((x, index) => ({ ...x, index }));
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 40000, () => {}, 'normal');
    await sillyMemoriesPlusGenerateInterceptor(outgoing, 40000, () => {}, 'normal');
    return outgoing.filter(x => x.extra?.sillyMemoriesPlusPinnedFacts).length === 1;
  }));
  await page.evaluate(async () => {
    pinsTest.promptManager.tokenHandler.counts = { chatHistory: 321, main: 600 };
    await pinsTest.script.eventSource.emit(pinsTest.script.event_types.CHAT_COMPLETION_PROMPT_READY);
  });
  const measured = await generate();
  await check('other-prompt-counted-without-double-facts', measured.meter.other === 600 && measured.meter.facts === first.meter.facts);
  await page.evaluate(async () => { await pinsTest.script.eventSource.emit(pinsTest.script.event_types.OAI_PRESET_CHANGED_AFTER); });
  await page.waitForFunction(() => document.getElementById('smp-context-note').textContent.includes('next generation'));
  await check('preset-invalidates-other-prompt-measurement', true);
  await openSection('runtime');
  // Export is checked through a real browser download, not an internal helper.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#smp-export').click();
  const download = await downloadPromise;
  const exportPath = resolve(directory, 'chat-memory-export.json');
  await download.saveAs(exportPath);
  const { readFile } = await import('node:fs/promises');
  await check('export-includes-facts', JSON.parse(await readFile(exportPath, 'utf8')).pinnedFacts === facts);
  await reset({ raw: [3000, 7000, 7000], facts: ' pinned'.repeat(6000) });
  const compressed = await generate(30000);
  await check('facts-create-real-compaction-pressure', !compressed.aborted && await page.evaluate(() => pinsTest.calls.length > 0 && pinsTest.context.chatMetadata.silly_memories_plus.blocks.length > 0));
  await check('facts-survive-compaction-and-are-not-summary-source', compressed.facts === ' pinned'.repeat(6000).trim() && await page.evaluate(() => pinsTest.calls.every(call => !call.messages[1].content.includes('pinned'))));
  const blockId = await page.evaluate(() => pinsTest.context.chatMetadata.silly_memories_plus.blocks.find(x => x.status === 'active').id);
  await openSection('memory');
  await page.locator(`.smp-block[data-block-id="${blockId}"] > summary`).click();
  await page.locator('#smp-regenerate-block').click();
  await page.locator('#smp-generate-preview').click();
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await page.locator('#smp-save-preview').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  await check('regeneration-preserves-facts', await page.evaluate(() => pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts.includes('pinned')));
  await page.locator(`.smp-block[data-block-id="${blockId}"] > summary`).click();
  await page.locator(`.smp-block[data-block-id="${blockId}"] [data-smp-block-action="delete"]`).click();
  await page.waitForFunction(() => !pinsTest.context.chatMetadata.silly_memories_plus.blocks.length);
  await check('block-delete-preserves-facts', await page.evaluate(() => pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts.includes('pinned')));
  await reset({ facts, enabled: false });
  const disabled = await generate();
  await check('facts-work-with-auto-compaction-off', !disabled.aborted && disabled.outgoing.some(x => x.extra?.sillyMemoriesPlusPinnedFacts) && await page.evaluate(() => pinsTest.calls.length === 0));
  await reset({ raw: [3000, 7000, 7000], facts: ' pinned'.repeat(6000) });
  await page.evaluate(() => { pinsTest.mode = 'wait'; });
  const racingGeneration = generate(30000);
  await page.waitForFunction(() => Boolean(pinsTest.pending));
  await page.evaluate(() => {
    pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts = 'Updated facts during compaction.';
    pinsTest.mode = 'ok'; pinsTest.pending();
  });
  const raced = await racingGeneration;
  await check('compaction-cannot-overwrite-updated-facts', raced.facts === 'Updated facts during compaction.' && await page.evaluate(() => pinsTest.context.chatMetadata.silly_memories_plus.blocks.length === 0));
  await reset({ raw: [500, 500], facts: ' pinned'.repeat(30000) });
  const over = await generate(20000);
  await check('oversized-facts-stop-generation-with-clear-status', over.aborted && await page.evaluate(() => document.getElementById('smp-status').textContent.includes('pinned facts') && pinsTest.calls.length === 0));
  await check('overflow-meter-keeps-real-values', over.meter.used > over.meter.budget && over.meter.free === 0);
  await reset({ facts });
  await openSection('facts');
  await page.locator('#smp-pinned-facts').fill('Unsaved local draft');
  await page.locator('#smp-refresh').evaluate(button => button.click());
  await check('refresh-preserves-draft', await page.locator('#smp-pinned-facts').inputValue() === 'Unsaved local draft');
  await page.evaluate(async () => {
    pinsTest.context.characters.at(-1).chat = 'pins-b';
    pinsTest.context.chatMetadata.silly_memories_plus = { schemaVersion: 3, blocks: [], pinnedFacts: 'Only chat B.' };
    await pinsTest.script.eventSource.emit(pinsTest.script.event_types.CHAT_CHANGED);
  });
  await check('chat-switch-loads-only-current-facts', await page.locator('#smp-pinned-facts').inputValue() === 'Only chat B.');
  const other = await generate();
  await check('chat-switch-does-not-leak-facts', other.outgoing.some(x => x.extra?.sillyMemoriesPlusPinnedFacts && JSON.parse(x.mes).facts === 'Only chat B.') && !JSON.stringify(other.outgoing).includes('Mira owns'));
  await openSection('facts');
  await page.locator('#smp-pinned-facts').fill('');
  await page.locator('#smp-save-facts').click();
  await page.waitForFunction(() => !pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts);
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  const empty = await generate();
  await check('empty-facts-remove-injection', empty.meter.facts === 0 && !empty.outgoing.some(x => x.extra?.sillyMemoriesPlusPinnedFacts));
  const blocks = await page.evaluate(() => [0, 1].map(index => ({ id: `pin-block-${index}`, level: 1, structured: pinsTest.structured('Saved visit to the observatory.'), sourceFrom: index, sourceTo: index, sourceTokens: 1000, rawTokens: 100, summaryTokens: 50, sourceFingerprints: [], children: [], status: 'active', createdAt: index })));
  await reset({ raw: [100, 100, 100, 100], facts, blocks });
  await openSection('memory');
  await page.locator('[data-smp-rollup-select][value="pin-block-0"]').click();
  await page.locator('[data-smp-rollup-select][value="pin-block-1"]').click();
  await page.locator('#smp-rollup-selected').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  await check('manual-merge-preserves-pinned-facts', await page.evaluate(() => pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts.includes('Mira owns') && pinsTest.context.chatMetadata.silly_memories_plus.blocks.some(x => x.level === 2 && x.status === 'active')));
  const merged = await generate();
  await check('meter-separates-memory-history-and-facts', merged.meter.memory > 0 && merged.meter.raw > 0 && merged.meter.facts > 0);
  const beforeMessage = merged.meter.raw;
  await page.evaluate(async () => {
    pinsTest.context.chat.push({ name: 'Mira', mes: ' memory'.repeat(500), is_user: false, is_system: false, extra: {} });
    await pinsTest.script.eventSource.emit(pinsTest.script.event_types.MESSAGE_RECEIVED, 4, 'normal');
  });
  await page.waitForFunction(before => Number(document.getElementById('smp-context-meter').dataset.raw) > before, beforeMessage);
  await check('meter-refreshes-after-new-message', true);
  await page.locator('.smp-block[data-status="active"] > summary').click();
  await page.locator('#smp-regenerate-block').click();
  await page.evaluate(() => { pinsTest.mode = 'wait'; });
  await page.locator('#smp-generate-preview').click();
  await page.waitForFunction(() => Boolean(pinsTest.pending));
  await check('facts-controls-locked-during-job', await page.evaluate(() => document.getElementById('smp-pinned-facts').disabled && document.getElementById('smp-save-facts').disabled));
  await page.locator('#smp-cancel').click();
  await page.waitForFunction(() => !document.getElementById('smp-generate-preview').disabled);
  await check('cancel-keeps-facts-and-unlocks-editor', await page.evaluate(() => !document.getElementById('smp-pinned-facts').disabled && pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts.includes('Mira owns')));
  await openSection('runtime');
  await page.locator('#smp-clear').click();
  await page.waitForFunction(() => document.getElementById('smp-status').textContent === 'Current chat memory cleared.');
  await check('clear-memory-clears-facts-and-blocks', await page.evaluate(() => !pinsTest.context.chatMetadata.silly_memories_plus.pinnedFacts && pinsTest.context.chatMetadata.silly_memories_plus.blocks.length === 0 && document.getElementById('smp-pinned-facts').value === ''));
  await reset({ facts });
  await generate();
  await page.evaluate(() => { document.getElementById('smp-settings').style.width = '320px'; });
  await check('320px-meter-layout', await page.evaluate(() => { const root = document.getElementById('smp-settings'); return root.scrollWidth <= root.clientWidth + 1; }));
  await page.evaluate(() => { document.getElementById('smp-settings').style.width = '430px'; });
  await openSection('facts');
  await page.evaluate(() => globalThis.toastr?.clear());
  await page.locator('#toast-container .toast').waitFor({ state: 'hidden' });
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'pinned-facts-and-context.png') });
  const largeBlocks = blocks.map(block => ({ ...block, structured: { ...block.structured, narrative: ' memory'.repeat(6000) } }));
  await reset({ raw: [100, 100, 3000, 3000], facts, blocks: largeBlocks });
  await generate();
  await page.evaluate(async () => {
    pinsTest.promptManager.tokenHandler.counts = { chatHistory: 19000, main: 6000 };
    await pinsTest.script.eventSource.emit(pinsTest.script.event_types.CHAT_COMPLETION_PROMPT_READY);
  });
  const breakdown = await generate();
  await check('measured-context-breakdown', breakdown.meter.memory > 12000 && breakdown.meter.raw > 6000 && breakdown.meter.other === 6000 && breakdown.meter.used < 40000);
  await openSection('facts');
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'context-breakdown.png') });
} catch (error) {
  failure = String(error?.stack || error);
  await page.screenshot({ path: resolve(directory, 'failure.png') });
  throw error;
} finally {
  await writeFile(resolve(directory, 'pinned-context-report.json'), JSON.stringify({ passed: results.filter(x => x.passed).length, failure, results }, null, 2));
  await browser.close();
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
