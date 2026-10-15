// Disable only the native ChatCompletion truncation budget. Keep the tokenizer,
// configured context/output limits and message costs available to our preflight.
export const MANAGED_CONTEXT_LABEL = 'Managed by Silly Memories';

export function installNativeContextManagement({ ChatCompletion, promptManager, isManaged }) {
  let history = [];
  const originalBudget = ChatCompletion.prototype.setTokenBudget;
  ChatCompletion.prototype.setTokenBudget = function (...args) {
    history = [];
    const result = originalBudget.apply(this, args);
    if (isManaged()) this.tokenBudget = Infinity;
    return result;
  };

  // Record the actual macro-expanded history, including random macros, names and
  // reasoning. Re-evaluating it later can produce a different prompt altogether.
  const originalPrepare = promptManager.preparePrompt;
  promptManager.preparePrompt = function (prompt, ...args) {
    const prepared = originalPrepare.call(this, prompt, ...args);
    if (/^chatHistory-\d+$/.test(prompt.identifier)) {
      history.push({ before: prompt.content, after: prepared.content, role: prepared.role, name: prompt.name });
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

  const originalListRender = promptManager.renderPromptManagerListItems;
  if (originalListRender) promptManager.renderPromptManagerListItems = async function (...args) {
    const result = await originalListRender.apply(this, args);
    if (isManaged()) {
      const row = this.containerElement?.querySelector('[data-pm-identifier="chatHistory"]');
      const counter = row?.querySelector('.prompt_manager_prompt_tokens');
      if (counter) {
        row.classList.add('smp-managed-history');
        counter.textContent = MANAGED_CONTEXT_LABEL;
        delete counter.dataset.pmTokens;
      }
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
          promptText: match?.after ?? conversation[index].promptText ?? message.content };
      }
      return result.filter(Boolean);
    },
  };
}
