// <ds-tooltip id="…"></ds-tooltip>: one floating note for the page, placed next to the pointer.
//   tip.show(html, event)   fill it (trusted HTML: escape data first) and put it 12px below-right of the pointer,
//                           kept inside the window
//   tip.hide()
// Pointer-only: it never takes focus or catches the mouse (pointer-events: none).
class DsTooltip extends HTMLElement {
  show(html, e) {
    this.innerHTML = html;
    this.style.display = 'block';
    this.style.left = Math.min(e.clientX + 12, innerWidth - 330) + 'px';
    this.style.top = e.clientY + 12 + 'px';
  }
  hide() { this.style.display = 'none'; }
}
customElements.define('ds-tooltip', DsTooltip);
