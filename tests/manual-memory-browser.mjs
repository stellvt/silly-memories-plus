import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const page = await browser.newPage();
await page.route(/\/api\/(?:chats|groups)\/.*(?:save|edit)|\/api\/settings\/save/, route => route.fulfill({ json: {} }));
await page.route(/\/api\/backends\/.+\/generate/, route => route.abort());
const results = [];
let failure;
try {
  await page.goto(process.env.SMP_BASE_URL || 'http://127.0.0.1:8001');
  await page.waitForSelector('#smp-library', { state: 'attached' });
  await page.locator('#preloader').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const script = await import('/script.js');
    const { Popup } = await import('/scripts/popup.js');
    const { normalizeSettings, createEmptyMemory } = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const c = SillyTavern.getContext();
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    c.characters.push({ name: 'Mira', avatar: 'none', chat: 'manual-memory-smoke', data: { name: 'Mira', extensions: {} } });
    script.setCharacterId(c.characters.length - 1);
    script.setCharacterName('Mira');
    script.changeMainAPI('openai');
    c.chat.splice(0, c.chat.length, ...Array.from({ length: 6 }, (_, i) => ({
      name: 'Mira', mes: 'Scene ' + i + ':' + ' Mira found clues.'.repeat(200), is_user: i % 2 === 1, extra: {},
    })));
    c.chatMetadata.silly_memories_plus = createEmptyMemory();
    c.extensionSettings.silly_memories_plus = normalizeSettings({ language: 'en', summaryProfileId: 'smoke', blockTargetTokens: 256 });
    const calls = [];
    service.getProfile = () => ({ id: 'smoke' });
    service.validateProfile = () => ({ selected: 'openai' });
    service.sendRequest = async (_, messages) => {
      calls.push(JSON.parse(messages.at(-1).content).map(item => item.index ?? item.source));
      const structured = { title: 'Old key', narrative: 'Mira kept the key.', relationships: [], importantItems: [], characterStates: [],
        locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] };
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structured) } }] };
    };
    const root = document.getElementById('smp-settings');
    document.body.append(root);
    root.style.cssText = 'display:block;width:390px;background:#202225';
    root.querySelector('.inline-drawer-content').style.display = 'block';
    const history = () => JSON.stringify(c.chat.map(({ mes, name, is_user }) => ({ mes, name, is_user })));
    window.smoke = { run: command => c.executeSlashCommandsWithOptions(command), calls, Popup, c, history };
    await script.eventSource.emit(script.event_types.CHAT_CHANGED);
    smoke.original = history();
  });
  const run = command => page.evaluate(command => smoke.run(command), command);
  const snapshot = () => page.evaluate(() => ({
    active: smoke.c.chatMetadata.silly_memories_plus.blocks.filter(b => b.status === 'active')
      .map(b => [b.sourceFrom, b.sourceTo, b.level]),
    retired: smoke.c.chatMetadata.silly_memories_plus.blocks.filter(b => b.status === 'retired').length,
    calls: smoke.calls.length, unchanged: smoke.history() === smoke.original,
  }));
  async function check(name, fn) {
    await fn();
    results.push({ name, passed: true });
  }
  await check('manual controls use compact cards matching the merge panel at 320px', async () => {
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 760 });
    const layout = await page.evaluate(() => {
      const root = document.getElementById('smp-settings');
      root.style.width = '320px';
      root.querySelector('[data-section="runtime"]').open = true;
      const history = document.getElementById('smp-compact-now').closest('.smp-tool-card');
      const range = document.getElementById('smp-compact-range').closest('.smp-tool-card');
      const arc = document.getElementById('smp-checkpoint-at').closest('.smp-tool-card');
      if (!history || !range || !arc) return {};
      const shell = element => {
        const style = getComputedStyle(element);
        return [style.borderRadius, style.borderTop, style.backgroundColor, style.padding];
      };
      const merge = root.querySelector('.smp-rollup-panel');
      const from = document.getElementById('smp-range-from');
      const to = document.getElementById('smp-range-to');
      return { separate: new Set([history, range, arc]).size === 3 && !history.contains(document.getElementById('smp-refresh')),
        noDivider: !root.querySelector('.smp-card-divider'),
        twoColumns: from.getBoundingClientRect().top === to.getBoundingClientRect().top
          && from.getBoundingClientRect().left < to.getBoundingClientRect().left,
        matching: [history, range, arc].every(card => JSON.stringify(shell(card)) === JSON.stringify(shell(merge))),
        fits: [history, range, arc, ...root.querySelectorAll('.smp-tool-card .smp-grid')].every(element => element.scrollWidth <= element.clientWidth + 1) };
    });
    assert.deepEqual(layout, { separate: true, noDivider: true, twoColumns: true, matching: true, fits: true });
    await page.locator('[data-section="runtime"]').screenshot({ path: resolve(directory, 'manual-controls-320px.png') });
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      const root = document.getElementById('smp-settings');
      root.style.width = '390px';
      root.querySelector('[data-section="memory"]').open = true;
    });
  });
  await check('checkpoint command splits inclusive range and updates cards', async () => {
    await run('/smp-checkpoint at=2');
    assert.match((await run('/smp-checkpoints')).pipe, /2/);
    await run('/smp-compact from=1 to=4');
    assert.deepEqual((await snapshot()).active, [[1, 2, 1], [3, 4, 1]]);
    assert.equal(await page.locator('#smp-library .smp-block').count(), 2);
  });
  await check('message hints refresh without filling or overwriting the fields', async () => {
    const from = page.locator('#smp-range-from');
    const to = page.locator('#smp-range-to');
    const at = page.locator('#smp-checkpoint-at');
    assert.deepEqual(await Promise.all([from, to, at].map(field => field.getAttribute('placeholder'))), ['0', '5', '5']);
    assert.equal(await to.inputValue(), '');
    await page.evaluate(async () => {
      document.getElementById('smp-range-to').value = '4';
      smoke.c.chat.push({ name: 'Mira', mes: 'Latest reply', extra: {} });
      const { eventSource, event_types } = await import('/script.js');
      await eventSource.emit(event_types.MESSAGE_RECEIVED, 6);
    });
    assert.equal(await to.getAttribute('placeholder'), '6');
    assert.equal(await at.getAttribute('placeholder'), '6');
    assert.equal(await to.inputValue(), '4');
    await page.evaluate(async () => {
      smoke.c.chat.pop();
      document.getElementById('smp-range-to').value = '';
      const { eventSource, event_types } = await import('/script.js');
      await eventSource.emit(event_types.MESSAGE_DELETED, 6);
    });
    await page.waitForFunction(() => document.getElementById('smp-checkpoint-at').placeholder === '5');
  });
  await check('overlap popup can cancel, then range button can confirm', async () => {
    const rejected = run('/smp-compact from=0 to=1');
    await page.waitForFunction(() => smoke.Popup.util.popups.some(popup => popup.dlg.open && popup.dlg.textContent.includes('Replace overlapping memory')));
    await page.evaluate(() => smoke.Popup.util.popups.find(popup => popup.dlg.open).complete(0));
    await rejected;
    assert.equal((await snapshot()).calls, 2);
    await page.evaluate(() => {
      document.getElementById('smp-range-from').value = '0';
      document.getElementById('smp-range-to').value = '2';
      document.getElementById('smp-compact-range').click();
    });
    await page.waitForFunction(() => smoke.Popup.util.popups.some(popup => popup.dlg.open && popup.dlg.textContent.includes('Replace overlapping memory')));
    await page.evaluate(() => smoke.Popup.util.popups.find(popup => popup.dlg.open).complete(1));
    await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'success');
    assert.deepEqual(await snapshot(), { active: [[3, 4, 1], [0, 2, 1]], retired: 1, calls: 3, unchanged: true });
  });
  await check('merge command uses selected blocks and arc mark can be removed', async () => {
    await page.locator('#smp-library [data-smp-rollup-select]').evaluateAll(controls => controls.forEach(control => control.click()));
    page.once('dialog', dialog => dialog.accept());
    await run('/smp-merge');
    assert.deepEqual((await snapshot()).active, [[0, 4, 2]]);
    await run('/smp-uncheckpoint at=2');
    assert.match((await run('/smp-checkpoints')).pipe, /No arc ends/);
    assert.equal((await snapshot()).unchanged, true);
  });
  await check('history without a range preserves the fresh tail', async () => {
    await run('/smp-compact');
    assert.deepEqual((await snapshot()).active, [[0, 4, 2]]);
    assert.equal((await snapshot()).calls, 4);
  });
} catch (error) { failure = String(error.stack || error); }
finally {
  await writeFile(resolve(directory, 'manual-memory-smoke.json'), JSON.stringify({ passed: !failure, results, failure }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ results, failure }, null, 2));
if (failure) throw new Error(failure);
