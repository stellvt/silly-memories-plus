// Identities always describe stored chat, never prompt-regex or macro output.
export function fastHash(value) {
  const source = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function getMessageIdentity(message) {
  return String(message?.id ?? message?.extra?.sillyFriends?.clientMsgId ?? '');
}

export function fingerprintMessage(message) {
  const index = Math.max(0, Number(message?.index) || 0);
  const id = getMessageIdentity(message);
  const role = message?.is_user ? 'user' : 'assistant';
  return { index, id, hash: fastHash(`${role}\u0000${message?.name || ''}\u0000${String(message?.mes || '')}`) };
}

export function buildSourceHash(fingerprints) {
  return fastHash(fingerprints.map(item => `${item.index}:${item.id}:${item.hash}`).join('|'));
}

export function findCurrentMessage(chat, fingerprint) {
  // A removed stable ID must not silently resolve to an unrelated shifted index.
  return fingerprint.id ? chat.find(message => getMessageIdentity(message) === fingerprint.id)
    : chat.find(message => Number(message?.index) === Number(fingerprint.index));
}

export function inspectBlockSource(block, chat, requireComplete = false) {
  const source = chat.filter(message => message.index >= block.sourceFrom && message.index <= block.sourceTo);
  const hidden = source.find(message => message.extra?.[Symbol.for('ignore')]);
  if (hidden) return { matches: false, reason: 'source-hidden', source: { index: hidden.index } };
  const fingerprints = block.sourceFingerprints || [];
  const complete = fingerprints.length === block.sourceTo - block.sourceFrom + 1
    && new Set(fingerprints.map(item => item.index)).size === fingerprints.length
    && fingerprints.every(item => item.index >= block.sourceFrom && item.index <= block.sourceTo);
  if (fingerprints.length && (!requireComplete || complete)) {
    for (const fingerprint of fingerprints) {
      const message = findCurrentMessage(chat, fingerprint);
      const actualHash = message ? fingerprintMessage(message).hash : null;
      if (!message || message.index !== fingerprint.index || actualHash !== fingerprint.hash) {
        return { matches: false, reason: !message ? 'source-missing' : message.index !== fingerprint.index ? 'source-moved' : 'content-changed',
          source: { index: fingerprint.index, actualIndex: message?.index ?? null, expectedHash: fingerprint.hash, actualHash } };
      }
    }
    return { matches: true };
  }
  // Aggregate evidence is valid only for a complete, identical stored range.
  if (source.length !== block.sourceTo - block.sourceFrom + 1) return { matches: false, reason: 'source-range-incomplete' };
  const actualHash = buildSourceHash(source.map(fingerprintMessage));
  return { matches: Boolean(block.sourceHash) && actualHash === block.sourceHash,
    reason: block.sourceHash ? 'source-hash-mismatch' : 'source-unverifiable', source: { expectedHash: block.sourceHash || null, actualHash } };
}

export function blockSourceMatches(block, chat, requireComplete = false) {
  return inspectBlockSource(block, chat, requireComplete).matches;
}

export function hasSourceIdentity(block) {
  // An empty identity cannot establish that stored content changed.
  return Boolean(block.sourceFingerprints?.length || (block.sourceHash && block.sourceHash !== buildSourceHash([])));
}

export function reconcileMemorySources(memory, chat) {
  const changedIds = [];
  const recoveredIds = [];
  const changes = [];
  const byId = new Map(memory.blocks.map(block => [block.id, block]));
  const overlaps = (a, b) => a.sourceFrom <= b.sourceTo && b.sourceFrom <= a.sourceTo;
  const invalidate = (block, evidence) => {
    if (block.status === 'stale') return;
    const previous = block.status;
    block.status = 'stale'; block.staleReason = evidence.reason;
    changedIds.push(block.id);
    changes.push({ id: block.id, level: block.level, from: block.sourceFrom, to: block.sourceTo, previous, status: 'stale', ...evidence });
  };
  for (const block of memory.blocks) {
    const evidence = inspectBlockSource(block, chat);
    if (block.status === 'active' && !evidence.matches && (hasSourceIdentity(block) || evidence.reason === 'source-hidden')) invalidate(block, evidence);
  }
  const chosen = memory.blocks.filter(block => block.status === 'active');
  const candidates = memory.blocks.filter(block => block.status === 'stale')
    .sort((a, b) => a.sourceFrom - b.sourceFrom || b.level - a.level || b.createdAt - a.createdAt);
  const visited = new Set();
  const recover = block => {
    if (!block || visited.has(block.id)) return;
    visited.add(block.id);
    if (chosen.some(active => overlaps(active, block))) {
      for (const id of block.children) recover(byId.get(id));
      return;
    }
    const evidence = inspectBlockSource(block, chat, true);
    if (evidence.matches && block.staleReason !== 'summary-edited') {
      const previous = block.status;
      block.status = 'active'; delete block.staleReason;
      block.sourceFingerprints = chat.filter(message => message.index >= block.sourceFrom && message.index <= block.sourceTo).map(fingerprintMessage);
      chosen.push(block); recoveredIds.push(block.id);
      changes.push({ id: block.id, level: block.level, from: block.sourceFrom, to: block.sourceTo, previous, status: 'active', reason: 'source-verified' });
      return;
    }
    // An archived node stays archived; inspect its children independently rather
    // than requiring every ancestor to be a valid reusable summary.
    for (const id of block.children) recover(byId.get(id));
  };
  for (const block of candidates) recover(block);
  return { memory, changedIds, recoveredIds, changes };
}
