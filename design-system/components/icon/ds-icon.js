// <ds-icon name="users"></ds-icon>: a line icon from icons.svg (next to this file), drawn in currentColor.
// The element itself is display: contents, so its <svg> is what sits in the layout and what callers size
// (e.g. `.toolbar svg { width: 18px }`); without a size it is 1em.
const SPRITE = new URL('./icons.svg', import.meta.url).href;

class DsIcon extends HTMLElement {
  static observedAttributes = ['name'];
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    this.innerHTML = `<svg aria-hidden="true"><use href="${SPRITE}#${this.getAttribute('name')}"/></svg>`;
  }
}
customElements.define('ds-icon', DsIcon);
