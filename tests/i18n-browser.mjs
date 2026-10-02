import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failure scenarios: untranslated menus/cards/errors, host-language leakage,
// missing Russian keys, lost drafts/open cards/previews, translated user data
// or prompts, stale job statuses, unsaved language, and narrow-panel overflow.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.env.CODEX_NODE_MODULES, 'playwright'));
const directory = process.env.SMP_ARTIFACT_DIR;
assert.ok(directory && process.env.SMP_BROWSER_EXECUTABLE);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SMP_BROWSER_EXECUTABLE, headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 1100 } });
const page = await context.newPage();
const results = [];
let failure = null;
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save/, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
try {
  await page.goto(process.env.SMP_BASE_URL || 'http://127.0.0.1:8001');
  await page.waitForFunction(() => typeof sillyMemoriesPlusGenerateInterceptor === 'function');
  await page.waitForSelector('#smp-language', { state: 'attached' });
  await page.locator('#preloader').waitFor({ state: 'hidden' });
  await page.evaluate(async () => {
    const script = await import('/script.js');
    const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
    const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
    const { Popup } = await import('/scripts/popup.js');
    for (const popup of [...Popup.util.popups]) if (popup.dlg.open) await popup.complete(1);
    const chat = SillyTavern.getContext();
    chat.characters.push({ name: 'Locale test', avatar: 'none', chat: 'locale-test', data: {} });
    script.setCharacterId(chat.characters.length - 1);
    const structured = { title: 'Keep this title', narrative: 'Keep this narrative.', relationships: ['Keep this relationship.'], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] };
    chat.chat.splice(0, chat.chat.length, ...[0, 1].map(index => ({ mes: `Original source ${index}`, name: 'Mira', is_user: index === 0, is_system: false, extra: {} })));
    chat.chatMetadata.silly_memories_plus = core.normalizeMemory({ schemaVersion: 3, pinnedFacts: 'Keep these facts.', blocks: [{ id: 'locale-block', level: 1, structured, sourceFrom: 0, sourceTo: 0, sourceTokens: 4000, summaryTokens: 80, rawTokens: 4000, children: [], sourceFingerprints: [], status: 'active', createdAt: 1 }] });
    chat.extensionSettings.silly_memories_plus.summaryProfileId = 'locale-test';
    service.getProfile = () => ({ id: 'locale-test' });
    service.getSupportedProfiles = () => [{ id: 'locale-test', name: 'Locale test profile' }];
    service.validateProfile = () => ({ selected: 'openai' });
    globalThis.localeTest = { script, core, chat, before: JSON.stringify(chat.chatMetadata.silly_memories_plus), prompts: JSON.stringify(chat.extensionSettings.silly_memories_plus.prompts), pending: null };
    service.sendRequest = async (_, messages, maxTokens, options) => {
      if (localeTest.empty) return { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] };
      await new Promise((resolve, reject) => {
        localeTest.pending = resolve;
        options.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      });
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...structured, narrative: 'Generated variant.' }) } }] };
    };
    globalThis.confirm = text => { localeTest.confirmation = text; return false; };
    const root = document.getElementById('smp-settings');
    document.body.append(root);
    root.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:430px;max-height:100vh;overflow:auto;background:#202225;z-index:99999';
    root.querySelector('.inline-drawer-content').style.display = 'block';
    await script.eventSource.emit(script.event_types.CHAT_CHANGED);
  });
  async function check(name, run) {
    const passed = Boolean(await run());
    results.push({ name, passed });
    assert.equal(passed, true, name);
  }
  async function language(value) {
    await page.evaluate(value => {
      const input = document.getElementById('smp-language');
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await page.waitForFunction(value => SillyTavern.getContext().extensionSettings.silly_memories_plus.language === value, value);
  }
  const card = page.locator('[data-block-id="locale-block"]');
  await language('en');
  await check('english-static-ui', () => page.locator('[data-section="facts"] > summary').textContent().then(text => text.includes('Pinned facts')));
  if (!await page.locator('[data-section="memory"]').evaluate(element => element.open)) {
    await page.locator('[data-section="memory"] > summary').click();
  }
  await card.locator(':scope > summary').click();
  await card.locator('[data-smp-block-action="edit"]').click();
  await card.locator('[data-field="narrative"]').fill('Unsaved narrative draft.');
  await page.evaluate(() => { document.getElementById('smp-pinned-facts').value = 'Unsaved facts draft.'; });
  const host = await page.evaluate(() => ({ language: localStorage.getItem('language'), title: document.title }));
  await language('ru');
  await check('russian-static-ui', () => page.evaluate(() => document.querySelector('[data-section="facts"] > summary').textContent.includes('Закреплённые факты') && document.getElementById('smp-save-facts').textContent.includes('Сохранить факты')));
  await check('russian-editor-and-card', () => page.evaluate(() => document.querySelector('.smp-inline-editor').textContent.includes('Повествование') && document.querySelector('[data-smp-block-action="delete"]').textContent.includes('Удалить') && document.querySelector('.smp-block > summary').textContent.includes('активен')));
  await check('language-switch-preserves-drafts-and-open-card', () => page.evaluate(() => document.querySelector('[data-field="narrative"]').value === 'Unsaved narrative draft.' && document.querySelector('.smp-block').open && document.getElementById('smp-pinned-facts').value === 'Unsaved facts draft.'));
  await check('language-does-not-change-memory-or-prompts', () => page.evaluate(() => JSON.stringify(localeTest.chat.chatMetadata.silly_memories_plus) === localeTest.before && JSON.stringify(localeTest.chat.extensionSettings.silly_memories_plus.prompts) === localeTest.prompts));
  await check('override-does-not-change-host', () => page.evaluate(host => localStorage.getItem('language') === host.language && document.title === host.title, host));
  await page.evaluate(() => document.getElementById('smp-clear').click());
  await check('russian-confirmation', () => page.evaluate(() => localeTest.confirmation.includes('закреплённые факты')));
  await check('russian-domain-errors', () => page.evaluate(() => { try { localeTest.core.parseStructuredSummary('{}'); return false; } catch (error) { return error.message.includes('повествования'); } }));
  await check('interpolated-user-text-is-not-translated', () => page.evaluate(async () => {
    const { t } = await import('/scripts/extensions/third-party/silly-memories-plus/lib/i18n.mjs');
    return t`Summarizer test passed (${10}t): ${'Delete'}`.endsWith('Delete');
  }));
  await page.waitForFunction(() => document.querySelector('.smp-context-heading')?.textContent.includes('Контекст'));
  await check('russian-context-and-status', () => page.evaluate(() => document.querySelector('.smp-context-legend').textContent.includes('История') && document.getElementById('smp-status').textContent.includes('Готов')));
  await page.locator('[data-smp-block-action="cancel-edit"]').click();
  await page.locator('#smp-regenerate-block').click();
  await page.locator('#smp-regeneration-wish').fill('Keep original names.');
  await page.locator('#smp-generate-preview').click();
  await page.waitForFunction(() => Boolean(localeTest.pending));
  await check('russian-job-status', () => page.evaluate(() => document.getElementById('smp-status').textContent.includes('Регенерация')));
  await language('en');
  await check('switch-during-job-preserves-job-and-wish', () => page.evaluate(() => document.getElementById('smp-status').textContent.includes('Regenerating') && document.getElementById('smp-regeneration-wish').value === 'Keep original names.' && document.getElementById('smp-cancel').disabled === false));
  await page.evaluate(() => localeTest.pending());
  await page.waitForSelector('#smp-regeneration-preview:not([hidden])');
  await language('ru');
  await check('switch-preserves-and-translates-preview', () => page.evaluate(() => !document.getElementById('smp-regeneration-preview').hidden && document.getElementById('smp-regeneration-comparison').textContent.includes('Новый вариант') && document.getElementById('smp-regeneration-comparison').textContent.includes('Generated variant.')));
  await language('en');
  await check('return-to-english', () => page.evaluate(() => document.getElementById('smp-save-facts').textContent.includes('Save facts') && document.querySelector('.smp-block > summary').textContent.includes('active') && document.querySelector('.smp-context-heading').textContent.includes('Context')));
  await language('ru');
  await page.locator('#smp-discard-preview').click();
  await page.evaluate(() => { localeTest.empty = true; });
  await page.locator('#smp-regenerate-block').click();
  await page.locator('#smp-generate-preview').click();
  await page.waitForFunction(() => document.getElementById('smp-status').dataset.kind === 'error');
  await check('empty-schema-validation-independent-of-language', () => page.evaluate(() => document.getElementById('smp-status').textContent.includes('пустой объект') && JSON.stringify(localeTest.chat.chatMetadata.silly_memories_plus) === localeTest.before));
  await language('en');
  await check('error-status-switches-language', () => page.evaluate(() => document.getElementById('smp-status').textContent.includes('empty structured object')));
  await language('ru');
  await page.locator('#smp-close-regeneration').click();
  await page.evaluate(() => { document.getElementById('smp-settings').style.width = '320px'; });
  await check('russian-320px-no-overflow', () => page.evaluate(() => { const root = document.getElementById('smp-settings'); return root.scrollWidth <= root.clientWidth + 1; }));
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'russian-ui.png') });
  await page.evaluate(() => { document.getElementById('smp-settings').style.width = '430px'; });
  await page.locator('[data-section="runtime"] > summary').click();
  await page.locator('#smp-settings').screenshot({ path: resolve(directory, 'language-control.png') });
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector('#smp-language', { state: 'attached' });
  await check('language-persisted-on-reload', () => page.evaluate(() => document.getElementById('smp-language').value === 'ru' && document.getElementById('smp-save-facts').textContent.includes('Сохранить факты')));
  await language('auto');
  await page.waitForTimeout(1500);
  await page.evaluate(() => { localStorage.setItem('language', 'ru-ru'); });
  await page.reload();
  await page.waitForSelector('#smp-language', { state: 'attached' });
  await check('auto-follows-sillytavern-russian', () => page.evaluate(() => document.getElementById('smp-language').value === 'auto' && document.getElementById('smp-save-facts').textContent.includes('Сохранить факты')));
  await language('en');
  await check('english-override-on-russian-host', () => page.evaluate(() => document.getElementById('smp-save-facts').textContent.includes('Save facts') && localStorage.getItem('language') === 'ru-ru'));
  await language('auto');
  await page.waitForTimeout(1500);
  await page.evaluate(() => { localStorage.setItem('language', 'de-de'); });
  await page.reload();
  await page.waitForSelector('#smp-language', { state: 'attached' });
  await check('unsupported-host-falls-back-to-english', () => page.evaluate(() => document.getElementById('smp-save-facts').textContent.includes('Save facts')));
} catch (error) {
  failure = String(error?.stack || error);
  await page.screenshot({ path: resolve(directory, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(resolve(directory, 'i18n-report.json'), JSON.stringify({ passed: results.filter(x => x.passed).length, failure, results }, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (failure) throw new Error(failure);
