// Feature usage hook: which screens and controls get used, per environment, for server/ausage to tally.
// One document-level listener (capture, so handlers that stop propagation are still seen) names the control a click
// lands on; hash changes and visibility record which screen is open and for how long. Events are batched and posted
// to the first metrics server that is on (api.usage) every 30s and when the page is hidden.
// - Names only: a control is named by its id, else its first data-* attribute (with the value only when it reads like
//   a fixed key, never a path or id), else its label; digits become #. Typed text and values are never sent.
// - Environment: app (macos | ios from the native shells, pwa when installed, else web), form (phone ≤500px,
//   narrow ≤700px — iPhone Duo unfolded, tablet ≤1100px, desktop) with the fold posture when half folded, pointer
//   (coarse | fine), and a random id per device (localStorage adash.dev).
// - Off with localStorage adash.usage = 'off'.
(() => {
  const read = k => { try { return localStorage.getItem(k); } catch { return null; } };
  if (read('adash.usage') === 'off' || typeof api === 'undefined') return;
  const dev = read('adash.dev') || (() => { const id = Math.random().toString(36).slice(2, 10); try { localStorage.setItem('adash.dev', id); } catch {} return id; })();
  const COARSE = matchMedia('(pointer: coarse)');
  const app = () => window.adashApp || (matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'pwa' : 'web');
  const form = () => {
    const w = innerWidth, p = document.documentElement.dataset.posture;
    return (w <= 500 ? 'phone' : w <= 700 ? 'narrow' : w <= 1100 ? 'tablet' : 'desktop') + (p ? '-' + p : '');
  };
  const view = () => { try { return route().v; } catch { return 'home'; } };

  let queue = [];
  const add = (f, extra) => { queue.push({ t: Date.now(), v: view(), f, m: form(), ...extra }); if (queue.length >= 200) flush(); };
  function flush() {
    if (!queue.length) return;
    const events = queue; queue = [];
    api.usage({ app: app(), form: form(), pointer: COARSE.matches ? 'coarse' : 'fine', dev }, events);
  }
  setInterval(flush, 30000);

  // ---- naming a control ----
  const CONTROL = 'button, a[href], summary, select, label, [role=button], [role=tab], [role=menuitem], [data-v], ds-pill, ds-theme-toggle';
  // Attributes that carry a server, a tooltip or layout, not what the control does.
  const SKIP = new Set(['data-srv', 'data-server', 'data-tip', 'data-label', 'data-more', 'data-fab', 'data-h', 'data-kinds']);
  const tidy = s => (s || '').replace(/\s+/g, ' ').trim().replace(/\d+/g, '#').slice(0, 40);
  const stableId = id => id && !/\d{3,}|[0-9a-f]{8,}/i.test(id);
  const fixedKey = v => /^(?:[a-z][\w:-]{0,23}|\d{1,3})$/i.test(v) && !/\d{4,}/.test(v);  // a word, or a small number (a span's days)
  function nameOf(el) {
    if (stableId(el.id)) return '#' + el.id;
    let self = '';
    for (const a of el.attributes) {
      if (!a.name.startsWith('data-') || SKIP.has(a.name)) continue;
      self = '[' + a.name.slice(5) + (fixedKey(a.value) ? '=' + a.value : '') + ']';
      break;
    }
    if (!self) {
      const lbl = el.getAttribute('aria-label')?.split(':')[0] || el.dataset.tip || el.title || el.textContent;
      self = el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : '') + (tidy(lbl) ? ' "' + tidy(lbl) + '"' : '');
    }
    // Where it sits: the nearest ancestor with a stable id (a segment's buttons share data-k, a dialog's share classes).
    let p = el.parentElement;
    while (p && p !== document.body && !(stableId(p.id) && p.id !== 'view')) p = p.parentElement;
    return (p && p !== document.body ? '#' + p.id + ' > ' : '') + self;
  }

  // A label's click also clicks its input: both name the label, and the second within 300ms is dropped.
  let last = { f: '', t: 0 };
  document.addEventListener('click', e => {
    const el = e.target.closest?.(CONTROL);
    if (!el || el.matches('select')) return;  // a menu's choice is its change
    const f = nameOf(el.closest('label') || el), now = Date.now();
    if (f === last.f && now - last.t < 300) return;
    last = { f, t: now };
    add(f);
  }, true);
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.matches?.('select')) add(nameOf(el) + (fixedKey(el.value) ? ' = ' + el.value : ''));
    else if (el.matches?.('input[type=search], input[type=text], textarea')) add(nameOf(el) + ' (입력)');
  }, true);

  // ---- screens: 'open' when one shows, 'stay' with the visible seconds when it is left ----
  let cur = null, since = 0;
  const leave = () => { if (cur) { const d = Math.round((Date.now() - since) / 1000); if (d > 0) queue.push({ t: since, v: cur, f: 'stay', m: form(), d }); cur = null; } };
  const enter = () => { cur = view(); since = Date.now(); add('open'); };
  addEventListener('hashchange', () => { if (view() !== cur) { leave(); enter(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { leave(); flush(); } else enter(); });
  addEventListener('pagehide', () => { leave(); flush(); });
  if (!document.hidden) enter();
})();
