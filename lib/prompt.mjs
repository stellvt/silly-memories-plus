// Origins stay outside API payloads and survive in-place extension processing.
// Copied messages use the same conservative, ordered text matching as other spans.
const origins = new WeakMap();
const partsOf = message => typeof message.content === 'string' ? [{ text: message.content }] : Array.isArray(message.content) ? message.content : [];
export function captureChatOrigins(chat, native) {
  if (chat.length !== native.length) return;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index], source = native[index];
    if (message.role === source.role && (message.content === source.content || JSON.stringify(message.content) === JSON.stringify(source.content))) {
      origins.set(message, { identifiers: source.identifiers || [source.identifier], role: source.role,
        text: partsOf(source).filter(part => typeof part.text === 'string').map(part => part.text).join('\n') });
    }
  }
}

// This is a comparison projection, never a rewritten prompt. Only complete HTML
// comments and layout whitespace are optional; visible markup and words remain.
function project(text) {
  const chars = [], starts = [], ends = [];
  // Code carries literal markup and significant indentation. Its contents never
  // participate in comment removal or whitespace equivalence.
  const sections = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\r\n]*?(?:\2|(?=\r?\n)|$)|[ \t\r\n]*<!--[\s\S]*?-->/g;
  const ranges = [];
  for (const match of text.matchAll(sections)) ranges.push([match.index, match.index + match[0].length, Boolean(match[1] || match[2])]);
  let offset = 0, space = null;
  const append = (from, to, literal = false) => {
    for (let index = from; index < to; index++) {
      const char = text[index];
      if (!literal && (char === ' ' || char === '\t' || char === '\r' || char === '\n')) { if (chars.length) space ??= index; continue; }
      if (space !== null) { chars.push(' '); starts.push(space); ends.push(index); space = null; }
      chars.push(text[index]); starts.push(index); ends.push(index + 1);
    }
  };
  for (const [from, to, literal] of ranges) { append(offset, from); if (literal) append(from, to, true); offset = to; }
  append(offset, text.length);
  return { text: chars.join(''), starts, ends };
}

function originAllows(candidate, source) {
  const origin = origins.get(candidate);
  if (!origin) return true;
  if (origin.role !== candidate.role) return false;
  return !source.promptIdentifier || origin.identifiers.includes(source.promptIdentifier);
}

const before = (left, right) => left.message - right.message || left.part - right.part || left.end - right.start;

function neighbours(index, matches, length, sourceLength) {
  let lower = { message: 0, part: 0, start: 0, end: 0 };
  let upper = { message: length - 1, part: Infinity, start: Infinity, end: Infinity };
  let anchored = false;
  for (let previous = index - 1; previous >= 0; previous--) if (matches.has(previous)) { lower = matches.get(previous); anchored = true; break; }
  for (let next = index + 1; next < sourceLength; next++) if (matches.has(next)) { upper = matches.get(next); anchored = true; break; }
  return { lower, upper, anchored };
}

