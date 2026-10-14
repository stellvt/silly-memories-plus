const events = [];
let chat = 0;
export function recordDiagnostic(type, details = {}) {
  if (type === 'chat-changed') chat++;
  events.push({ time: new Date().toISOString(), chat, type, ...details });
  if (events.length > 500) events.splice(0, events.length - 500);
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
  return { version: '0.7.1', exportedAt: new Date().toISOString(), settings: {
    enabled: settings.enabled, triggerRatio: settings.triggerRatio,
    blockTargetTokens: settings.blockTargetTokens, minimumSourceTokens: settings.minimumSourceTokens,
    summaryInputBudgetTokens: settings.summaryInputBudgetTokens, summaryMaxOutputTokens: settings.summaryMaxOutputTokens,
    separateSummarizer: Boolean(settings.summaryProfileId), summaryRole: settings.summaryRole,
    includeStructuredMemory: settings.includeStructuredMemory, debug: settings.debug, language: settings.language,
  }, context, events: [...events] };
}
