// <ds-theme-toggle button-class="…"></ds-theme-toggle>: one button that cycles the theme 시스템 → 라이트 → 다크,
// saves the choice (adash.theme) and shows the icon of the choice in effect. The element itself is display: contents;
// it renders a <button> with button-class (e.g. dock-btn, so it sits in a <ds-dock> like any other button).
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

class DsThemeToggle extends HTMLElement {
  connectedCallback() {
    if (this.btn) return;
    const b = this.btn = document.createElement('button');
    b.className = this.getAttribute('button-class') || '';
    b.innerHTML = '<ds-icon name="monitor"></ds-icon><ds-icon name="sun"></ds-icon><ds-icon name="moon"></ds-icon>';
    b.onclick = () => {
      const i = THEMES.findIndex(([k]) => k === themeChoice());
      const next = THEMES[(i + 1) % THEMES.length][0];
      save('adash.theme', next);
      applyTheme(next);
    };
    this.append(b);
    this.mark();
    document.addEventListener('ds:theme', () => this.mark());
  }
  mark() {
    const c = themeChoice(), name = (THEMES.find(([k]) => k === c) || THEMES[0])[1];
    this.setAttribute('choice', c);
    this.btn.dataset.tip = `테마 · ${name}`;
    this.btn.setAttribute('aria-label', `테마: ${name} (누르면 바뀜, 이 기기에만 저장)`);
  }
}
customElements.define('ds-theme-toggle', DsThemeToggle);
