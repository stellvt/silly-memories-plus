const events = [];
let chat = 0;
let request = 0;
let bytes = 0;
const sizes = [];
export function nextDiagnosticRequest() { return ++request; }
export function recordDiagnostic(type, details = {}) {
  if (type === 'chat-changed') chat++;
  const entry = { time: new Date().toISOString(), chat, type, ...details };
  for (const key of ['inventory', 'components', 'missing', 'blocks', 'excluded', 'sourceIndices', 'tailIndices']) {
    if (Array.isArray(entry[key]) && entry[key].length > 2000) {
      entry[`${key}Total`] = entry[key].length;
      entry[key] = entry[key].slice(0, 2000);
      entry.truncated = true;
    }
  }
  const size = JSON.stringify(entry).length;
  events.push(entry); sizes.push(size); bytes += size;
  while (events.length > 500 || bytes > 4 * 1024 * 1024 && events.length > 1) {
    events.shift(); bytes -= sizes.shift();
  }
}
export function diagnosticError(error) {
  const causes = [];
  const seen = new Set();
  while (error && !seen.has(error) && causes.length < 6) {
    seen.add(error);
    causes.push({ name: error.name, code: error.translationKey,
      status: typeof error.status === 'number' ? error.status : undefined,
      location: error.stack?.match(/(?:index\.js|[a-z-]+\.mjs):\d+:\d+/)?.[0] });
    error = error.cause;
  }
  return causes;
}
export function exportDiagnostics(settings, context) {
  return { version: '0.8.2', exportedAt: new Date().toISOString(), settings: {
    enabled: settings.enabled, triggerRatio: settings.triggerRatio,
    blockTargetTokens: settings.blockTargetTokens, minimumSourceTokens: settings.minimumSourceTokens,
    summaryInputBudgetTokens: settings.summaryInputBudgetTokens, summaryMaxOutputTokens: settings.summaryMaxOutputTokens,
    separateSummarizer: Boolean(settings.summaryProfileId), summaryRole: settings.summaryRole,
    includeStructuredMemory: settings.includeStructuredMemory, debug: settings.debug, language: settings.language,
  }, context, events: [...events] };
}
