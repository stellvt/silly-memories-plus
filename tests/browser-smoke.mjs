import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const baseUrl = process.env.SMP_BASE_URL || 'http://127.0.0.1:8000';
const executablePath = process.env.SMP_BROWSER_EXECUTABLE;
const modulesPath = process.env.CODEX_NODE_MODULES;
const screenshotPath = process.env.SMP_SCREENSHOT;
const runLiveSummarizer = process.env.SMP_LIVE_SUMMARIZER === '1';

if (!executablePath) throw new Error('SMP_BROWSER_EXECUTABLE is required');
if (!modulesPath) throw new Error('CODEX_NODE_MODULES is required');

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(modulesPath, 'playwright'));
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
const extensionResponses = [];

page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', error => consoleErrors.push(String(error?.stack || error)));
page.on('response', response => {
  if (response.url().includes('/scripts/extensions/third-party/silly-memories-plus/')) {
    extensionResponses.push({ url: response.url(), status: response.status() });
  }
});

try {
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!response?.ok()) throw new Error(`SillyTavern returned HTTP ${response?.status()}`);

  await page.waitForFunction(() => Boolean(globalThis.SillyTavern), null, { timeout: 30000 });
  await page.waitForFunction(
    () => typeof globalThis.sillyMemoriesPlusGenerateInterceptor === 'function',
    null,
    { timeout: 30000 },
  );
  await page.waitForSelector('#smp-settings', { state: 'attached', timeout: 30000 });

  const interceptorSmoke = await page.evaluate(async () => {
    const chat = [
      { index: 0, name: 'User', mes: 'Synthetic browser smoke input.', is_user: true, is_system: false, extra: {} },
      { index: 1, name: 'Character', mes: 'Synthetic browser smoke response.', is_user: false, is_system: false, extra: {} },
    ];
    let aborted = false;
    await globalThis.sillyMemoriesPlusGenerateInterceptor(chat, 80000, () => { aborted = true; }, 'normal');
    return {
      aborted,
      messageCount: chat.length,
      messagesPreserved: chat.every(message => !message.extra?.sillyMemoriesPlus),
    };
  });

  const rewriteSmoke = await page.evaluate(async () => {
    const context = globalThis.SillyTavern.getContext();
    const memoryKey = 'silly_memories_plus';
    const originalChat = [...context.chat];
    const hadMemory = Object.hasOwn(context.chatMetadata, memoryKey);
    const originalMemory = context.chatMetadata[memoryKey];
    const storedChat = [
      { name: 'User', mes: 'Covered source message.', is_user: true, is_system: false, extra: {} },
      { name: 'Character', mes: 'Later covered source message.', is_user: false, is_system: false, extra: {} },
      { name: 'Character', mes: 'Newest raw tail message.', is_user: false, is_system: false, extra: {} },
    ];
    const outgoingChat = storedChat.map((message, index) => ({ ...message, index, extra: { ...message.extra } }));

    try {
      context.chat.splice(0, context.chat.length, ...storedChat);
      context.chatMetadata[memoryKey] = {
        schemaVersion: 3,
        blocks: [{
          id: 'browser-smoke-block',
          level: 2,
          structured: {
            narrative: 'Canonical covered memory.',
            relationships: Array.from(
              { length: 40 },
              (_, index) => `Relationship ${index + 1}: Mira and Rowan maintain a deliberately very long relationship description for wrapping verification.`,
            ),
            importantItems: ['A deliberately long brass observatory key description for wrapping verification.'],
            characterStates: [],
            locations: [],
            commitments: [],
            openThreads: [],
            resolvedThreads: [],
            worldFacts: [],
            exactTerms: [],
          },
          sourceFrom: 0,
          sourceTo: 0,
          sourceTokens: 100,
          summaryTokens: 20,
          sourceHash: 'browser-smoke',
          sourceFingerprints: [],
          children: [],
          status: 'active',
          createdAt: Date.now() + 1,
        }, {
          id: 'browser-smoke-later-block',
          level: 2,
          structured: {
            narrative: 'Later canonical memory.',
            relationships: [],
            importantItems: [],
            characterStates: [],
            locations: [],
            commitments: [],
            openThreads: [],
            resolvedThreads: [],
            worldFacts: [],
            exactTerms: [],
          },
          sourceFrom: 1,
          sourceTo: 1,
          sourceTokens: 100,
          summaryTokens: 20,
          sourceHash: 'browser-smoke-later',
          sourceFingerprints: [],
          children: [],
          status: 'active',
          createdAt: Date.now(),
        }],
      };

      document.getElementById('smp-refresh')?.click();
      const libraryRendered = Boolean(document.querySelector('#smp-library .smp-block'))
        && document.getElementById('smp-library')?.textContent?.includes('Canonical covered memory.');
      document.querySelector('#smp-library .smp-block > summary')?.click();
      const blockSelected = document.querySelector('#smp-library .smp-block')?.classList.contains('smp-selected') === true;
      const blockActionsEnabled = [
        'smp-regenerate-block',
        'smp-copy-block',
        'smp-export-block',
      ].every(id => document.getElementById(id)?.disabled === false);
      const localActions = [...document.querySelectorAll('#smp-library .smp-block-local-actions [data-smp-block-action]')];
      const editNearBlock = localActions.some(button => button.dataset.smpBlockAction === 'edit');
      const deleteNearBlock = localActions.some(button => button.dataset.smpBlockAction === 'delete');
      const rawToggleNearBlock = localActions.some(button => button.dataset.smpBlockAction === 'toggle-raw');
      const rollupControls = [...document.querySelectorAll('#smp-library [data-smp-rollup-select]')];
      const manualRollupLevel = rollupControls.length === 2
        && rollupControls.every(control => control instanceof HTMLButtonElement && Boolean(control.closest('.smp-block > summary')));
      const openStatesBeforeLevelClick = [...document.querySelectorAll('#smp-library .smp-block')]
        .map(block => block.open);
      for (const control of rollupControls) control.click();
      const levelSelectionVisible = rollupControls.every(control => control.getAttribute('aria-pressed') === 'true');
      const levelClickKeepsExpansion = [...document.querySelectorAll('#smp-library .smp-block')]
        .every((block, index) => block.open === openStatesBeforeLevelClick[index]);
      const rollupButton = document.getElementById('smp-rollup-selected');
      const dynamicL2ToL3Merge = rollupControls.length === 2
        && rollupButton?.disabled === false
        && rollupButton.querySelector('span')?.textContent === 'Merge L2 → L3';
      for (const control of rollupControls) control.click();
      const structured = document.querySelector('#smp-library .smp-structured');
      const narrativeAsSection = Boolean(structured?.querySelector('section[data-section="narrative"] p'))
        && !document.querySelector('#smp-library .smp-block > pre');
      const settingsRoot = document.getElementById('smp-settings');
      const settingsParent = settingsRoot?.parentNode;
      const settingsNextSibling = settingsRoot?.nextSibling;
      const previousSettingsStyle = settingsRoot?.getAttribute('style');
      if (settingsRoot instanceof HTMLElement) {
        document.body.append(settingsRoot);
        Object.assign(settingsRoot.style, {
          display: 'block',
          position: 'fixed',
          inset: '0 auto auto 0',
          width: '540px',
          zIndex: '99999',
        });
      }
      const drawerContent = document.querySelector('#smp-settings > .inline-drawer-content');
      const previousDrawerDisplay = drawerContent?.style.display || '';
      if (drawerContent instanceof HTMLElement) drawerContent.style.display = 'block';
      const localButtonHeights = localActions
        .map(button => Math.round(button.getBoundingClientRect().height * 100) / 100)
        .filter(height => height > 0);
      const localButtonsEqualHeight = localButtonHeights.length > 0
        && new Set(localButtonHeights).size === 1;
      const structuredSections = [...(structured?.querySelectorAll('section') || [])];
      const firstSection = structuredSections[0]?.getBoundingClientRect();
      const secondSection = structuredSections[1]?.getBoundingClientRect();
      const singleColumnStructured = Boolean(firstSection && secondSection)
        && Math.abs(firstSection.left - secondSection.left) < 1
        && secondSection.top >= firstSection.bottom;
      const longTextWraps = getComputedStyle(document.querySelector('#smp-library .smp-structured li')).overflowWrap === 'anywhere';
      const blockScroll = document.querySelector('#smp-library .smp-block-scroll');
      const blockScrollStyle = blockScroll ? getComputedStyle(blockScroll) : null;
      const blockHasOwnScrollbar = blockScrollStyle?.overflowY === 'auto'
        && blockScrollStyle.scrollbarGutter.includes('stable');
      const blockActuallyScrollable = Boolean(blockScroll)
        && blockScroll.clientHeight > 0
        && blockScroll.scrollHeight > blockScroll.clientHeight;
      const blockScrollMetrics = blockScroll ? {
        clientHeight: blockScroll.clientHeight,
        scrollHeight: blockScroll.scrollHeight,
        maxHeight: blockScrollStyle?.maxHeight,
      } : null;
      document.querySelector('#smp-library [data-smp-block-action="edit"]')?.click();
      const blockElement = document.querySelector('#smp-library .smp-block');
      const editor = blockElement?.querySelector('.smp-inline-editor');
      const blockView = blockElement?.querySelector('.smp-block-view');
      const editorVisible = editor?.hidden === false && blockView?.hidden === true;
      const editorComplete = editor?.querySelectorAll('textarea[data-field]').length === 10;
      const editorPrefilled = editor?.querySelector('textarea[data-field="narrative"]')?.value === 'Canonical covered memory.';
      const editorLivesInsideBlock = editor?.closest('.smp-block') === blockElement;
      editor?.querySelector('[data-smp-block-action="cancel-edit"]')?.click();
      if (drawerContent instanceof HTMLElement) drawerContent.style.display = previousDrawerDisplay;
      if (settingsRoot instanceof HTMLElement && settingsParent) {
        if (settingsNextSibling?.parentNode === settingsParent) settingsParent.insertBefore(settingsRoot, settingsNextSibling);
        else settingsParent.append(settingsRoot);
        if (previousSettingsStyle === null) settingsRoot.removeAttribute('style');
        else settingsRoot.setAttribute('style', previousSettingsStyle);
      }

      await globalThis.sillyMemoriesPlusGenerateInterceptor(outgoingChat, 80000, () => {}, 'normal');
      context.chatMetadata[memoryKey].blocks.find(block => block.id === 'browser-smoke-block').useRaw = true;
      const outgoingWithRawBlock = storedChat.map((message, index) => ({ ...message, index, extra: { ...message.extra } }));
      await globalThis.sillyMemoriesPlusGenerateInterceptor(outgoingWithRawBlock, 80000, () => {}, 'normal');
      return {
        outgoingCount: outgoingChat.length,
        memoryInjectedFirst: outgoingChat[0]?.extra?.sillyMemoriesPlus === true,
        rawTailPreserved: outgoingChat[1]?.mes === 'Newest raw tail message.',
        coveredRawHidden: !outgoingChat.some(message => message.mes === 'Covered source message.'),
        storedChatUntouched: context.chat[0]?.mes === 'Covered source message.'
          && context.chat[1]?.mes === 'Later covered source message.'
          && context.chat[2]?.mes === 'Newest raw tail message.',
        rawBlockRestoresSource: outgoingWithRawBlock.length === 3
          && outgoingWithRawBlock[0]?.mes === 'Covered source message.'
          && outgoingWithRawBlock[1]?.extra?.sillyMemoriesPlus === true
          && outgoingWithRawBlock[1]?.mes?.includes('Later canonical memory.')
          && outgoingWithRawBlock[2]?.mes === 'Newest raw tail message.',
        libraryRendered,
        blockSelected,
        blockActionsEnabled,
        editNearBlock,
        deleteNearBlock,
        rawToggleNearBlock,
        manualRollupLevel,
        levelSelectionVisible,
        levelClickKeepsExpansion,
        localButtonsEqualHeight,
        localButtonHeights,
        dynamicL2ToL3Merge,
        narrativeAsSection,
        editorVisible,
        editorComplete,
        editorPrefilled,
        editorLivesInsideBlock,
        singleColumnStructured,
        longTextWraps,
        blockHasOwnScrollbar,
        blockActuallyScrollable,
        blockScrollMetrics,
      };
    } finally {
      context.chat.splice(0, context.chat.length, ...originalChat);
      if (hadMemory) context.chatMetadata[memoryKey] = originalMemory;
      else delete context.chatMetadata[memoryKey];
      document.getElementById('smp-refresh')?.click();
    }
  });

  const percentageSmoke = await page.evaluate(() => {
    const trigger = document.getElementById('smp-trigger');
    const tail = document.getElementById('smp-tail');
    if (!(trigger instanceof HTMLInputElement) || !(tail instanceof HTMLInputElement)) {
      return { numericInputs: false, triggerUpdatesTail: false, tailUpdatesTrigger: false, restored: false };
    }

    const originalTrigger = trigger.value;
    const originalTail = tail.value;
    trigger.value = '80';
    trigger.dispatchEvent(new Event('input', { bubbles: true }));
    const triggerUpdatesTail = tail.value === '20';

    tail.value = '30';
    tail.dispatchEvent(new Event('input', { bubbles: true }));
    const tailUpdatesTrigger = trigger.value === '70';

    trigger.value = originalTrigger;
    trigger.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      numericInputs: trigger.type === 'number' && tail.type === 'number',
      triggerUpdatesTail,
      tailUpdatesTrigger,
      restored: trigger.value === originalTrigger && tail.value === originalTail,
    };
  });

  let summarizerSmoke = { skipped: true, passed: false, status: '' };
  if (runLiveSummarizer) {
    await page.evaluate(() => document.getElementById('smp-test-summarizer')?.click());
    await page.waitForFunction(
      () => ['success', 'error'].includes(document.getElementById('smp-status')?.dataset?.kind),
      null,
      { timeout: 240000 },
    );
    summarizerSmoke = await page.evaluate(() => {
      const status = document.getElementById('smp-status');
      return {
        skipped: false,
        passed: status?.dataset?.kind === 'success',
        status: status?.textContent || '',
      };
    });
  }

  const state = await page.evaluate(() => ({
    title: document.title,
    interceptorType: typeof globalThis.sillyMemoriesPlusGenerateInterceptor,
    settingsPresent: Boolean(document.getElementById('smp-settings')),
    statusText: document.getElementById('smp-status')?.textContent || '',
    statsText: document.getElementById('smp-stats')?.textContent || '',
    controls: [
      'smp-enabled',
      'smp-trigger',
      'smp-tail',
      'smp-block-target',
      'smp-input-budget',
      'smp-output-budget',
      'smp-summary-profile',
      'smp-prompt-raw',
      'smp-prompt-rollup',
      'smp-prompt-reduce',
      'smp-reset-prompts',
      'smp-compact-now',
      'smp-rollup-selected',
      'smp-export',
      'smp-regenerate-block',
      'smp-copy-block',
      'smp-export-block',
    ].every(id => Boolean(document.getElementById(id))),
    promptTemplatesPresent: ['smp-prompt-raw', 'smp-prompt-rollup', 'smp-prompt-reduce']
      .every(id => document.getElementById(id)?.value?.includes('{{schema}}')),
    thematicSubmenus: [...document.querySelectorAll('#smp-settings .smp-submenu')].map(item => item.dataset.section),
    openSubmenus: document.querySelectorAll('#smp-settings .smp-submenu[open]').length,
    drawerCollapsed: getComputedStyle(document.querySelector('#smp-settings > .inline-drawer-content')).display === 'none'
      && document.querySelector('#smp-settings > .inline-drawer-header .inline-drawer-icon')?.classList.contains('down'),
    actionSpacing: [...document.querySelectorAll('#smp-settings .smp-actions .menu_button')].every(button =>
      button.children.length === 2
      && button.firstElementChild?.matches('i')
      && button.lastElementChild?.matches('span')
      && parseFloat(getComputedStyle(button).columnGap) >= 5),
    uniformButtonText: (() => {
      const mergeButton = document.getElementById('smp-rollup-selected');
      const buttons = [...document.querySelectorAll('#smp-settings .menu_button')];
      if (!mergeButton || !buttons.length) return false;
      const targetSize = getComputedStyle(mergeButton).fontSize;
      return buttons.every(button => getComputedStyle(button).fontSize === targetSize);
    })(),
    disabledExtensions: globalThis.SillyTavern?.getContext?.().extensionSettings?.disabledExtensions || [],
  }));

  const failedResponses = extensionResponses.filter(item => item.status >= 400);
  const relevantErrors = consoleErrors.filter(error => /silly.memories.plus|silly-memories-plus|core\.mjs/i.test(error));
  if (screenshotPath) {
    await page.evaluate(() => {
      const source = document.getElementById('smp-settings');
      const host = document.createElement('div');
      host.id = 'smp-browser-preview';
      host.style.cssText = 'position:absolute;left:0;top:0;width:920px;padding:24px;background:#202225;z-index:2147483647;';
      const clone = source.cloneNode(true);
      clone.style.display = 'block';
      const content = clone.querySelector('.inline-drawer-content');
      if (content) content.style.display = 'block';
      host.append(clone);
      document.body.append(host);
    });
    await page.locator('#smp-browser-preview').screenshot({ path: screenshotPath });
  }
  const result = { state, interceptorSmoke, rewriteSmoke, percentageSmoke, summarizerSmoke, extensionResponses, failedResponses, relevantErrors };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!state.settingsPresent || !state.controls || !state.promptTemplatesPresent || state.interceptorType !== 'function') process.exitCode = 1;
  if (!state.drawerCollapsed || !state.actionSpacing || !state.uniformButtonText) process.exitCode = 1;
  if (state.thematicSubmenus.join(',') !== 'compaction,summarizer,prompts,runtime,memory' || state.openSubmenus !== 1) process.exitCode = 1;
  if (!percentageSmoke.numericInputs || !percentageSmoke.triggerUpdatesTail || !percentageSmoke.tailUpdatesTrigger || !percentageSmoke.restored) process.exitCode = 1;
  if (runLiveSummarizer && !summarizerSmoke.passed) process.exitCode = 1;
  if (interceptorSmoke.aborted || interceptorSmoke.messageCount !== 2 || !interceptorSmoke.messagesPreserved) process.exitCode = 1;
  if (!rewriteSmoke.memoryInjectedFirst || !rewriteSmoke.rawTailPreserved || !rewriteSmoke.coveredRawHidden || !rewriteSmoke.storedChatUntouched || !rewriteSmoke.rawBlockRestoresSource || !rewriteSmoke.libraryRendered || !rewriteSmoke.blockSelected || !rewriteSmoke.blockActionsEnabled || !rewriteSmoke.editNearBlock || !rewriteSmoke.deleteNearBlock || !rewriteSmoke.rawToggleNearBlock || !rewriteSmoke.manualRollupLevel || !rewriteSmoke.levelSelectionVisible || !rewriteSmoke.levelClickKeepsExpansion || !rewriteSmoke.localButtonsEqualHeight || !rewriteSmoke.dynamicL2ToL3Merge || !rewriteSmoke.narrativeAsSection || !rewriteSmoke.editorVisible || !rewriteSmoke.editorComplete || !rewriteSmoke.editorPrefilled || !rewriteSmoke.editorLivesInsideBlock || !rewriteSmoke.singleColumnStructured || !rewriteSmoke.longTextWraps || !rewriteSmoke.blockHasOwnScrollbar || !rewriteSmoke.blockActuallyScrollable) process.exitCode = 1;
  if (failedResponses.length || relevantErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
