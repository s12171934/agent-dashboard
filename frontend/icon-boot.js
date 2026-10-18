// App icon choice, run in <head> right after the manifest and icon links so the browser reads the chosen ones.
// - adash.icon = <concept>-<colour> (default grid-blue). Each icon is a folder of icons/app/ with its own manifest
//   (scripts/make-icons.py makes them; the default lives in icons/ and manifest.webmanifest). APP_ICONS lists them.
// - applyIcon(id) swaps the manifest, favicon, apple-touch-icon and the header logo. An installed app takes the new
//   icon when the browser next checks the manifest (Chrome on Android and desktop may ask first); iOS keeps the icon
//   it was added with, so the page has to be added to the home screen again.
(() => {
  const CONCEPTS = [['grid', '그리드'], ['pulse', '펄스'], ['bot', '봇'], ['terminal', '터미널'], ['nodes', '노드']];
  const COLOURS = [['blue', '블루'], ['emerald', '에메랄드'], ['sunset', '선셋'], ['graphite', '그래파이트']];
  const DEFAULT = 'grid-blue';
  window.APP_ICONS = CONCEPTS.flatMap(([c, cn]) => COLOURS.map(([k, kn]) => ({ id: `${c}-${k}`, concept: cn, colour: kn })));
  const dir = id => id === DEFAULT ? 'icons/' : `icons/app/${id}/`;
  window.appIconSrc = id => dir(id) + 'icon.svg';
  window.appIcon = () => {
    let id = DEFAULT;
    try { id = localStorage.getItem('adash.icon') || DEFAULT; } catch {}
    return APP_ICONS.some(x => x.id === id) ? id : DEFAULT;
  };
  window.applyIcon = (id = appIcon()) => {
    const set = (sel, href) => { const el = document.querySelector(sel); if (el && el.getAttribute('href') !== href) el.setAttribute('href', href); };
    set('link[rel=manifest]', id === DEFAULT ? 'manifest.webmanifest' : dir(id) + 'manifest.webmanifest');
    set('link[rel=icon]', dir(id) + 'icon.svg');
    set('link[rel=apple-touch-icon]', dir(id) + 'apple-touch-icon.png');
    const logo = document.querySelector('.hrow h1 img');
    if (logo) logo.src = dir(id) + 'icon.svg';
  };
  window.setAppIcon = id => {
    try { if (id === DEFAULT) localStorage.removeItem('adash.icon'); else localStorage.setItem('adash.icon', id); } catch {}
    applyIcon(id);
  };
  applyIcon();
  // the header logo comes after this script
  document.addEventListener('DOMContentLoaded', () => applyIcon());
})();
