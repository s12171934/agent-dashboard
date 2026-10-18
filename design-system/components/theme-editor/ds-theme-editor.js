// <ds-theme-editor class="popover …" hidden></ds-theme-editor>: the 「색 편집」 panel. Material, palette examples and
// one colour picker per THEME_VARS token, for the light or dark base in effect. Overrides are kept per base (a custom
// dark theme survives switching to light and back) in adash.theme.custom; every change applies at once, 「기본값」
// drops one colour and 「모두 기본값」 the whole base. Open and close it with `hidden`; it renders when shown and
// follows theme and material changes (ds:theme, ds:material) while open.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const saveCustom = c => save('adash.theme.custom', JSON.stringify(c));
const palOn = (set, own = {}) => THEME_VARS.every(([v]) => own[v] === set[v]);  // the base's colours are exactly that palette

class DsThemeEditor extends HTMLElement {
  static observedAttributes = ['hidden'];
  connectedCallback() {
    if (this.wired) return;
    this.wired = true;
    // a colour picker being dragged applies the theme on every move: that one must not redraw the panel under it
    const redraw = () => { if (!this.hidden && !this.quiet) this.render(); };
    document.addEventListener('ds:theme', redraw);
    document.addEventListener('ds:material', redraw);
  }
  attributeChangedCallback() { if (!this.hidden) this.render(); }
  render() {
    const base = document.documentElement.dataset.theme, own = themeCustom()[base] || {}, baseName = base === 'dark' ? '다크' : '라이트';
    const cur = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    this.innerHTML = `<div class="pop-h"><b>${baseName} 테마 색</b><span class="st">이 기기에만 저장 · 바꾸는 즉시 적용</span>
        <button class="act" data-tp="reset-all">모두 기본값</button><button class="act" data-tp="close">닫기</button></div>
      <div class="tp-mat"><span>재질</span><span class="seg">${MATERIALS.map(([k, n]) => `<button data-mat="${k}"${k === materialChoice() ? ' class="on"' : ''}>${n}</button>`).join('')}</span></div>
      <div class="tp-pals"><span class="st">팔레트 예시</span>${PALETTES.map(([n, p], i) => {
        const set = p[base];
        return `<button class="tp-pal${palOn(set, own) ? ' on' : ''}" data-pal="${i}" title="${esc(n)} ${baseName} 팔레트 적용">
          <span class="tp-sw" style="background:${set['--bg']};border-color:${set['--line']}">${['--accent', '--done', '--warn', '--bad'].map(v => `<i style="background:${set[v]}"></i>`).join('')}</span>${esc(n)}</button>`;
      }).join('')}</div>
      <div class="tp-grid">${THEME_VARS.map(([v, n]) => `<label class="tp-row${own[v] ? ' own' : ''}"><input type="color" data-var="${v}" value="${esc(cur(v))}"><span>${n}</span>
        <button class="act" data-tp="reset" data-var="${v}"${own[v] ? '' : ' disabled'}>기본값</button></label>`).join('')}</div>`;
    this.querySelectorAll('input[type=color]').forEach(i => i.oninput = () => {
      const c = themeCustom(); (c[base] ||= {})[i.dataset.var] = i.value; saveCustom(c);
      this.quiet = true; applyTheme(); this.quiet = false;
      const row = i.closest('.tp-row'); row.classList.add('own'); row.querySelector('button').disabled = false;
      this.querySelectorAll('.tp-pal').forEach(b => b.classList.toggle('on', palOn(PALETTES[+b.dataset.pal][1][base], c[base])));
    });
    this.querySelectorAll('[data-mat]').forEach(b => b.onclick = () => { save('adash.material', b.dataset.mat); applyMaterial(b.dataset.mat); });
    this.querySelectorAll('[data-pal]').forEach(b => b.onclick = () => {
      const c = themeCustom(); c[base] = { ...PALETTES[+b.dataset.pal][1][base] }; saveCustom(c); applyTheme();
    });
    this.querySelectorAll('[data-tp]').forEach(b => b.onclick = () => {
      if (b.dataset.tp === 'close') { this.hidden = true; return; }
      const c = themeCustom();
      if (b.dataset.tp === 'reset') delete (c[base] || {})[b.dataset.var];
      else delete c[base];
      saveCustom(c); applyTheme();
    });
  }
}
customElements.define('ds-theme-editor', DsThemeEditor);
