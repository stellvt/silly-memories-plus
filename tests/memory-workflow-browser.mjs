import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure scenarios are defined before implementation: mixed active/archive
// lists, hidden status, overflowing titles, lost edits, premature regeneration
// commits, absent wishes in map/reduce, partial ancestor updates, stale preview
// acceptance, cancellation, provider failure, and writing into another chat.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
assert.ok(directory && process.env.SMP_BROWSER_EXECUTABLE);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
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
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const context = SillyTavern.getContext();
    const character = { name: 'Workflow test', avatar: 'none', chat: 'memory-workflow-e2e', data: {} };
    context.characters.push(character);
    script.setCharacterId(context.characters.length - 1);
    const structured = narrative => ({ narrative, relationships: ['Mira trusts Rowan after he returned the key.'], importantItems: ['Brass key: returned to Mira.'], characterStates: [], locations: [], commitments: [], openThreads: ['Open the observatory.'], resolvedThreads: ['The stolen key was recovered.'], worldFacts: [], exactTerms: [] });
    const block = (id, from, level = 1, status = 'active', children = []) => ({ id, level, structured: structured(`Saved ${id}.`), sourceFrom: from, sourceTo: from + (children.length ? 1 : 0), sourceTokens: 4000, rawTokens: 4000, summaryTokens: 100, sourceFingerprints: [], children, status, createdAt: from });
    const memory = core.normalizeMemory({ schemaVersion: 3, blocks: [block('a', 0, 1, 'retired'), block('b', 1, 1, 'retired'), block('parent', 0, 2, 'active', ['a', 'b']), block('c', 2), block('stale', 5, 1, 'stale')] });
    const stored = Array.from({ length: 5 }, (_, index) => ({ name: 'Mira', mes: `Original source ${index}: the observatory key changed hands.`, is_user: index % 2 === 0, is_system: false, extra: {} }));
    context.chat.splice(0, context.chat.length, ...stored);
    context.chatMetadata.silly_memories_plus = structuredClone(memory);
    context.extensionSettings.silly_memories_plus = core.normalizeSettings({ summaryProfileId: 'workflow-e2e', summaryInputBudgetTokens: 50000 });
    globalThis.workflow = { context, script, service, memory, structured, calls: [], mode: 'ok', pending: null, stored };
    service.getProfile = () => ({ id: 'workflow-e2e' });
    service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (profile, messages, maxTokens, options) => {
      workflow.calls.push({ messages, stream: options.stream });
      if (workflow.mode === 'fail' || workflow.mode === 'fail-parent' && workflow.calls.length === 2) throw new Error('Synthetic provider failure');
      if (workflow.mode === 'wait') await new Promise((resolve, reject) => {
        workflow.pending = resolve;
        options.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      });
      const narrative = workflow.mode === 'oversize' && workflow.calls.length === 1 ? ' memory'.repeat(1000) : 'Regenerated continuity with relationship emphasis.';
      const title = workflow.mode === 'long-title' ? 'A very long observatory key title '.repeat(12) : 'The observatory key';
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title, ...structured(narrative) }) } }] };
    };
    globalThis.confirm = () => true;
    const root = document.getElementById('smp-settings');
    document.body.append(root);
    root.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:430px;max-height:100vh;overflow:auto;background:#202225;z-index:99999';
    root.querySelector('.inline-drawer-content').style.display = 'block';
    document.getElementById('smp-refresh').click();
  });
  async function check(name, run) {
    const value = await run();
    results.push({ name, passed: value === true });
    assert.equal(value, true, name);
  }
  const card = id => page.locator(`.smp-block[data-block-id="${id}"]`);
  async function regenerate(id, wish = '') {
    await card(id).locator('summary').click();
    await page.locator('#smp-regenerate-block').click();
    await page.locator('#smp-regeneration-wish').fill(wish);
    await page.locator('#smp-generate-preview').click();
  }
  async function reset() {
    await page.evaluate(async () => {
      workflow.context.chatMetadata.silly_memories_plus = structuredClone(workflow.memory);
      workflow.context.chat.splice(0, workflow.context.chat.length, ...structuredClone(workflow.stored));
      const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
      workflow.context.extensionSettings.silly_memories_plus = core.normalizeSettings({ summaryProfileId: 'workflow-e2e', summaryInputBudgetTokens: 50000 });
      workflow.mode = 'ok'; workflow.calls.length = 0;
      workflow.pending = null;
      await workflow.script.eventSource.emit(workflow.script.event_types.CHAT_CHANGED);
      document.getElementById('smp-refresh').click();
      document.querySelector('[data-section="memory"]').open = true;
    });
  }
  await check('active-default-and-archive', async () => {
    const initial = await page.locator('#smp-library .smp-block').count();
    await page.locator('[data-smp-tab="archive"]').click();
    const archived = await page.locator('#smp-library .smp-block').count();
    await page.locator('[data-smp-tab="active"]').click();
    return initial === 2 && archived === 3 && await page.locator('#smp-regenerate-block').isDisabled();
  });
  await page.locator('[data-smp-tab="active"]').focus();
  await page.keyboard.press('ArrowRight');
  await check('keyboard-tab-switch', () => page.evaluate(() => document.activeElement.id === 'smp-tab-archive' && document.getElementById('smp-tab-archive').getAttribute('aria-selected') === 'true'));
  await page.keyboard.press('Home');
  await check('status-above-submenus', () => page.evaluate(() => !document.getElementById('smp-status').closest('.smp-submenu') && Boolean(document.getElementById('smp-status').getAttribute('role') === 'status')));
  await regenerate('c', 'Focus on relationships; remove repetition.');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await check('wish-preview-without-write', () => page.evaluate(() => workflow.calls.length === 1 && workflow.calls[0].messages[0].content.includes('Focus on relationships; remove repetition.') && workflow.calls[0].stream === false && workflow.context.chatMetadata.silly_memories_plus.blocks.find(x => x.id === 'c').structured.narrative === 'Saved c.' && document.getElementById('smp-regeneration-preview').textContent.includes('Regenerated continuity')));
  await page.locator('#smp-discard-preview').click();
  await check('discard-preserves-memory', () => page.evaluate(() => JSON.stringify(workflow.context.chatMetadata.silly_memories_plus) === JSON.stringify(workflow.memory)));
  await regenerate('c');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await page.locator('#smp-save-preview').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  await check('accept-persists-title-without-schema-change', () => page.evaluate(() => { const memory = workflow.context.chatMetadata.silly_memories_plus; return memory.schemaVersion === 3 && memory.blocks.find(x => x.id === 'c').structured.title === 'The observatory key'; }));
  await card('c').locator('summary').click();
  await check('clear-raw-action', async () => (await card('c').locator('[data-smp-block-action="toggle-raw"]').textContent()).includes('Use original history'));
  await page.locator('[data-smp-tab="archive"]').click();
  await regenerate('a', 'Keep the key transfer and its cause.');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await check('ancestor-preview-atomic', () => page.evaluate(() => workflow.calls.length === 4 && workflow.context.chatMetadata.silly_memories_plus.blocks.find(x => x.id === 'parent').structured.narrative === 'Saved parent.' && document.getElementById('smp-regeneration-preview').textContent.includes('dependent')));
  await page.locator('#smp-save-preview').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  await check('ancestor-accepted-together', () => page.evaluate(() => ['a', 'parent'].every(id => workflow.context.chatMetadata.silly_memories_plus.blocks.find(x => x.id === id).structured.narrative.startsWith('Regenerated'))));
  await reset();
  await regenerate('c');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await page.evaluate(() => { workflow.context.chat[2].mes = 'Edited source during preview.'; });
  await page.locator('#smp-save-preview').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'error');
  await check('source-edit-rejects-preview', () => page.evaluate(() => workflow.context.chatMetadata.silly_memories_plus.blocks.find(x => x.id === 'c').structured.narrative === 'Saved c.'));
  await reset();
  await regenerate('c');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await page.evaluate(() => { workflow.context.chatMetadata.silly_memories_plus.blocks[0].useRaw = true; });
  await page.locator('#smp-save-preview').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'error');
  await check('memory-edit-rejects-preview', () => page.evaluate(() => workflow.context.chatMetadata.silly_memories_plus.blocks[0].useRaw === true));
  await reset();
  await page.evaluate(() => { workflow.mode = 'wait'; });
  await regenerate('c');
  await page.waitForFunction(() => Boolean(workflow.pending));
  await page.locator('#smp-cancel').click();
  await page.waitForFunction(() => document.getElementById('smp-generate-preview').disabled === false);
  await check('cancel-preserves-memory', () => page.evaluate(() => JSON.stringify(workflow.context.chatMetadata.silly_memories_plus) === JSON.stringify(workflow.memory) && document.getElementById('smp-regeneration-preview').hidden));
  await check('cancel-status-and-controls', () => page.evaluate(() => document.getElementById('smp-status').dataset.kind === 'warning' && document.getElementById('smp-cancel').disabled));
  await reset();
  await page.evaluate(() => { workflow.mode = 'fail-parent'; });
  await page.locator('[data-smp-tab="archive"]').click();
  await regenerate('a');
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'error');
  await check('ancestor-failure-preserves-all', () => page.evaluate(() => JSON.stringify(workflow.context.chatMetadata.silly_memories_plus) === JSON.stringify(workflow.memory)));
  await reset();
  await regenerate('c');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await page.evaluate(async () => { workflow.context.characters.at(-1).chat = 'another-chat'; await workflow.script.eventSource.emit(workflow.script.event_types.CHAT_CHANGED); });
  await check('chat-change-discards-preview', () => page.evaluate(() => document.getElementById('smp-regeneration-preview').hidden && document.getElementById('smp-regeneration').hidden));
  await reset();
  await check('careful-merge-prompt', () => page.evaluate(() => document.getElementById('smp-prompt-rollup').value.includes('Deduplicate') && document.getElementById('smp-prompt-rollup').value.includes('cause')));
  await page.evaluate(() => {
    const memory = workflow.context.chatMetadata.silly_memories_plus;
    memory.blocks = memory.blocks.filter(block => block.id !== 'parent');
    for (const block of memory.blocks) if (['a', 'b'].includes(block.id)) block.status = 'active';
    document.getElementById('smp-refresh').click();
  });
  await card('a').locator('[data-smp-rollup-select]').click();
  await card('b').locator('[data-smp-rollup-select]').click();
  await page.locator('#smp-rollup-selected').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  await check('manual-merge-updates-active-and-archive', () => page.evaluate(() => {
    const blocks = workflow.context.chatMetadata.silly_memories_plus.blocks;
    return blocks.filter(x => x.status === 'active').length === 2
      && blocks.some(x => x.level === 2 && x.status === 'active' && x.children.length === 2 && x.structured.title === 'The observatory key')
      && ['a', 'b'].every(id => blocks.find(x => x.id === id).status === 'retired')
      && document.querySelector('[data-smp-count="active"]').textContent === '2'
      && document.querySelector('[data-smp-count="archive"]').textContent === '3'
      && workflow.calls[0].messages[0].content.includes('Deduplicate');
  }));
  await reset();
  await page.evaluate(() => {
    workflow.context.extensionSettings.silly_memories_plus.summaryInputBudgetTokens = 18000;
    workflow.context.chat[2].mes = ' memory'.repeat(14000);
  });
  await regenerate('c', 'Keep each relationship change.');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await check('wish-survives-map-reduce', () => page.evaluate(() => workflow.calls.length > 2 && workflow.calls.every(call => call.messages[0].content.includes('Keep each relationship change.'))));
  await reset();
  await page.evaluate(() => { workflow.context.extensionSettings.silly_memories_plus.blockTargetTokens = 256; workflow.mode = 'oversize'; });
  await regenerate('c', 'Keep causal links.');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await check('wish-survives-output-reduction', () => page.evaluate(() => workflow.calls.length === 2 && workflow.calls.every(call => call.messages[0].content.includes('Keep causal links.'))));
  await reset();
  await page.evaluate(() => { workflow.context.extensionSettings.silly_memories_plus.prompts.rollup = 'Custom merge focus: key ownership. Return JSON matching {{schema}}.'; });
  await regenerate('parent');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await check('custom-merge-prompt-preserved-with-guidance', () => page.evaluate(() => workflow.calls[0].messages[0].content.includes('Custom merge focus: key ownership.') && workflow.calls[0].messages[0].content.includes('Deduplicate') && workflow.context.extensionSettings.silly_memories_plus.prompts.rollup.startsWith('Custom merge')));
  await reset();
  await page.evaluate(() => { workflow.mode = 'wait'; });
  await regenerate('c');
  await page.waitForFunction(() => Boolean(workflow.pending));
  await page.evaluate(async () => { workflow.context.characters.at(-1).chat = 'during-job'; await workflow.script.eventSource.emit(workflow.script.event_types.CHAT_CHANGED); });
  await page.waitForFunction(() => !document.getElementById('smp-generate-preview').disabled);
  await check('chat-change-during-job-no-write', () => page.evaluate(() => document.getElementById('smp-regeneration').hidden && JSON.stringify(workflow.context.chatMetadata.silly_memories_plus) === JSON.stringify(workflow.memory) && document.getElementById('smp-status').dataset.kind === 'idle'));
  await reset();
  await page.evaluate(() => { workflow.mode = 'long-title'; });
  await regenerate('c');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await page.locator('#smp-save-preview').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  await check('long-title-keeps-valid-memory', () => page.evaluate(() => workflow.context.chatMetadata.silly_memories_plus.blocks.find(x => x.id === 'c').structured.title.length <= 80));
  await reset();
  await regenerate('c', 'Keep the relationship changes.');
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await check('narrow-layout-and-title', () => page.evaluate(() => {
    const root = document.getElementById('smp-settings');
    const bounds = root.getBoundingClientRect();
    return root.scrollWidth <= root.clientWidth + 1 && [...root.querySelectorAll('.smp-block-title')].every(x => x.getBoundingClientRect().right <= bounds.right + 1);
  }));
  await page.evaluate(() => { document.getElementById('smp-settings').style.width = '800px'; });
  await check('wide-comparison-side-by-side', () => page.evaluate(() => { const sections = [...document.querySelectorAll('#smp-regeneration-comparison > section')]; return sections[0].getBoundingClientRect().top === sections[1].getBoundingClientRect().top; }));
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'regeneration-preview.png') });
  await page.evaluate(() => { document.getElementById('smp-settings').style.width = '430px'; });
  await page.locator('#smp-save-preview').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
  await card('c').locator('summary').click();
  await card('c').locator('[data-smp-block-action="edit"]').click();
  await card('c').locator('input[data-field="title"]').fill('Return of the brass key');
  await card('c').locator('[data-smp-block-action="save-edit"]').click();
  await page.waitForFunction(() => workflow.context.chatMetadata.silly_memories_plus.blocks.find(x => x.id === 'c').structured.title === 'Return of the brass key');
  await check('title-edit-preserves-ledger', () => page.evaluate(() => workflow.context.chatMetadata.silly_memories_plus.blocks.find(x => x.id === 'c').structured.relationships[0] === 'Mira trusts Rowan after he returned the key.'));
  await page.evaluate(() => { document.getElementById('smp-settings').style.width = '320px'; });
  await check('320px-no-horizontal-overflow', () => page.evaluate(() => { const root = document.getElementById('smp-settings'); return root.scrollWidth <= root.clientWidth + 1; }));
  await page.evaluate(() => { document.getElementById('smp-settings').style.width = '430px'; });
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'active-library.png') });
  await page.locator('[data-smp-tab="archive"]').click();
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'archive-library.png') });
} catch (error) {
  failure = String(error?.stack || error);
  await page.screenshot({ path: resolve(directory, 'failure.png') });
  throw error;
} finally {
  await writeFile(resolve(directory, 'workflow-report.json'), JSON.stringify({ passed: results.filter(x => x.passed).length, failure, results }, null, 2));
  await browser.close();
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
