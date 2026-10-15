import { locateChatConversation, locateTextConversation, isSynthetic, missingHistory } from './prompt.mjs';
import { fastHash } from './source-identity.mjs';

const NATIVE_SOURCES = new Set(['main', 'nsfw', 'jailbreak', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples', 'newMainChat', 'newChat', 'groupNudge', 'continueNudge', 'continuePrefill', 'bias', 'emptyUserMessageReplacement', 'controlPrompts']);

export function diagnosticName(value) {
  const text = String(value || '');
  return /^[a-zA-Z0-9_.:/-]{1,160}$/.test(text) && !text.includes('://') ? text : null;
}

export function describeConversation(message, blocks = []) {
  const text = String(message.promptText ?? message.formatted ?? message.mes ?? '');
  const owner = blocks.find(block => block.status === 'active' && message.index >= block.sourceFrom && message.index <= block.sourceTo);
  return { kind: message.extra?.sillyMemoriesPlusPinnedFacts ? 'facts' : isSynthetic(message) ? 'memory' : 'history',
    ...(isSynthetic(message) ? { blockIds: message.extra?.sillyMemoriesPlusBlockIds || [] } : { index: message.index }),
    ...(owner ? { ownerBlockId: owner.id, useRaw: Boolean(owner.useRaw) } : {}),
    role: message.promptRole, chars: text.length, hash: fastHash(text) };
}

export function inspectConversation(prompt, conversation, blocks = [], textMode = false) {
  const locate = textMode ? locateTextConversation : locateChatConversation;
  const matches = locate(prompt, conversation);
  const missing = new Set(missingHistory(conversation, matches));
  for (const [index, message] of conversation.entries()) if (isSynthetic(message) && !matches.has(index)) missing.add(message);
  const inventory = conversation.map((message, index) => {
    const found = matches.get(index);
    return { ...describeConversation(message, blocks), present: Boolean(found), ...(found ? { requestMessage: found.message ?? 0, start: found.start, end: found.end,
      matchBasis: found.basis || message.promptMatch?.basis || 'exact', ...(message.promptMatch ? { deltaChars: message.promptMatch.deltaChars } : {}) } : {}) };
  });
  const absent = conversation.flatMap((message, index) => {
    if (!missing.has(message)) return [];
    let reason = locate(prompt, [message]).size ? 'order-changed' : 'text-not-found';
    if (!textMode && reason === 'text-not-found' && ['system', 'user', 'assistant', 'tool'].some(role => role !== message.promptRole && locate(prompt, [{ ...message, promptRole: role }]).size)) reason = 'role-changed';
    return [{ ...inventory[index], reason }];
  });
  return { inventory, missing: absent, matches };
}

// Diagnostics expose positions, source identities and costs, never text or
// provider credentials. Unknown user-defined prompt names become opaque hashes.
export async function inspectChatPrompt(prompt, conversation, blocks, native, countPrompt, countText) {
  const inspection = inspectConversation(prompt, conversation, blocks);
  const components = [];
  for (const [position, message] of prompt.entries()) {
    const prepared = native.find(item => item.role === message.role && JSON.stringify(item.content) === JSON.stringify(message.content));
    const identifier = prepared?.identifier;
    const owned = inspection.inventory.filter(item => item.present && item.requestMessage === position);
    const text = typeof message.content === 'string' ? message.content : (message.content || []).filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
    const fields = [];
    for (const key of ['signature', 'reasoning', 'tool_calls', 'tool_call_id']) {
      if (!message[key]) continue;
      const value = typeof message[key] === 'string' ? message[key] : JSON.stringify(message[key]);
      fields.push({ field: key, chars: value.length, tokens: await countText(value) });
    }
    components.push({ position, role: message.role,
      source: owned.length ? owned.map(item => item.kind).filter((kind, index, kinds) => kinds.indexOf(kind) === index).join('+')
        : NATIVE_SOURCES.has(identifier) ? identifier : /^chatHistory-\d+$/.test(identifier || '') ? 'unmatched-chat-history' : identifier ? `custom-${fastHash(identifier)}` : 'unmapped-prompt',
      tokens: Math.max(0, await countPrompt([message]) - 2), textTokens: text ? await countText(text) : 0,
      chars: text.length, hash: fastHash(text), fields,
      mediaParts: Array.isArray(message.content) ? message.content.filter(part => !['text', 'input_text', 'output_text'].includes(part.type)).map(part => ({ type: diagnosticName(part.type) || 'media' })) : [],
    });
  }
  return { inventory: inspection.inventory, missing: inspection.missing, components };
}