// Exact matching remains the first choice. Formatting-equivalent spans must be
// unique between established neighbours and cannot cross another owned span.
export function locateChatConversation(messages, conversation) {
  const matches = new Map();
  let cursor = { message: messages.length - 1, part: Infinity, end: Infinity };
  for (let index = conversation.length - 1; index >= 0; index--) {
    const source = conversation[index];
    const needle = String(source.promptText ?? source.mes ?? '').replace(/\r/g, '');
    if (!needle) continue;
    let found;
    for (let message = cursor.message; message >= 0 && !found; message--) {
      const candidate = messages[message];
      if (source.promptRole !== candidate.role || !originAllows(candidate, source)) continue;
      const parts = partsOf(candidate);
      for (let part = parts.length - 1; part >= 0; part--) {
        if (message === cursor.message && part > cursor.part) continue;
        const text = parts[part]?.text;
        if (typeof text !== 'string') continue;
        const end = message === cursor.message && part === cursor.part ? cursor.end : text.length;
        const start = text.lastIndexOf(needle, end - needle.length);
        if (start >= 0 && start + needle.length <= end) { found = { message, part, start, end: start + needle.length }; break; }
      }
    }
    if (found) {
      matches.set(index, found);
      cursor = { message: found.message, part: found.part, end: found.start };
    }
  }
  const projected = new Map();
  for (let index = conversation.length - 1; index >= 0; index--) {
    const source = conversation[index];
    if (matches.has(index) || isSynthetic(source)) continue;
    const needle = project(String(source.promptText ?? source.mes ?? ''));
    if (!needle.text) continue;
    const { lower, upper, anchored } = neighbours(index, matches, messages.length, conversation.length);
    const candidates = [];
    for (let message = lower.message; message <= upper.message; message++) {
      const candidate = messages[message];
      if (!candidate || candidate.role !== source.promptRole || !originAllows(candidate, source)) continue;
      const origin = origins.get(candidate);
      if (!anchored && (!source.promptIdentifier || !origin?.identifiers.includes(source.promptIdentifier))) continue;
      for (const [part, entry] of partsOf(candidate).entries()) {
        if (typeof entry?.text !== 'string') continue;
        const key = `${message}:${part}`;
        if (!projected.has(key)) projected.set(key, project(entry.text));
        const projection = projected.get(key);
        let position = projection.text.indexOf(needle.text);
        while (position >= 0) {
          const start = projection.starts[position], end = projection.ends[position + needle.text.length - 1];
          const span = { message, part, start, end, basis: 'formatting-equivalent' };
          const owned = Boolean(source.promptIdentifier && origin?.identifiers.includes(source.promptIdentifier));
          // A substring of another word is not a history boundary.
          const bounded = (position === 0 || !/[\p{L}\p{N}_]/u.test(projection.text[position - 1]))
            && (position + needle.text.length === projection.text.length || !/[\p{L}\p{N}_]/u.test(projection.text[position + needle.text.length]));
          if (bounded && before(lower, span) <= 0 && before(span, upper) <= 0) {
            if (projection.text === needle.text) { span.start = 0; span.end = entry.text.length; }
            candidates.push({ ...span, owned });
          }
          position = projection.text.indexOf(needle.text, position + Math.max(1, needle.text.length));
        }
      }
    }
    const owned = candidates.filter(candidate => candidate.owned);
    const pool = owned.length ? owned : candidates;
    if (pool.length === 1) {
      const { owned: _, ...span } = pool[0];
      matches.set(index, span);
    }
  }
  return matches;
}

export function resolveChatConversation(messages, conversation) {
  const matches = locateChatConversation(messages, conversation);
  return conversation.map((source, index) => {
    const span = matches.get(index);
    if (!span || isSynthetic(source)) return source;
    const actual = partsOf(messages[span.message])[span.part].text.slice(span.start, span.end);
    const original = source.promptText ?? source.mes;
    return actual === original ? source : { ...source, promptText: actual, promptMatch: { basis: span.basis || 'exact', deltaChars: actual.length - original.length } };
  });
}

export function unverifiedChatHistory(messages, conversation) {
  const matches = locateChatConversation(messages, conversation);
  return conversation.flatMap((source, index) => {
    if (matches.has(index) || !source.mes?.trim() || source.extra?.tool_invocations?.length) return [];
    if (isSynthetic(source)) {
      const changedBundle = source.promptIdentifier && messages.some(message => {
        const origin = origins.get(message);
        return origin?.identifiers.includes(source.promptIdentifier) && origin.text !== (source.promptText ?? source.mes);
      });
      return changedBundle ? [{ kind: source.extra?.sillyMemoriesPlusPinnedFacts ? 'facts' : 'memory',
        blockIds: source.extra?.sillyMemoriesPlusBlockIds || [], reason: 'changed-memory-in-merged-message' }] : [];
    }
    if (source.promptIdentifier && messages.some(message => origins.get(message)?.identifiers.includes(source.promptIdentifier))) {
      return [{ index: source.index, reason: 'owned-message-changed-or-reordered' }];
    }
    const { lower, upper } = neighbours(index, matches, messages.length, conversation.length);
    for (let message = lower.message; message <= upper.message; message++) {
      const candidate = messages[message];
      if (!candidate || origins.has(candidate) || candidate.role !== source.promptRole) continue;
      for (const [part, entry] of partsOf(candidate).entries()) {
        if (typeof entry?.text !== 'string') continue;
        const start = message === lower.message && part === lower.part ? lower.end : 0;
        const end = message === upper.message && part === upper.part ? Math.min(upper.start, entry.text.length) : entry.text.length;
        const span = { message, part, start, end };
        if (before(lower, span) <= 0 && before(span, upper) <= 0 && project(entry.text.slice(start, end)).text) {
          return [{ index: source.index, reason: 'unverified-history-candidate' }];
        }
      }
    }
    return [];
  });
}

