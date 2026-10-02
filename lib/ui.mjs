export const BLOCK_EDITOR_FIELDS = Object.freeze([
  ['relationships', 'Relationships'],
  ['importantItems', 'Important items'],
  ['characterStates', 'Character states'],
  ['locations', 'Locations'],
  ['commitments', 'Commitments'],
  ['openThreads', 'Open threads'],
  ['resolvedThreads', 'Resolved threads'],
  ['worldFacts', 'World facts'],
  ['exactTerms', 'Exact terms'],
]);

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderContextUsage(usage) {
  const format = value => Number(value).toLocaleString('en-US');
  const parts = [['memory', 'Memory'], ['raw', 'History'], ['facts', 'Pinned facts'], ['other', 'Other prompt']];
  const marker = usage.automatic ? `<span class="smp-context-trigger" style="left:${usage.triggerRatio * 100}%" title="Compaction threshold: ${Math.round(usage.triggerRatio * 100)}%"></span>` : '';
  const segments = parts.map(([key, label]) => `<span class="smp-context-segment" data-part="${key}" style="width:${Math.min(100, usage[key] / usage.budget * 100)}%" title="${label}: ${format(usage[key])} tokens"></span>`).join('');
  const remaining = usage.overflow ? `${format(usage.overflow)} tokens over budget`
    : !usage.automatic ? 'Automatic compaction off'
    : usage.triggerRemaining ? `${usage.otherKnown ? '' : '≤ '}${format(usage.triggerRemaining)} tokens until compaction (${Math.round(usage.triggerRatio * 100)}%)`
    : `Compaction threshold reached (${Math.round(usage.triggerRatio * 100)}%)`;
  return `
    <div class="smp-context-heading"><b>Context</b><span>${usage.otherKnown ? '≈' : '≥'} ${format(usage.used)} / ${format(usage.budget)}t · ${Math.round(usage.used / usage.budget * 100)}%</span></div>
    <div class="smp-context-track" role="progressbar" aria-label="Context usage" aria-valuemin="0" aria-valuemax="${usage.budget}" aria-valuenow="${Math.min(usage.used, usage.budget)}" aria-valuetext="${format(usage.used)} of ${format(usage.budget)} tokens${usage.otherKnown ? ', estimate' : ', other prompt not measured'}">${segments}${marker}</div>
    <div class="smp-context-legend">${parts.map(([key, label]) => `<span><i data-part="${key}" aria-hidden="true"></i>${label}: ${key === 'other' && !usage.otherKnown ? '—' : format(usage[key]) + 't'}</span>`).join('')}</div>
    <div class="smp-context-foot"><span>${remaining}</span><span>${usage.otherKnown ? '' : '≤ '}${format(usage.free)}t free</span></div>`;
}

export function renderStructuredLibrary(block = {}) {
  const structured = block.structured || {};
  const sections = [
    ['Narrative', structured.narrative, 'narrative'],
    ['Relationships', structured.relationships, 'relationships'],
    ['Important items', structured.importantItems, 'importantItems'],
    ['Character states', structured.characterStates, 'characterStates'],
    ['Locations', structured.locations, 'locations'],
    ['Commitments', structured.commitments, 'commitments'],
    ['Open threads', structured.openThreads, 'openThreads'],
    ['Resolved threads', structured.resolvedThreads, 'resolvedThreads'],
    ['World facts', structured.worldFacts, 'worldFacts'],
    ['Exact terms', structured.exactTerms, 'exactTerms'],
  ].filter(([, values, field]) => field === 'narrative' ? Boolean(values) : Array.isArray(values) && values.length);
  return `<div class="smp-structured">${sections.map(([label, values, field]) => `
    <section data-section="${field}">
      <b>${escapeHtml(label)}</b>
      ${field === 'narrative'
        ? `<p>${escapeHtml(values)}</p>`
        : `<ul>${values.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`}
    </section>`).join('')}</div>`;
}

