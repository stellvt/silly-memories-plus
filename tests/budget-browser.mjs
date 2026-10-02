import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Failures exercised through the loaded extension: inflated L1 estimates, early
// archive pressure, multiple summary runs, oversize results, provider failure,
// pinned raw history, and the mandatory two-message tail.
const executablePath = process.env.SMP_BROWSER_EXECUTABLE;
const modulesPath = process.env.CODEX_NODE_MODULES;
const artifactDir = process.env.SMP_ARTIFACT_DIR;
if (!executablePath || !modulesPath || !artifactDir) {
  throw new Error('SMP_BROWSER_EXECUTABLE, CODEX_NODE_MODULES and SMP_ARTIFACT_DIR are required');
}
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(modulesPath, 'playwright'));
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
// Synthetic chats must never reach the user's saved chats or model provider.
await page.route(/\/api\/(?:chats|groups)\/.+(?:save|edit)|\/api\/chats\/save/, route =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
const cases = [
  { name: 'small-source', sizes: Array(8).fill(2600), raw: [500, 5000, 5000], budget: 40000, target: 16000, minCalls: 0, maxCalls: 0 },
  { name: 'scaled-l1', sizes: [], raw: [8000, 10000, 10000], budget: 35000, target: 16000, minCalls: 1, maxCalls: 1 },
  { name: 'l1-and-rollup', sizes: Array(14).fill(4180), raw: [8000, 6000, 6000], budget: 80000, target: 4000, minCalls: 2, maxCalls: 2 },
  { name: 'l1-rollup-failure', sizes: Array(14).fill(4180), raw: [8000, 6000, 6000], budget: 80000, target: 4000, failAt: 2, minCalls: 2, maxCalls: 2 },
  { name: 'early-merge', sizes: Array(8).fill(2600), raw: [12000, 5500, 5500], budget: 40000, target: 4000, minCalls: 1 },
  { name: 'multiple-runs', sizes: [2400, 2400, 10, 2400, 2400], pin: 2, pinSize: 14500, raw: [7000, 7000], budget: 30000, target: 1000, minCalls: 2 },
  { name: 'tolerated-output', sizes: Array(8).fill(2600), raw: [12000, 5500, 5500], budget: 40000, target: 4000, output: 4200, minCalls: 1 },
  { name: 'provider-failure', sizes: Array(8).fill(2600), raw: [12000, 5500, 5500], budget: 40000, target: 4000, fail: true, blocked: true, minCalls: 1 },
  { name: 'provider-failure-fitting-chat', sizes: Array(8).fill(2600), raw: [12000, 5500, 5500], budget: 47000, target: 4000, fail: true, minCalls: 1, maxCalls: 1 },
  { name: 'multi-stage-failure', sizes: [2400, 2400, 10, 2400, 2400], pin: 2, pinSize: 14500, raw: [7000, 7000], budget: 30000, target: 1000, failAt: 2, blocked: true, minCalls: 2, maxCalls: 2 },
  { name: 'pinned-raw-limit', sizes: [10], pin: 0, pinSize: 25000, raw: [9000, 9000], budget: 40000, target: 4000, blocked: true, minCalls: 0, maxCalls: 0 },
  { name: 'latest-messages-limit', sizes: [], raw: [25000, 18000], budget: 40000, target: 4000, blocked: true, minCalls: 0, maxCalls: 0 },
];
const results = [];
try {
  await page.goto(process.env.SMP_BASE_URL || 'http://127.0.0.1:8000', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof globalThis.sillyMemoriesPlusGenerateInterceptor === 'function');
  await page.waitForSelector('#smp-settings', { state: 'attached' });
  await page.locator('#preloader').waitFor({ state: 'hidden' });
  for (const scenario of cases) {
    const result = await page.evaluate(async scenario => {
      const context = globalThis.SillyTavern.getContext();
      const core = await import('/scripts/extensions/third-party/silly-memories-plus/lib/core.mjs');
      const { getTokenCountAsync } = await import('/scripts/tokenizers.js');
      const { ConnectionManagerRequestService: service } = await import('/scripts/extensions/shared.js');
      const memoryKey = 'silly_memories_plus';
      const original = {
        chat: [...context.chat], memory: context.chatMetadata[memoryKey],
        settings: context.extensionSettings[memoryKey],
        getProfile: service.getProfile, validateProfile: service.validateProfile, sendRequest: service.sendRequest,
      };
      const structured = narrative => ({ narrative, relationships: [], importantItems: [], characterStates: [], locations: [], commitments: [], openThreads: [], resolvedThreads: [], worldFacts: [], exactTerms: [] });
      const text = size => ' memory'.repeat(size);
      const calls = [];
      try {
        context.extensionSettings[memoryKey] = core.normalizeSettings({
          enabled: true, summaryProfileId: 'budget-e2e', blockTargetTokens: scenario.target,
          summaryInputBudgetTokens: 1000000, summaryMaxOutputTokens: 32768,
        });
        const blocks = await Promise.all(scenario.sizes.map(async (size, index) => {
          const block = {
            id: `budget-${index}`, level: 1, structured: structured(text(size)),
            sourceFrom: index, sourceTo: index, sourceTokens: size * 4,
            summaryTokens: 0, sourceFingerprints: [], children: [], status: 'active',
            useRaw: index === scenario.pin, createdAt: index,
          };
          block.summaryTokens = await getTokenCountAsync(core.renderBlockText(block), 0);
          return block;
        }));
        const stored = scenario.sizes.map((_, index) => ({
          name: 'User', mes: text(index === scenario.pin ? scenario.pinSize : 20),
          is_user: true, is_system: false, extra: {},
        }));
        stored.push(...scenario.raw.map(size => ({ name: 'Character', mes: text(size), is_user: false, is_system: false, extra: {} })));
        if (scenario.pin != null) blocks[scenario.pin].rawTokens = await getTokenCountAsync(stored[scenario.pin].mes, 0);
        context.chat.splice(0, context.chat.length, ...stored);
        context.chatMetadata[memoryKey] = { schemaVersion: 3, blocks };
        service.getProfile = () => ({ id: 'budget-e2e' });
        service.validateProfile = () => ({ selected: 'openai' });
        service.sendRequest = async (profileId, messages, maxTokens, options) => {
          calls.push({ profileId, maxTokens, stream: options.stream, system: messages[0].content });
          if (scenario.fail || calls.length === scenario.failAt) throw new Error('Synthetic provider unavailable');
          return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structured(text(scenario.output || 250))) } }] };
        };
        const outgoing = stored.map((message, index) => ({ ...message, index, extra: { ...message.extra } }));
        const countedRaw = await Promise.all(outgoing.slice(blocks.length).map(async message => ({ index: message.index, message, tokens: await getTokenCountAsync(message.mes, 0) })));
        const initialPlan = core.buildCompactionPlan({ contextBudget: scenario.budget, blocks, rawEntries: countedRaw, settings: context.extensionSettings[memoryKey] });
        let aborted = false;
        await globalThis.sillyMemoriesPlusGenerateInterceptor(outgoing, scenario.budget, () => { aborted = true; }, 'normal');
        const saved = context.chatMetadata[memoryKey];
        const active = core.getActiveBlocks(saved);
        const outgoingTokens = (await Promise.all(outgoing.map(message => getTokenCountAsync(message.mes, 0)))).reduce((sum, count) => sum + count, 0);
        const status = document.getElementById('smp-status');
        const root = document.getElementById('smp-settings');
        document.body.append(root);
        root.style.cssText = 'display:block;position:fixed;inset:0 auto auto 0;width:780px;background:#202225;z-index:99999';
        root.querySelector('.inline-drawer-content').style.display = 'block';
        root.querySelector('[data-section="runtime"]').open = true;
        return {
          name: scenario.name, aborted, calls: calls.map(call => ({ maxTokens: call.maxTokens, stream: call.stream })),
          initialPlan: { kind: initialPlan.kind, reason: initialPlan.reason, totalTokens: initialPlan.totalTokens, projectedTokens: initialPlan.projectedTokens },
          status: status.textContent, statusKind: status.dataset.kind, outgoingTokens,
          active: active.map(block => ({ id: block.id, level: block.level, useRaw: block.useRaw, from: block.sourceFrom, to: block.sourceTo })),
          tailPreserved: outgoing.slice(-2).every((message, index) => message.mes === stored.at(-2 + index).mes),
          storedChatUntouched: JSON.stringify(context.chat) === JSON.stringify(stored),
          memoryUnchanged: active.length === blocks.length && active.every(block => block.id.startsWith('budget-')),
          pinPreserved: scenario.pin == null || outgoing.some(message => message.index === scenario.pin && message.mes === stored[scenario.pin].mes),
        };
      } finally {
        service.getProfile = original.getProfile;
        service.validateProfile = original.validateProfile;
        service.sendRequest = original.sendRequest;
        context.chat.splice(0, context.chat.length, ...original.chat);
        context.chatMetadata[memoryKey] = original.memory;
        context.extensionSettings[memoryKey] = original.settings;
      }
    }, scenario);
    results.push(result);
    process.stdout.write(`${scenario.name}: ${result.aborted ? 'blocked' : 'continued'}, ${result.calls.length} request(s), ${result.status}\n`);
    await mkdir(artifactDir, { recursive: true });
    await page.evaluate(async () => {
      const { Popup } = await import('/scripts/popup.js');
      for (const popup of [...Popup.util.popups]) {
        if (popup.dlg.open) await popup.complete(1);
      }
    });
    await page.locator('#smp-settings').screenshot({ path: resolve(artifactDir, `${scenario.name}.png`) });
  }
  await writeFile(resolve(artifactDir, 'budget-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  for (const [index, result] of results.entries()) {
    const scenario = cases[index];
    assert.equal(result.aborted, Boolean(scenario.blocked), `${scenario.name}: ${result.status}`);
    assert.ok(result.calls.length >= scenario.minCalls, `${scenario.name}: missing automatic merge`);
    if (scenario.maxCalls != null) assert.ok(result.calls.length <= scenario.maxCalls);
    assert.ok(result.storedChatUntouched, `${scenario.name}: stored chat changed`);
    assert.ok(result.pinPreserved, `${scenario.name}: pinned raw history changed`);
    if (!scenario.blocked) {
      assert.ok(result.outgoingTokens <= scenario.budget, `${scenario.name}: final context exceeds budget`);
      assert.ok(result.tailPreserved, `${scenario.name}: newest messages changed`);
    }
    if (scenario.blocked || scenario.fail || scenario.failAt) assert.ok(result.memoryUnchanged, `${scenario.name}: failed transaction committed`);
    if (scenario.name === 'early-merge') assert.ok(result.active.some(block => block.level === 2));
    if (scenario.name === 'scaled-l1') assert.ok(result.active.some(block => block.level === 1));
    if (scenario.name === 'l1-and-rollup') assert.ok(result.active.length === 1 && result.active[0].level === 2);
    if (scenario.name === 'latest-messages-limit') assert.ok(!/Restore|hidden summary/.test(result.status));
    assert.ok(result.calls.every(call => call.stream === false), `${scenario.name}: summarizer requested streaming`);
  }
  process.stdout.write(`Budget browser checks passed (${results.length} scenarios). Artifacts: ${artifactDir}\n`);
} finally {
  await browser.close();
}