export function locateTextConversation(prompt, conversation) {
  const matches = new Map();
  let end = prompt.length;
  for (let index = conversation.length - 1; index >= 0; index--) {
    const source = conversation[index];
    const needle = String(source.formatted || source.mes || '').replace(/\r/g, '');
    if (!needle) continue;
    const start = prompt.lastIndexOf(needle, end - needle.length);
    if (start >= 0 && start + needle.length <= end) {
      matches.set(index, { start, end: start + needle.length });
      end = start;
    }
  }
  return matches;
}

export function isSynthetic(message) { return Boolean(message.extra?.sillyMemoriesPlus); }

export async function countChatPrompt(messages, countTokens, nativeMessages = []) {
  if (!messages.length) return 0;
  let mediaTokens = 0;
  const normalized = [];
  for (const message of messages) {
    const copy = { ...message };
    if (Array.isArray(message.content)) {
      copy.content = message.content.filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
      const native = nativeMessages.find(item => item.role === message.role && Array.isArray(item.content)
        && (item.content === message.content || JSON.stringify(item.content) === JSON.stringify(message.content)));
      const parts = message.content.filter(part => !['text', 'input_text', 'output_text'].includes(part.type));
      if (parts.length && native?.getTokens) {
        mediaTokens += Math.max(0, native.getTokens() - await countTokens(copy, false));
      } else {
        // Reuse native media costs when available; otherwise reserve rather than
        // passing arrays to the host's text-only tokenizer (which skips them).
        mediaTokens += parts.reduce((sum, part) => sum + (part.type === 'image_url' ? part.image_url?.detail === 'low' ? 85 : 1445 : part.type === 'video_url' ? 10520 : 9600), 0);
      }
    }
    for (const [key, value] of Object.entries(copy)) if (value && typeof value === 'object') copy[key] = JSON.stringify(value);
    normalized.push(copy);
  }
  return Math.max(0, await countTokens(normalized, true)) + 3 + mediaTokens;
}

export function missingHistory(conversation, matches) {
  return conversation.filter((message, index) => !isSynthetic(message) && message.mes?.trim()
    && !message.extra?.tool_invocations?.length && !matches.has(index));
}