export function renderBlockEditor(block, visible = false) {
  const structured = block.structured || {};
  const fields = BLOCK_EDITOR_FIELDS.map(([field, label]) => {
    const values = Array.isArray(structured[field]) ? structured[field] : [];
    return `<label>
      <span>${escapeHtml(label)}</span>
      <textarea class="text_pole" rows="4" data-field="${field}">${escapeHtml(values.join('\n'))}</textarea>
    </label>`;
  }).join('');
  return `<div class="smp-inline-editor"${visible ? '' : ' hidden'}>
    <label><span>Title</span><input class="text_pole" data-field="title" maxlength="80" value="${escapeHtml(structured.title || '')}"></label>
    <label>
      <span>Narrative</span>
      <textarea class="text_pole" rows="8" data-field="narrative">${escapeHtml(structured.narrative)}</textarea>
    </label>
    <div class="smp-editor-fields">${fields}</div>
    <div class="smp-editor-actions">
      <button class="menu_button" type="button" data-smp-block-action="save-edit">
        <i class="fa-solid fa-check"></i><span>Save block</span>
      </button>
      <button class="menu_button" type="button" data-smp-block-action="cancel-edit">
        <i class="fa-solid fa-xmark"></i><span>Cancel</span>
      </button>
    </div>
  </div>`;
}

export function getBlockTitle(block) {
  return block.structured.title || block.structured.narrative.split(/[\n.!?]/)[0].trim().slice(0, 80) || 'Untitled block';
}

export function renderRegenerationComparison(saved, replacement) {
  return [['Saved block', saved], ['New variant', replacement]].map(([label, block]) => `
    <section>
      <b>${label}</b>
      <p class="smp-block-title" title="${escapeHtml(getBlockTitle(block))}">${escapeHtml(getBlockTitle(block))}</p>
      <div class="smp-preview-scroll">${renderStructuredLibrary(block)}</div>
    </section>`).join('');
}

export function renderBlockCard(block, { selected = false, editing = false, mergeSelected = false } = {}) {
  const title = getBlockTitle(block);
  return `
    <details class="smp-block${selected ? ' smp-selected' : ''}" data-status="${block.status}" data-use-raw="${block.useRaw}" data-block-id="${escapeHtml(block.id)}" aria-selected="${selected}"${editing ? ' open' : ''}>
      <summary>
        ${block.status === 'active' ? `
          <button class="smp-level smp-rollup-level" type="button" data-smp-rollup-select value="${escapeHtml(block.id)}" aria-pressed="${mergeSelected}" aria-label="Select this L${block.level} block for a manual L${block.level + 1} merge" title="Select for merge into L${block.level + 1}"${block.useRaw ? ' disabled' : ''}>L${block.level}</button>
        ` : `<span class="smp-level">L${block.level}</span>`}
        <span class="smp-block-heading"><span class="smp-block-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span><small>${block.sourceFrom}–${block.sourceTo} · ${block.sourceTokens} → ${block.summaryTokens}t${block.useRaw ? ` · raw ${block.rawTokens}t` : ''}</small></span>
        <span class="smp-status">${block.status}${block.useRaw ? ' · raw' : ''}</span>
      </summary>
      <div class="smp-block-local-actions">
        ${block.status === 'active' ? `
          <button class="menu_button" type="button" data-smp-block-action="toggle-raw">
            <i class="fa-solid ${block.useRaw ? 'fa-eye' : 'fa-eye-slash'}"></i><span>${block.useRaw ? 'Use summary' : 'Use original history'}</span>
          </button>` : ''}
        <button class="menu_button" type="button" data-smp-block-action="edit">
          <i class="fa-solid fa-pen-to-square"></i><span>Edit</span>
        </button>
        <button class="menu_button redWarningBG" type="button" data-smp-block-action="delete">
          <i class="fa-solid fa-trash"></i><span>Delete</span>
        </button>
      </div>
      <div class="smp-block-scroll">
        <div class="smp-block-view"${editing ? ' hidden' : ''}>
          ${renderStructuredLibrary(block)}
          <div class="smp-block-meta">ID: ${escapeHtml(block.id)}${block.children.length ? ` · Children: ${block.children.length}` : ''}</div>
        </div>
        ${renderBlockEditor(block, editing)}
      </div>
    </details>`;
}
