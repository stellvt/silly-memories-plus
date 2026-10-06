import { LocalizedError, message as msg } from './i18n.mjs';
import {
  getSummaryRequestBudget,
  MERGE_GUIDANCE,
  renderSummaryPrompt,
  splitTextByTokenBudget,
} from './core.mjs';

export const SUMMARY_REQUEST_OVERHEAD_TOKENS = 512;

export function formatRawSources(entries = []) {
  return JSON.stringify(entries.map(({ message }) => ({
    index: Number(message?.index),
    role: message?.is_user ? 'user' : 'assistant',
    name: String(message?.name || (message?.is_user ? 'user' : 'assistant')),
    part: message?.extra?.smpSourcePart || undefined,
    content: String(message?.mes || ''),
  })), null, 2);
}

export function formatSummarySources(blocks = []) {
  return JSON.stringify(blocks.map(block => ({
    level: block.level,
    source: [block.sourceFrom, block.sourceTo],
    structured: block.structured,
  })), null, 2);
}

export async function chunkStructuredSources(sources, sourceBudget, countTokens) {
  const budget = Math.max(1, Math.floor(sourceBudget));
  const units = [];
  const format = values => JSON.stringify(values, null, 2);
  for (const source of sources) {
    if (await countTokens(format([source])) <= budget) {
      units.push(source);
      continue;
    }
    // Split values, not serialized JSON: every fragment retains its field and
    // source identity, and quoting/escaping is included in the measured budget.
    for (const [field, value] of Object.entries(source.structured)) {
      const array = Array.isArray(value);
      const entries = array ? value : [value];
      for (let item = 0; item < entries.length; item++) {
        const fragment = (text, number = 1, total = 1) => ({
          ...source,
          structured: { [field]: array ? [text] : text },
          part: { field, item, number, total },
        });
        const parts = await splitTextByTokenBudget(entries[item], Math.max(1, budget - 32),
          text => countTokens(format([fragment(text)])));
        for (let index = 0; index < parts.length; index++) units.push(fragment(parts[index], index + 1, parts.length));
      }
    }
  }
  const prompts = [];
  let group = [];
  for (const unit of units) {
    if (await countTokens(format([unit])) > budget) throw new LocalizedError(msg('A memory source fragment exceeds the summarizer input budget. Shorten the summary prompt or increase the input budget.'));
    if (group.length && await countTokens(format([...group, unit])) > budget) {
      prompts.push(format(group));
      group = [];
    }
    group.push(unit);
  }
  if (group.length) prompts.push(format(group));
  return prompts;
}

export async function getSummarySourceBudget({
  settings,
  stage,
  targetTokens,
  level,
  instruction = '',
  countTokens,
}) {
  if (typeof countTokens !== 'function') throw new LocalizedError(msg('Token counter is required'));
  const { usefulOutputTokens, requestMaxTokens } = getSummaryRequestBudget(settings);
  const template = settings.prompts?.[stage];
  if (!template) throw new LocalizedError(msg`Unknown summary prompt stage: ${stage}`);
  const systemPrompt = [
    renderSummaryPrompt(template, { targetTokens, level }),
    stage === 'rollup' && !template.includes(MERGE_GUIDANCE) ? MERGE_GUIDANCE : '',
    instruction.trim() ? `Regeneration preference: ${instruction.trim()}\nApply this preference without inventing facts or changing the required schema.` : '',
  ].filter(Boolean).join('\n\n');
  const systemTokens = await countTokens(systemPrompt);
  const sourceBudget = Math.floor(
    settings.summaryInputBudgetTokens
    - requestMaxTokens
    - systemTokens
    - SUMMARY_REQUEST_OVERHEAD_TOKENS,
  );
  if (sourceBudget < 512) {
    throw new LocalizedError(
      msg`Summary prompt leaves no usable source budget (${systemTokens} prompt tokens, ${requestMaxTokens} output tokens, ${settings.summaryInputBudgetTokens} total)`,
    );
  }
  return { usefulOutputTokens, requestMaxTokens, systemPrompt, systemTokens, sourceBudget };
}

export async function assertSummaryRequestFits({
  settings,
  prompt,
  systemPrompt,
  requestMaxTokens,
  countTokens,
}) {
  const [promptTokens, systemTokens] = await Promise.all([
    countTokens(String(prompt || '')),
    countTokens(String(systemPrompt || '')),
  ]);
  const total = promptTokens + systemTokens + requestMaxTokens + SUMMARY_REQUEST_OVERHEAD_TOKENS;
  if (total > settings.summaryInputBudgetTokens) {
    throw new LocalizedError(msg`Summary request exceeds its input budget (${total}/${settings.summaryInputBudgetTokens} tokens)`);
  }
  return { promptTokens, systemTokens, total };
}

export async function splitOversizedRawEntries(entries, sourceBudget, countTokens) {
  const contentBudget = Math.max(256, Math.floor(sourceBudget * 0.85));
  const result = [];
  for (const entry of entries) {
    if (entry.tokens <= contentBudget) {
      result.push(entry);
      continue;
    }

    const parts = await splitTextByTokenBudget(
      String(entry.message?.mes || ''),
      contentBudget,
      countTokens,
    );
    for (let index = 0; index < parts.length; index++) {
      const mes = parts[index];
      result.push({
        ...entry,
        tokens: await countTokens(mes),
        message: {
          ...entry.message,
          mes,
          extra: {
            ...entry.message?.extra,
            smpSourcePart: { number: index + 1, total: parts.length },
          },
        },
      });
    }
  }
  return result;
}