export function replaceChatMemory(messages, previous, next) {
  const matches = locateChatConversation(messages, previous);
  // Restore our own altered injection only when its whole native message is
  // proven. Never append a second version beside a known corrupted injection.
  for (const [index, source] of previous.entries()) {
    if (!isSynthetic(source) || matches.has(index)) continue;
    const needle = source.promptText ?? source.mes;
    const candidates = messages.flatMap((message, position) => {
      const origin = origins.get(message);
      return origin?.text === needle && origin.role === source.promptRole && typeof message.content === 'string'
        ? [{ message: position, part: 0, start: 0, end: message.content.length }] : [];
    });
    if (candidates.length === 1) matches.set(index, candidates[0]);
  }
  const retained = new Set(next.filter(message => !isSynthetic(message)).map(message => message.index));
  const removals = new Map();
  const removedToolIds = new Set();
  for (const [index, span] of matches) {
    const source = previous[index];
    if (!isSynthetic(source) && retained.has(source.index)) continue;
    if (!removals.has(span.message)) removals.set(span.message, []);
    removals.get(span.message).push({ ...span, name: source.name });
    for (const call of messages[span.message].tool_calls || []) removedToolIds.add(call.id);
  }
  const result = [];
  const nextMatches = locateChatConversation(messages, next);
  const insertions = new Map();
  for (let index = 0; index < next.length; index++) {
    if (!isSynthetic(next[index])) continue;
    let anchor = messages.length;
    let offset = 0;
    for (let following = index + 1; following < next.length; following++) {
      if (!isSynthetic(next[following]) && nextMatches.has(following)) {
        const span = nextMatches.get(following);
        anchor = span.message;
        if (messages[anchor].role === 'system' && typeof messages[anchor].content === 'string') offset = span.start;
        break;
      }
    }
    if (!insertions.has(anchor)) insertions.set(anchor, []);
    insertions.get(anchor).push({ offset, message: { role: next[index].promptRole, content: next[index].promptText ?? next[index].mes } });
  }
  for (let index = 0; index <= messages.length; index++) {
    if (index === messages.length) { result.push(...(insertions.get(index) || []).map(item => item.message)); break; }
    const original = messages[index];
    // A compacted tool call and its results form one history unit.
    if (original.role === 'tool' && removedToolIds.has(original.tool_call_id)) continue;
    if (original.role === 'system' && typeof original.content === 'string' && insertions.has(index)) {
      // A squashed system message can contain raw → summary → raw. Restore
      // those boundaries without moving its preset or lore text around them.
      const edits = [...(removals.get(index) || []), ...insertions.get(index).map(item => ({ start: item.offset, end: item.offset, replacement: item.message }))]
        .sort((a, b) => a.start - b.start || a.end - b.end);
      let offset = 0;
      for (const edit of edits) {
        const content = original.content.slice(offset, edit.start);
        if (content.trim()) result.push({ ...original, content });
        if (edit.replacement) result.push(edit.replacement);
        offset = Math.max(offset, edit.end);
      }
      const content = original.content.slice(offset);
      if (content.trim()) result.push({ ...original, content });
      continue;
    }
    if (insertions.has(index)) result.push(...insertions.get(index).map(item => item.message));
    if (!removals.has(index)) { result.push(original); continue; }
    const message = structuredClone(original);
    if (message.tool_calls?.some(call => removedToolIds.has(call.id))) delete message.tool_calls;
    const parts = typeof message.content === 'string' ? [{ text: message.content }] : message.content;
    for (const span of removals.get(index).sort((a, b) => b.part - a.part || b.start - a.start)) {
      parts[span.part].text = parts[span.part].text.slice(0, span.start) + parts[span.part].text.slice(span.end);
    }
    const text = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('').trim();
    if (!text || removals.get(index).some(span => text === `${span.name}:`)) continue;
    message.content = typeof message.content === 'string' ? parts[0].text : parts;
    result.push(message);
  }
  return result;
}

export function replaceTextMemory(prompt, previous, next, formatMemory) {
  const matches = locateTextConversation(prompt, previous);
  const retained = new Set(next.filter(message => !isSynthetic(message)).map(message => message.index));
  const edits = [];
  for (const [index, span] of matches) {
    const source = previous[index];
    if (isSynthetic(source) || !retained.has(source.index)) edits.push(span);
  }
  const nextMatches = locateTextConversation(prompt, next);
  const insertions = new Map();
  for (let index = 0; index < next.length; index++) {
    if (!isSynthetic(next[index])) continue;
    let anchor = prompt.length;
    for (let following = index + 1; following < next.length; following++) {
      if (!isSynthetic(next[following]) && nextMatches.has(following)) { anchor = nextMatches.get(following).start; break; }
    }
    insertions.set(anchor, (insertions.get(anchor) || '') + formatMemory(next[index]));
  }
  for (const [anchor, replacement] of insertions) edits.push({ start: anchor, end: anchor, replacement });
  for (const edit of edits.sort((a, b) => b.start - a.start)) prompt = prompt.slice(0, edit.start) + (edit.replacement || '') + prompt.slice(edit.end);
  return prompt;
}
