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
    <label>
      <span>Narrative</span>
      <textarea class="text_pole" rows="8" data-field="narrative">${escapeHtml(structured.narrative)}</textarea>
    </label>
    <small class="smp-field-hint">Ledger fields use one entry per line.</small>
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

export function renderBlockCard(block, { selected = false, editing = false, mergeSelected = false } = {}) {
  return `
    <details class="smp-block${selected ? ' smp-selected' : ''}" data-status="${block.status}" data-use-raw="${block.useRaw}" data-block-id="${escapeHtml(block.id)}" aria-selected="${selected}"${editing ? ' open' : ''}>
      <summary>
        ${block.status === 'active' ? `
          <button class="smp-level smp-rollup-level" type="button" data-smp-rollup-select value="${escapeHtml(block.id)}" aria-pressed="${mergeSelected}" aria-label="Select this L${block.level} block for a manual L${block.level + 1} merge" title="Select for merge into L${block.level + 1}"${block.useRaw ? ' disabled' : ''}>L${block.level}</button>
        ` : `<span class="smp-level">L${block.level}</span>`}
        <span>${block.sourceFrom}–${block.sourceTo}</span>
        <span>${block.sourceTokens} → ${block.summaryTokens}t${block.useRaw ? ` · raw ${block.rawTokens}t` : ''}</span>
        <span class="smp-status">${block.status}${block.useRaw ? ' · raw' : ''}</span>
      </summary>
      <div class="smp-block-local-actions">
        ${block.status === 'active' ? `
          <button class="menu_button" type="button" data-smp-block-action="toggle-raw">
            <i class="fa-solid ${block.useRaw ? 'fa-eye' : 'fa-eye-slash'}"></i><span>${block.useRaw ? 'Restore summary' : 'Hide summary'}</span>
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
