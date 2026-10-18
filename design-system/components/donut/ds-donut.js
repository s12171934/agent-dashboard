// <ds-donut segments="N COLOUR; N COLOUR; …" value="3/5" caption="완료"></ds-donut>: a 64px ring of counts.
// Each segment is a count and a CSS colour (a token, or any colour expression; ';' separates segments), drawn in
// order clockwise from the top over an empty track. value is the large centre text, caption the small line under it.
// The element is display: contents; its <svg class="donut"> is the box.
class DsDonut extends HTMLElement {
  static observedAttributes = ['segments', 'value', 'caption'];
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const segs = (this.getAttribute('segments') || '').split(';').map(s => s.trim()).filter(Boolean)
      .map(s => { const i = s.indexOf(' '); return [+s.slice(0, i), s.slice(i + 1).trim()]; }).filter(([n]) => n > 0);
    const total = segs.reduce((a, [n]) => a + n, 0) || 1, r = 24, C = 2 * Math.PI * r;
    let off = 0, arcs = '';
    for (const [n, c] of segs) {
      const len = n / total * C;
      arcs += `<circle r="${r}" cx="32" cy="32" fill="none" stroke="${c}" stroke-width="10" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 32 32)"/>`;
      off += len;
    }
    const v = this.getAttribute('value') || '', cap = this.getAttribute('caption') || '';
    const t = document.createElement('span'); t.textContent = v; const vt = t.innerHTML; t.textContent = cap; const ct = t.innerHTML;
    this.innerHTML = `<svg width="64" height="64" class="donut"><circle r="${r}" cx="32" cy="32" fill="none" stroke="var(--line)" stroke-width="10"/>${arcs}
      <text x="32" y="31" text-anchor="middle" class="d1"${v.length > 5 ? ' textLength="34" lengthAdjust="spacingAndGlyphs"' : ''}>${vt}</text><text x="32" y="43" text-anchor="middle" class="d2">${ct}</text></svg>`;
  }
}
customElements.define('ds-donut', DsDonut);
