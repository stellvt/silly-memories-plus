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

export function formatIntermediateSources(parts = []) {
  return JSON.stringify(parts.map((structured, index) => ({
    index: index + 1,
    structured,
  })), null, 2);
}

export async function getSummarySourceBudget({
  settings,
  stage,
  targetTokens,
  level,
  instruction = '',
  countTokens,
}) {
  if (typeof countTokens !== 'function') throw new Error('Token counter is required');
  const { usefulOutputTokens, requestMaxTokens } = getSummaryRequestBudget(settings);
  const template = settings.prompts?.[stage];
  if (!template) throw new Error(`Unknown summary prompt stage: ${stage}`);
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
    throw new Error(
      `Summary prompt leaves no usable source budget (${systemTokens} prompt tokens, ${requestMaxTokens} output tokens, ${settings.summaryInputBudgetTokens} total)`,
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
    throw new Error(`Summary request exceeds its input budget (${total}/${settings.summaryInputBudgetTokens} tokens)`);
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
