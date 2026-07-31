import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const modulesPath = process.env.CODEX_NODE_MODULES;
const executablePath = process.env.SMP_BROWSER_EXECUTABLE;
const baseUrl = process.env.SMP_BASE_URL || 'http://127.0.0.1:8000';
const proxyUrl = process.env.SMP_PROXY_URL;
const proxyKey = process.env.SMP_PROXY_KEY;
const model = process.env.SMP_PROXY_MODEL || 'gpt-4.1-nano';
const persistProfile = process.env.SMP_PERSIST_PROFILE === '1';
if (!modulesPath || !executablePath || !proxyUrl || !proxyKey) {
  throw new Error('CODEX_NODE_MODULES, SMP_BROWSER_EXECUTABLE, SMP_PROXY_URL and SMP_PROXY_KEY are required');
}

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(modulesPath, 'playwright'));
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
const consoleErrors = [];
const backendResponseObjects = [];
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', error => consoleErrors.push(String(error?.stack || error)));
page.on('response', response => {
  if (response.url().includes('/api/backends/chat-completions/generate')) {
    backendResponseObjects.push(response);
  }
});

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean(globalThis.SillyTavern), null, { timeout: 30000 });
  await page.waitForSelector('#smp-test-summarizer', { state: 'attached', timeout: 30000 });
  await page.waitForFunction(
    () => Boolean(globalThis.SillyTavern.getContext().CONNECT_API_MAP?.openai),
    null,
    { timeout: 30000 },
  );

  const setup = await page.evaluate(async ({ proxyUrl, proxyKey, model, persistProfile }) => {
    const context = globalThis.SillyTavern.getContext();
    const openai = await import('/scripts/openai.js');
    const profileId = persistProfile ? 'silly-memories-plus-gpt-4.1-nano' : `smp-live-${crypto.randomUUID()}`;
    const proxyName = persistProfile ? 'Silly Memories Plus OpenAI' : `SMP Live Proxy ${crypto.randomUUID()}`;
    const profile = {
      id: profileId,
      mode: 'cc',
      name: persistProfile ? 'Silly Memories Plus — gpt-4.1-nano' : 'SMP Live Proxy Smoke',
      api: 'openai',
      model,
      proxy: proxyName,
      preset: '',
      exclude: [],
    };
    const originalMemorySettings = structuredClone(context.extensionSettings.silly_memories_plus || {});
    context.extensionSettings.connectionManager ??= { profiles: [], selectedProfile: null };
    const profiles = context.extensionSettings.connectionManager.profiles;
    const existingProfile = profiles.find(item => item.id === profileId || item.name === profile.name);
    if (existingProfile) Object.assign(existingProfile, profile);
    else profiles.push(profile);
    const existingProxy = openai.proxies.find(item => item.name === proxyName);
    if (existingProxy) Object.assign(existingProxy, { url: proxyUrl, password: proxyKey });
    else openai.proxies.push({ name: proxyName, url: proxyUrl, password: proxyKey });
    context.extensionSettings.silly_memories_plus.summaryProfileId = profileId;
    if (!persistProfile) {
      globalThis.__smpLiveCleanup = async () => {
        const profileIndex = profiles.findIndex(item => item.id === profileId);
        if (profileIndex >= 0) profiles.splice(profileIndex, 1);
        const proxyIndex = openai.proxies.findIndex(item => item.name === proxyName);
        if (proxyIndex >= 0) openai.proxies.splice(proxyIndex, 1);
        context.extensionSettings.silly_memories_plus = originalMemorySettings;
        context.saveSettingsDebounced();
        await new Promise(resolve => setTimeout(resolve, 3000));
      };
    }
    context.saveSettingsDebounced();
    if (persistProfile) await new Promise(resolve => setTimeout(resolve, 3000));
    document.getElementById('smp-test-summarizer').click();
    return { profileId, proxyName, model };
  }, { proxyUrl, proxyKey, model, persistProfile });

  await page.waitForFunction(() => {
    const status = document.getElementById('smp-status');
    return status?.dataset.kind === 'success' || status?.dataset.kind === 'error';
  }, null, { timeout: 240000 });

  const result = await page.evaluate(() => {
    const status = document.getElementById('smp-status');
    return { kind: status?.dataset.kind || '', text: status?.textContent || '' };
  });
  const backendResponses = await Promise.all(backendResponseObjects.map(async response => ({
    status: response.status(),
    url: response.url(),
    body: (await response.text().catch(() => '')).slice(0, 4000),
  })));
  process.stdout.write(`${JSON.stringify({ setup: { model: setup.model }, result, backendResponses, consoleErrors }, null, 2)}\n`);
  if (result.kind !== 'success' || !/Summarizer test passed/.test(result.text)) process.exitCode = 1;
  if (!backendResponses.length || backendResponses.some(item => item.status >= 400)) process.exitCode = 1;
} finally {
  await page.evaluate(() => globalThis.__smpLiveCleanup?.()).catch(() => {});
  await browser.close();
}
