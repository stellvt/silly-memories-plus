import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeContextManagement, MANAGED_CONTEXT_LABEL } from '../lib/native-context.mjs';
import { locateChatConversation, missingHistory, replaceChatMemory } from '../lib/prompt.mjs';

function fixture() {
  let managed = true;
  class ChatCompletion { setTokenBudget(context, response) { this.tokenBudget = context - response; } }
  const counter = { textContent: '' };
  let evaluations = 0;
  const promptManager = {
    configuration: { prefix: 'completion_' },
    containerElement: { querySelector: () => ({ lastElementChild: counter }) },
    preparePrompt: prompt => ({ ...prompt, content: prompt.content.replace(/\{\{random\}\}/g, () => `RANDOM-${++evaluations}`) }),
    renderPromptManager: async () => { counter.textContent = 'Total Tokens: 900'; },
  };
  const bridge = installNativeContextManagement({ ChatCompletion, promptManager, isManaged: () => managed });
  return { ChatCompletion, promptManager, bridge, counter, disable: () => { managed = false; } };
}

test('native clipping is bypassed without changing configured limits or disabling real tokenizers', async () => {
  const f = fixture(); const completion = new f.ChatCompletion();
  completion.setTokenBudget(8192, 512); assert.equal(completion.tokenBudget, Infinity);
  await f.promptManager.renderPromptManager(); assert.equal(f.counter.textContent, MANAGED_CONTEXT_LABEL);
  f.disable(); completion.setTokenBudget(8192, 512); assert.equal(completion.tokenBudget, 7680);
  await f.promptManager.renderPromptManager(); assert.equal(f.counter.textContent, 'Total Tokens: 900');
});

test('actual macro-expanded history is matched without evaluating macros again', () => {
  const f = fixture();
  const source = [{ name: 'Mira', mes: 'Value {{random}}', index: 0 }, { name: 'Mira', mes: 'Value {{random}}', index: 1 }];
  const messages = [1, 0].map(index => f.promptManager.preparePrompt({ identifier: `chatHistory-${index + 1}`, name: 'Mira', role: 'assistant', content: source[index].mes })).reverse();
  const formatted = f.bridge.format(source, message => ({ name: message.name, role: 'assistant', content: message.mes }));
  assert.deepEqual(formatted.map(item => item.promptText), ['Value RANDOM-2', 'Value RANDOM-1']);
  assert.equal(locateChatConversation(messages, source.map(item => ({ ...item, promptRole: 'assistant' }))).size, 0, 'old matching misclassified all macro history as other prompt');
  assert.equal(locateChatConversation(messages, formatted).size, 2);
  assert.deepEqual(missingHistory(formatted, locateChatConversation(messages, formatted)), []);
});

test('replacement removes compiled history at its boundary and preserves preset/lore', () => {
  const source = [{ mes: 'Old {{random}}', promptText: 'Old RANDOM-1', promptRole: 'assistant', index: 0 }, { mes: 'Recent', promptText: 'Mira: Recent', promptRole: 'assistant', index: 1 }];
  const next = [{ mes: 'Memory', promptRole: 'system', extra: { sillyMemoriesPlus: true } }, source[1]];
  const result = replaceChatMemory([{ role: 'system', content: 'Preset and lore' }, { role: 'assistant', content: 'Old RANDOM-1' }, { role: 'assistant', content: 'Mira: Recent' }], source, next);
  assert.deepEqual(result, [{ role: 'system', content: 'Preset and lore' }, { role: 'system', content: 'Memory' }, { role: 'assistant', content: 'Mira: Recent' }]);
});

test('a request keeps its exact macro expansions after a background assembly resets native state', () => {
  const f = fixture();
  const source = [{ name: 'Mira', mes: '{{random}}', index: 0 }];
  const first = f.promptManager.preparePrompt({ identifier: 'chatHistory-1', name: 'Mira', role: 'assistant', content: '{{random}}' });
  const snapshot = f.bridge.snapshot();
  new f.ChatCompletion().setTokenBudget(8000, 512);
  const background = f.promptManager.preparePrompt({ identifier: 'chatHistory-1', name: 'Mira', role: 'assistant', content: '{{random}}' });
  assert.notEqual(first.content, background.content);
  const formatted = f.bridge.format(source, message => ({ name: message.name, role: 'assistant', content: message.mes }), snapshot);
  assert.equal(formatted[0].promptText, first.content);
  assert.equal(locateChatConversation([first], formatted).size, 1);
});
