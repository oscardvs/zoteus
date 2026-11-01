// Preloaded into a server process by tests/cli/entry.test.ts: one promise rejection that
// belongs to no request, the shape pdf.js left behind on 2026-10-26.
setTimeout(() => {
  void Promise.reject(new Error('XRefEntryException: stray rejection from a test preload'));
}, 1500);
