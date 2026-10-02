let russian = {};
let language = 'auto';
let hostLocale = 'en';
let nativeTranslate = text => text;
let loading;

export async function initializeI18n(locale, translator) {
  hostLocale = String(locale || 'en').toLowerCase();
  nativeTranslate = translator;
  loading ||= fetch(new URL('../i18n/ru-ru.json', import.meta.url)).then(async response => {
    if (!response.ok) throw new Error(`Cannot load Memory Plus translations: ${response.status}`);
    russian = await response.json();
  });
  await loading;
}

export function setLanguage(value) {
  language = ['auto', 'en', 'ru'].includes(value) ? value : 'auto';
}

export function translate(text) {
  const useRussian = language === 'ru' || language === 'auto' && hostLocale.startsWith('ru');
  if (!useRussian) return text;
  const key = `smp.${text}`;
  return language === 'auto' ? nativeTranslate(russian[key] || text, key) : russian[key] || text;
}

// Deferred messages keep their arguments when the language changes during a job.
export function message(strings, ...values) {
  const key = typeof strings === 'string' ? strings
    : strings.reduce((text, part, index) => text + part + (index < values.length ? `\${${index}}` : ''), '');
  return { key, toString: () => translate(key).replace(/\$\{(\d+)\}/g, (_, index) => {
    const value = values[index];
    return value instanceof Error ? value.message : String(value);
  }) };
}

export function t(strings, ...values) {
  return String(message(strings, ...values));
}

export function displayText(value) {
  if (value instanceof Error) return value.message;
  return typeof value === 'string' ? translate(value) : String(value);
}

export class LocalizedError extends Error {
  constructor(text, options) {
    super('', options);
    this.translationKey = text.key;
    Object.defineProperty(this, 'message', { configurable: true, get: () => displayText(text) });
  }
}

export function applyTranslations(root) {
  // Separate markers keep the host observer from overriding the extension's language.
  for (const element of root.querySelectorAll('[data-smp-i18n]')) {
    element.textContent = translate(element.dataset.smpI18n);
  }
  for (const element of root.querySelectorAll('[data-smp-i18n-aria]')) {
    element.setAttribute('aria-label', translate(element.dataset.smpI18nAria));
  }
}
