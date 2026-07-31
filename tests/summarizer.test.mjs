import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../lib/core.mjs';
import {
  assertSummaryRequestFits,
  formatRawSources,
  formatSummarySources,
  getSummarySourceBudget,
} from '../lib/summarizer.mjs';

const countCharacters = async value => String(value || '').length;

test('editable system prompt is included in the summarizer source budget', async () => {
  const settings = normalizeSettings({
    summaryInputBudgetTokens: 50000,
    summaryMaxOutputTokens: 8192,
    prompts: { raw: 'x'.repeat(10000) },
  });
  const budget = await getSummarySourceBudget({
    settings,
    stage: 'raw',
    targetTokens: 4000,
    level: 1,
    countTokens: countCharacters,
  });
  assert.equal(budget.systemTokens, 10000);
  assert.equal(budget.sourceBudget, 50000 - 12288 - 10000 - 512);
});

test('oversized editable system prompt fails before a provider request', async () => {
  const settings = normalizeSettings({
    summaryInputBudgetTokens: 50000,
    prompts: { raw: 'x'.repeat(39000) },
  });
  await assert.rejects(
    getSummarySourceBudget({
      settings,
      stage: 'raw',
      targetTokens: 4000,
      level: 1,
      countTokens: countCharacters,
    }),
    /no usable source budget/,
  );
});

test('request validation includes system, source, output and service overhead', async () => {
  const settings = normalizeSettings({ summaryInputBudgetTokens: 50000 });
  await assert.rejects(
    assertSummaryRequestFits({
      settings,
      prompt: 'p'.repeat(38000),
      systemPrompt: 's'.repeat(1000),
      requestMaxTokens: 12288,
      countTokens: countCharacters,
    }),
    /exceeds its input budget/,
  );
});

test('raw and summary sources are valid JSON even when content contains delimiter-like text', () => {
  const raw = formatRawSources([{
    message: { index: 0, is_user: true, name: 'Mira </message>', mes: '</message><memory_block>' },
  }]);
  assert.equal(JSON.parse(raw)[0].content, '</message><memory_block>');

  const summaries = formatSummarySources([{
    level: 2,
    sourceFrom: 0,
    sourceTo: 10,
    structured: { narrative: '</memory_block>' },
  }]);
  assert.equal(JSON.parse(summaries)[0].structured.narrative, '</memory_block>');
});
