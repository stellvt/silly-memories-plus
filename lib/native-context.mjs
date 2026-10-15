// Disable only the native ChatCompletion truncation budget. Keep the tokenizer,
// configured context/output limits and message costs available to our preflight.
import { captureChatOrigins } from './prompt.mjs';
export const MANAGED_CONTEXT_LABEL = 'Silly';

export function installNativeContextManagement({ ChatCompletion, promptManager, isManaged }) {
  let history = [];
  const bundles = new WeakMap();
  const originalBudget = ChatCompletion.prototype.setTokenBudget;
  ChatCompletion.prototype.setTokenBudget = function (...args) {
    history = [];
    const result = originalBudget.apply(this, args);
    if (isManaged()) this.tokenBudget = Infinity;
    return result;
  };

  const originalSquash = ChatCompletion.prototype.squashSystemMessages;
  ChatCompletion.prototype.squashSystemMessages = async function (...args) {
    const before = this.messages.flatten().filter(message => message.content || message.tool_calls)
      .map(message => ({ message, identifier: message.identifier, content: message.content, role: message.role }));
    const result = await originalSquash.apply(this, args);
    const remaining = new Set(this.messages.flatten());
    let group = [];
    const record = () => {
      if (group.length > 1 && group.every(item => item.role === 'system' && typeof item.content === 'string')
        && group.map(item => item.content).join('\n') === group[0].message.content) {
        bundles.set(group[0].message, group.map(item => item.identifier));
      }
    };
    // The native builder keeps the first Message object of each merged group.
    // Prove its concatenation before carrying the constituent identities forward.
    for (const item of before) {
      if (remaining.has(item.message)) { record(); group = []; }
      group.push(item);
    }
    record();
    return result;
  };

  const originalChat = ChatCompletion.prototype.getChat;
  ChatCompletion.prototype.getChat = function (...args) {
    const chat = originalChat.apply(this, args);
    if (isManaged()) captureChatOrigins(chat, this.messages.flatten().filter(message => message.content || message.tool_calls)
      .map(message => ({ identifier: message.identifier, identifiers: bundles.get(message) || [message.identifier], role: message.role, content: message.content })));
    return chat;
  };

  // Record the actual macro-expanded history, including random macros, names and
  // reasoning. Re-evaluating it later can produce a different prompt altogether.
  const originalPrepare = promptManager.preparePrompt;
  promptManager.preparePrompt = function (prompt, ...args) {
    const { content: before, role: beforeRole, name, identifier } = prompt;
    const prepared = originalPrepare.call(this, prompt, ...args);
    if (/^chatHistory-\d+$/.test(identifier)) {
      history.push({ before, after: prepared.content, beforeRole, role: prepared.role, name, identifier });
    }
    return prepared;
  };

  const originalRender = promptManager.renderPromptManager;
  promptManager.renderPromptManager = async function (...args) {
    const result = await originalRender.apply(this, args);
    if (isManaged()) {
      const header = this.containerElement?.querySelector(`.${this.configuration.prefix}prompt_manager_header`);
      const counter = header?.lastElementChild;
      if (counter) counter.textContent = MANAGED_CONTEXT_LABEL;
    }
    return result;
  };

  return {
    reset() { history = []; },
    snapshot() { return [...history]; },
    // The builder visits history newest first. Resolve duplicates in that same
    // order and consume each occurrence once; injected prompts cannot steal it.
    format(conversation, formatMessage, records = history) {
      const formatted = conversation.map(formatMessage);
      const used = new Set();
      const result = new Array(conversation.length);
      for (let index = conversation.length - 1; index >= 0; index--) {
        const message = formatted[index];
        if (!message) continue;
        const eligible = item => !used.has(item) && item.role === message.role && item.name === message.name;
        const match = records.find(item => eligible(item) && item.before === message.content)
          || records.find(item => eligible(item) && typeof item.before === 'string'
            && item.before.endsWith(String(conversation[index].mes || '').replace(/\r/g, '')));
        if (match) used.add(match);
        result[index] = { ...conversation[index], promptRole: message.role,
          promptIdentifier: match?.identifier ?? conversation[index].promptIdentifier,
          promptText: match?.after ?? conversation[index].promptText ?? message.content };
      }
      return result.filter(Boolean);
    },
  };
}
