// <ds-pill state="run|wait|idle|done|bg|stalled">label</ds-pill>: a run-state pill. The state only drives
// pill.css; this element adds the leading dot, which run and bg blink and done and bg draw as a ring.
class DsPill extends HTMLElement {
  connectedCallback() {
    if (this.firstElementChild?.localName !== 'i') this.prepend(document.createElement('i'));
  }
}
customElements.define('ds-pill', DsPill);
