const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function page(shared = false, becomeLeader = false) {
  const sources = [], channels = [];
  let now = 10000, requestedSignal;
  const snapshot = { api: 1, version: 1, sessions: [], orca: { runs: [], tasks: {}, workers: [], terminals: [] }, tests: { files: [] }, ext_plans: [] };
  class Source { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } addEventListener() {} }
  class Channel { constructor() { this.sent = []; channels.push(this); } postMessage(m) { this.sent.push(m); } }
  const window = shared ? { BroadcastChannel: Channel } : {};
  const context = vm.createContext({ window, navigator: shared ? { locks: { request: (_name, fn) => becomeLeader && fn() } } : {},
    localStorage: { getItem: key => key === 'adash.servers' ? '[{"id":"local","name":"Mac","url":"http://127.0.0.1:8787","on":true}]' : null, setItem() {}, removeItem() {} },
    location: { search: '', pathname: '/', hash: '', protocol: 'http:' }, history: { replaceState() {} }, addEventListener() {},
    EventSource: Source, BroadcastChannel: Channel, URL, URLSearchParams, AbortSignal, console,
    Date: class extends Date { static now() { return now; } },
    fetch: async (_url, options) => { requestedSignal = options?.signal; return { ok: true, status: 200, json: async () => snapshot }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/api.js'), 'utf8'), context);
  const api = vm.runInContext('api', context);
  api.events({ version() {}, change() {}, projects() {} });
  return { api, sources, channels, advance: () => now += 1001, signal: () => requestedSignal };
}
test('native resume replaces the stale stream and coalesces overlapping lifecycle hooks', () => {
  const p = page(); assert.equal(p.sources.length, 1);
  p.api.resume(); assert.equal(p.sources.length, 2); assert.equal(p.sources[0].closed, true);
  p.api.resume(); assert.equal(p.sources.length, 2);
  p.advance(); p.api.resume(); assert.equal(p.sources.length, 3);
});
test('a follower asks the shared stream owner to reconnect without opening its own socket', () => {
  const p = page(true); p.api.resume(); assert.equal(p.sources.length, 0);
  assert.ok(p.channels[0].sent.some(m => m.t === 'resume'));
});
test('the stream owner handles another native window resuming', () => {
  const p = page(true, true); assert.equal(p.sources.length, 1);
  p.channels[0].onmessage({ data: { t: 'resume' } });
  assert.equal(p.sources.length, 2); assert.equal(p.sources[0].closed, true);
});
test('snapshot reads have a deadline so a suspended connection cannot block every subsequent refresh', async () => {
  const p = page(); const state = await p.api.state(); assert.equal(state.api, 1);
  assert.ok(p.signal() instanceof AbortSignal);
});
