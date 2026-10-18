// <ds-toast id="…"></ds-toast>: one short notice at the bottom of the page, with an optional action button.
//   toast.show(message, { action: '되돌리기', onAction: () => … }, ms = 6000)
// A new notice replaces the current one. message is text (escaped here); the action runs once and closes the toast.
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

class DsToast extends HTMLElement {
  connectedCallback() { this.setAttribute('role', 'status'); }
  show(message, { action, onAction } = {}, ms = 6000) {
    this.innerHTML = `<span>${esc(message)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
    if (action) this.querySelector('button').onclick = () => { this.removeAttribute('open'); onAction?.(); };
    this.setAttribute('open', '');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.removeAttribute('open'), ms);
  }
}
customElements.define('ds-toast', DsToast);
