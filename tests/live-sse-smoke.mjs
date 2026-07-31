import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const modulesPath = process.env.CODEX_NODE_MODULES;
const executablePath = process.env.SMP_BROWSER_EXECUTABLE;
const baseUrl = process.env.SMP_BASE_URL || 'http://127.0.0.1:8000';
const proxyUrl = process.env.SMP_PROXY_URL;
const proxyKey = process.env.SMP_PROXY_KEY;
const model = process.env.SMP_PROXY_MODEL || 'gpt-4.1-nano';
const concurrentSummary = process.env.SMP_SSE_CONCURRENT_SUMMARY === '1';
if (!modulesPath || !executablePath || !proxyUrl || !proxyKey) {
  throw new Error('CODEX_NODE_MODULES, SMP_BROWSER_EXECUTABLE, SMP_PROXY_URL and SMP_PROXY_KEY are required');
}

const require = createRequire(import.meta.url);
const { chromium } = require(resolve(modulesPath, 'playwright'));
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
const relevantErrors = [];
page.on('console', message => {
  if (message.type() === 'error' && /silly.memories.plus|silly-memories-plus|event-stream|sse/i.test(message.text())) {
    relevantErrors.push(message.text());
  }
});
page.on('pageerror', error => relevantErrors.push(String(error?.stack || error)));

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => typeof globalThis.sillyMemoriesPlusGenerateInterceptor === 'function',
    null,
    { timeout: 30000 },
  );

  const result = await page.evaluate(async ({ proxyUrl, proxyKey, model, concurrentSummary }) => {
    const context = globalThis.SillyTavern.getContext();
    const memoryKey = 'silly_memories_plus';
    const originalChat = [...context.chat];
    const hadMemory = Object.hasOwn(context.chatMetadata, memoryKey);
    const originalMemory = context.chatMetadata[memoryKey];
    const storedChat = [
      { name: 'User', mes: 'Covered SSE source.', is_user: true, is_system: false, extra: {} },
      { name: 'Character', mes: 'Newest raw SSE tail.', is_user: false, is_system: false, extra: {} },
    ];
    const outgoing = storedChat.map((message, index) => ({ ...message, index, extra: { ...message.extra } }));

    try {
      context.chat.splice(0, context.chat.length, ...storedChat);
      context.chatMetadata[memoryKey] = {
        schemaVersion: 3,
        blocks: [{
          id: 'sse-smoke-block',
          level: 1,
          structured: {
            narrative: 'Stable SSE memory block.',
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
          sourceFrom: 0,
          sourceTo: 0,
          sourceTokens: 20,
          summaryTokens: 8,
          sourceHash: 'sse-smoke',
          sourceFingerprints: [],
          children: [],
          status: 'active',
          createdAt: Date.now(),
        }],
      };
      await globalThis.sillyMemoriesPlusGenerateInterceptor(outgoing, 80000, () => {}, 'normal');
    } finally {
      context.chat.splice(0, context.chat.length, ...originalChat);
      if (hadMemory) context.chatMetadata[memoryKey] = originalMemory;
      else delete context.chatMetadata[memoryKey];
    }

    const readStream = async () => {
      const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
          stream: true,
          messages: [
            ...outgoing.map(message => ({
              role: message.is_user ? 'user' : message.is_system ? 'system' : 'assistant',
              content: message.mes,
            })),
            { role: 'user', content: 'Output the integers 1 through 30, separated by spaces, and nothing else.' },
          ],
          max_tokens: 128,
          model,
          temperature: 0,
          chat_completion_source: 'openai',
          reverse_proxy: proxyUrl,
          proxy_password: proxyKey,
        }),
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let raw = '';
      let readChunks = 0;
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        readChunks += 1;
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      const dataLines = raw.split(/\r?\n/).filter(line => line.startsWith('data:'));
      let content = '';
      let deltaEvents = 0;
      for (const line of dataLines) {
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            content += delta;
            deltaEvents += 1;
          }
        } catch {
          // Non-JSON SSE metadata is allowed; transport completion is checked separately.
        }
      }
      return {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type') || '',
        readChunks,
        dataEvents: dataLines.length,
        deltaEvents,
        doneEvent: dataLines.some(line => line.includes('[DONE]')),
        content,
      };
    };

    const waitForSummary = () => new Promise((resolve, reject) => {
      const deadline = Date.now() + 240000;
      const poll = () => {
        const status = document.getElementById('smp-status');
        if (['success', 'error'].includes(status?.dataset?.kind)) {
          resolve({ kind: status.dataset.kind, text: status.textContent || '' });
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('Summarizer status timed out'));
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
    let stream;
    let summary;
    if (concurrentSummary) {
      const streamPromise = readStream();
      document.getElementById('smp-test-summarizer')?.click();
      [stream, summary] = await Promise.all([streamPromise, waitForSummary()]);
    } else {
      stream = await readStream();
      document.getElementById('smp-test-summarizer')?.click();
      summary = await waitForSummary();
    }
    return {
      mode: concurrentSummary ? 'concurrent' : 'sequential',
      rewrite: {
        memoryInjectedFirst: outgoing[0]?.extra?.sillyMemoriesPlus === true,
        rawTailPreserved: outgoing[1]?.mes === 'Newest raw SSE tail.',
      },
      stream,
      summary,
    };
  }, { proxyUrl, proxyKey, model, concurrentSummary });

  process.stdout.write(`${JSON.stringify({ ...result, relevantErrors }, null, 2)}\n`);
  if (!result.rewrite.memoryInjectedFirst || !result.rewrite.rawTailPreserved) process.exitCode = 1;
  if (!result.stream.ok) process.exitCode = 1;
  if (!result.stream.doneEvent || result.stream.deltaEvents < 2 || !result.stream.content.trim()) process.exitCode = 1;
  if (/oai-proxy-error|proxy queue error/i.test(result.stream.content)) process.exitCode = 1;
  if (result.summary.kind !== 'success') process.exitCode = 1;
  if (relevantErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
