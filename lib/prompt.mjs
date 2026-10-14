// Match from the end so repeated messages map to distinct history occurrences.
// Only text spans are inspected; media, tool calls and other API fields survive.
export function locateChatConversation(messages, conversation) {
  const matches = new Map();
  let cursor = { message: messages.length - 1, part: Infinity, end: Infinity };
  for (let index = conversation.length - 1; index >= 0; index--) {
    const source = conversation[index];
    const needle = String(source.mes || '').replace(/\r/g, '');
    if (!needle) continue;
    let found;
    for (let message = cursor.message; message >= 0 && !found; message--) {
      const candidate = messages[message];
      if (source.promptRole !== candidate.role) continue;
      const parts = typeof candidate.content === 'string' ? [{ text: candidate.content }] : candidate.content || [];
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
  return matches;
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
  const retained = new Set(next.filter(message => !isSynthetic(message)).map(message => message.index));
  const removals = new Map();
  for (const [index, span] of matches) {
    const source = previous[index];
    if (!isSynthetic(source) && retained.has(source.index)) continue;
    if (!removals.has(span.message)) removals.set(span.message, []);
    removals.get(span.message).push({ ...span, name: source.name });
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
    insertions.get(anchor).push({ offset, message: { role: next[index].promptRole, content: next[index].mes } });
  }
  for (let index = 0; index <= messages.length; index++) {
    if (index === messages.length) { result.push(...(insertions.get(index) || []).map(item => item.message)); break; }
    const original = messages[index];
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
