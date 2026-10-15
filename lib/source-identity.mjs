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

export function blockSourceMatches(block, chat, requireComplete = false) {
  const fingerprints = block.sourceFingerprints || [];
  const complete = fingerprints.length === block.sourceTo - block.sourceFrom + 1
    && new Set(fingerprints.map(item => item.index)).size === fingerprints.length
    && fingerprints.every(item => item.index >= block.sourceFrom && item.index <= block.sourceTo);
  if (fingerprints.length && (!requireComplete || complete)) return fingerprints.every(fingerprint => {
    const message = findCurrentMessage(chat, fingerprint);
    return message && Number(message.index) === Number(fingerprint.index)
      && fingerprintMessage(message).hash === fingerprint.hash;
  });
  // Older invalidation code erased per-message fingerprints, but left this hash.
  // Only a complete, identical source range is sufficient evidence to recover.
  const source = chat.filter(message => message.index >= block.sourceFrom && message.index <= block.sourceTo);
  return source.length === block.sourceTo - block.sourceFrom + 1 && Boolean(block.sourceHash)
    && buildSourceHash(source.map(fingerprintMessage)) === block.sourceHash;
}

export function hasSourceIdentity(block) {
  // Historical rollups made entirely from fingerprint-less children stored the
  // hash of an empty list. That is absence of evidence, not an edited source.
  return Boolean(block.sourceFingerprints?.length || (block.sourceHash && block.sourceHash !== buildSourceHash([])));
}

export function reconcileMemorySources(memory, chat) {
  const changedIds = [];
  const recoveredIds = [];
  for (const block of memory.blocks) {
    const matches = blockSourceMatches(block, chat);
    if (block.status === 'active' && !matches && hasSourceIdentity(block)) {
      block.status = 'stale';
      block.staleReason = 'source-changed';
      changedIds.push(block.id);
    }
    if (block.status === 'stale' && blockSourceMatches(block, chat, true) && block.staleReason !== 'summary-edited') {
      // Legacy summary edits left an indistinguishable raw hash on the old
      // rollup. An already active child is evidence to keep that parent archived.
      if (block.children.some(id => memory.blocks.some(child => child.id === id && child.status === 'active'))) continue;
      recoveredIds.push(block.id);
    }
  }
  // An edit invalidates rollups of that summary, even if raw chat is unchanged.
  // Such blocks are explicitly tagged and must never be resurrected by migration.
  const overlaps = (a, b) => a.sourceFrom <= b.sourceTo && b.sourceFrom <= a.sourceTo;
  const chosen = memory.blocks.filter(block => block.status === 'active');
  const candidates = memory.blocks.filter(block => recoveredIds.includes(block.id))
    .sort((a, b) => a.sourceFrom - b.sourceFrom || b.level - a.level || b.createdAt - a.createdAt);
  recoveredIds.length = 0;
  for (const block of candidates) {
    if (chosen.some(active => overlaps(active, block))) continue;
    chosen.push(block);
    recoveredIds.push(block.id);
  }
  const recoverable = new Set(recoveredIds);
  const eligible = chosen;
  const referenced = new Set(eligible.flatMap(block => block.children));
  for (const block of eligible) {
    if (!recoverable.has(block.id)) continue;
    block.status = referenced.has(block.id) ? 'retired' : 'active';
    delete block.staleReason;
    block.sourceFingerprints = chat.filter(message => message.index >= block.sourceFrom && message.index <= block.sourceTo).map(fingerprintMessage);
  }
  // A broken parent may still have valid retired children. Reuse those instead
  // of discarding the whole graph or paying for the same summary again.
  const activeReferences = new Set(memory.blocks.filter(block => block.status === 'active').flatMap(block => block.children));
  for (const block of memory.blocks) {
    if (block.status !== 'retired' || activeReferences.has(block.id)) continue;
    if (!memory.blocks.some(parent => parent.status === 'stale' && changedIds.includes(parent.id) && parent.children.includes(block.id))) continue;
    if (!memory.blocks.some(other => other.status === 'active' && overlaps(other, block)) && blockSourceMatches(block, chat, true)) {
      block.status = 'active'; recoveredIds.push(block.id);
    }
  }
  return { memory, changedIds, recoveredIds };
}
