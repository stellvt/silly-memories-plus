import { locateChatConversation, isSynthetic } from './prompt.mjs';
import { fastHash } from './source-identity.mjs';

const text = value => String(value ?? '');
const body = message => typeof message?.content === 'string' ? message.content
  : (Array.isArray(message?.content) ? message.content : []).filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
const describe = value => ({ chars: value.length, hash: fastHash(value) });
const fragment = value => ({ ...describe(value), ...(/^\s*$/.test(value) ? {
  whitespace: [...value.slice(0, 32)].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    .replace('\\u000a', '\\n').replace('\\u000d', '\\r').replace('\\u0009', '\\t').replace('\\u0020', '\\s')).join(''),
  truncated: value.length > 32,
} : {}) });
const edges = value => ({ leading: fragment(value.match(/^\s*/)[0]), trailing: fragment(value.match(/\s*$/)[0]) });

// Only hashes, sizes and escaped whitespace leave this module. Changed words,
// names, macro arguments, media URLs and credentials are never diagnostic data.
export function describeTextChange(before, after) {
  before = text(before); after = text(after);
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(before.length, after.length) - prefix && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const kind = before === after ? 'unchanged' : !after ? 'removed' : !before ? 'added'
    : before.replace(/\r\n?/g, '\n') === after.replace(/\r\n?/g, '\n') ? 'line-endings'
    : before.trim() === after.trim() ? 'edge-whitespace'
    : before.replace(/\s/g, '') === after.replace(/\s/g, '') ? 'whitespace' : 'text-changed';
  // Edge trimming can remove two separate fragments around unchanged content.
  const hasCore = before.trim().length > 0;
  const edgeRemoved = kind === 'edge-whitespace' && hasCore
    ? before.slice(0, before.length - before.trimStart().length) + before.slice(before.trimEnd().length) : removed;
  const edgeAdded = kind === 'edge-whitespace' && hasCore
    ? after.slice(0, after.length - after.trimStart().length) + after.slice(after.trimEnd().length) : added;
  return { kind, before: describe(before), after: describe(after), deltaChars: after.length - before.length,
    commonPrefixChars: prefix, commonSuffixChars: suffix,
    removed: fragment(edgeRemoved), added: fragment(edgeAdded),
    ...(kind === 'edge-whitespace' ? { edges: { before: edges(before), after: edges(after) } } : {}) };
}

export function traceIndexedText(before, after) {
  const stored = new Map(before.map(message => [message.index, message]));
  return after.filter(message => !isSynthetic(message) && stored.has(message.index)).map(message => ({
    index: message.index, role: message.is_user ? 'user' : 'assistant',
    ...describeTextChange(stored.get(message.index).mes, message.mes),
  })).filter(change => change.kind !== 'unchanged');
}

function requestCandidate(prompt, conversation, position, matches) {
  const span = matches.get(position);
  if (span) {
    const parts = typeof prompt[span.message].content === 'string' ? [{ text: prompt[span.message].content }] : prompt[span.message].content;
    return { basis: span.basis || 'exact-span', candidateCount: 1, requestMessage: span.message, part: span.part,
      value: parts[span.part].text.slice(span.start, span.end) };
  }
  const expected = conversation[position];
  const needle = text(expected.promptText ?? expected.mes);
  let start = 0, end = prompt.length - 1, anchored = false;
  for (let index = position - 1; index >= 0; index--) if (matches.has(index)) { start = matches.get(index).message + 1; anchored = true; break; }
  for (let index = position + 1; index < conversation.length; index++) if (matches.has(index)) { end = matches.get(index).message - 1; anchored = true; break; }
  const candidates = [];
  for (let index = start; index <= end; index++) {
    if (prompt[index]?.role !== expected.promptRole) continue;
    const parts = typeof prompt[index].content === 'string' ? [{ text: prompt[index].content }] : prompt[index].content || [];
    for (let part = 0; part < parts.length; part++) if (typeof parts[part]?.text === 'string') candidates.push({ requestMessage: index, part, value: parts[part].text });
  }
  const equivalent = candidates.filter(candidate => candidate.value.trim() === needle.trim());
  const pool = equivalent.length ? equivalent : anchored ? candidates : [];
  if (pool.length !== 1) return { basis: pool.length ? 'ambiguous' : 'not-found', candidateCount: pool.length,
    candidates: pool.slice(0, 8).map(({ value, ...candidate }) => ({ ...candidate, ...describe(value) })) };
  return { ...pool[0], basis: equivalent.length ? 'edge-whitespace' : 'single-role-between-anchors', candidateCount: 1 };
}

// Candidate inference is diagnostic only. It never supplies a match to the
// planner/validator, changes the prompt, or relaxes missing-history checks.
export function inspectChatTextTrace({ source, conversation, formatted, records = [], native = [], prompt, finalStage, sourceStage = 'interceptor', validation = 'content' }) {
  const matches = locateChatConversation(prompt, conversation, validation);
  const positions = new Map(conversation.filter(message => !isSynthetic(message)).map(message => [message.index, conversation.indexOf(message)]));
  const used = new Set();
  const messages = [];
  for (let index = source.length - 1; index >= 0; index--) {
    const message = source[index];
    const position = positions.get(message.index);
    if (position == null || isSynthetic(message)) continue;
    const format = formatted[index];
    if (!format) continue;
    const input = text(format.content);
    const eligible = item => !used.has(item) && (item.beforeRole ?? item.role) === format.role;
    const exact = records.filter(item => eligible(item) && item.before === input);
    const named = exact.filter(item => item.name === format.name);
    const equivalent = records.filter(item => eligible(item) && text(item.before).trim() === input.trim());
    const record = named[0] || exact[0] || (equivalent.length === 1 ? equivalent[0] : null);
    if (record) used.add(record);
    const stages = [{ stage: sourceStage, value: text(message.mes) }, { stage: 'openai-format', value: input }];
    if (record) {
      stages.push({ stage: 'native-input', value: text(record.before) }, { stage: 'native-expanded', value: text(record.after) });
      const item = native.find(item => item.identifier === record.identifier);
      if (item) stages.push({ stage: 'native-message', value: body(item) });
    }
    const candidate = requestCandidate(prompt, conversation, position, matches);
    if (candidate.value !== undefined) stages.push({ stage: finalStage, value: candidate.value });
    const changes = stages.slice(1).flatMap((stage, index) => {
      const change = describeTextChange(stages[index].value, stage.value);
      return change.kind === 'unchanged' ? [] : [{ from: stages[index].stage, to: stage.stage, ...change }];
    });
    const { value, ...requestMatch } = candidate;
    messages.push({ index: message.index, role: format.role,
      nativeAssociation: record ? exact.includes(record) ? 'exact' : 'edge-whitespace' : equivalent.length > 1 ? 'ambiguous' : 'not-found',
      ...(record ? { nativeIdentifier: /^chatHistory-\d+$/.test(record.identifier || '') ? record.identifier : null,
        nativeNameMatches: record.name === format.name } : {}),
      stages: stages.map(({ stage, value }) => ({ stage, ...describe(value) })), changes, requestMatch });
  }
  return { recordsCaptured: records.length, expected: positions.size, exact: [...positions.values()].filter(position => matches.has(position)).length,
    messages: messages.reverse() };
}
