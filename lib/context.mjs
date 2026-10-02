export function renderPinnedFacts(facts = '') {
  const text = String(facts || '').trim();
  return text ? JSON.stringify({ type: 'pinned_facts', facts: text }) : '';
}

export function getContextUsage({ budget, memory = 0, raw = 0, facts = 0, other = 0, otherKnown = false, triggerRatio = 0.75, automatic = true }) {
  const tokens = value => Math.max(0, Math.round(Number(value) || 0));
  const capacity = Math.max(1, tokens(budget));
  const parts = { memory: tokens(memory), raw: tokens(raw), facts: tokens(facts), other: tokens(other) };
  const used = Object.values(parts).reduce((total, value) => total + value, 0);
  const trigger = Math.floor(capacity * triggerRatio);
  return {
    ...parts, budget: capacity, used, otherKnown, automatic,
    free: Math.max(0, capacity - used), overflow: Math.max(0, used - capacity),
    trigger, triggerRatio, triggerRemaining: Math.max(0, trigger - used),
  };
}
