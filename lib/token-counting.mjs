// Share only work in flight. The host owns completed counts; exact keys keep
// roles, tool fields and content distinct without introducing another hash cache.
function shareTokenCounts(count, getScope, scopeChanged) {
  const pending = new Map();
  return (...args) => {
    const scope = getScope();
    const key = JSON.stringify([scope, args]);
    if (!pending.has(key)) {
      const promise = Promise.resolve().then(() => {
        if (scope !== getScope()) throw scopeChanged();
        return count(...args);
      }).finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    return pending.get(key);
  };
}

export function createChatTokenCounter(count, getScope, getModel, scopeChanged) {
  const single = shareTokenCounts(message => count(message, true), getScope, scopeChanged);
  return async (messages, full = false) => {
    const scope = getScope();
    const model = getModel();
    const list = Array.isArray(messages) ? messages : [messages];
    let tokens = -1;
    // Single-message host calls capture endpoint and cache model before awaiting
    // I/O. Keep native batch overhead and Claude's full-count behavior intact.
    // Each single count includes -1; apply that adjustment once per batch.
    for (const message of list) {
      if (scope !== getScope()) throw scopeChanged();
      tokens += await single(message) + 1;
    }
    if (scope !== getScope()) throw scopeChanged();
    const countedFull = full || (list.length > 0 && model === 'claude');
    return countedFull ? tokens : tokens - 2;
  };
}
