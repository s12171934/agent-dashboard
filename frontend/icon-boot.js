// App icon choice, run in <head> right after the manifest and icon links so the browser reads the chosen ones.
// - adash.icon = <concept>-<colour> (default grid-blue). Each icon is a folder of icons/app/ with its own manifest
//   (scripts/make-icons.py makes them; the default lives in icons/ and manifest.webmanifest). APP_ICONS lists them.
// - adash.icon = face-<who>: a character's SD face, chars/<who>-icon-*.png with chars/<who>-icon.json (scripts/char-icons.py;
//   a person put up without a deploy has theirs in R2, behind functions/chars). Any name is taken here — app.js lists
//   the people — and one taken down only loses the picture.
// - applyIcon(id) swaps the manifest, favicon, apple-touch-icon and the header logo. An installed app takes the new
//   icon when the browser next checks the manifest (Chrome on Android and desktop may ask first); iOS keeps the icon
//   it was added with, so the page has to be added to the home screen again. In the macOS and iOS apps (apple/) the page
//   also hands the icon's 512px picture to the app: the Mac app puts it on its Dock icon, the iPhone app switches to
//   the alternate icon of that name.
(() => {
  const CONCEPTS = [['grid', '그리드'], ['pulse', '펄스'], ['bot', '봇'], ['terminal', '터미널'], ['nodes', '노드']];
  const COLOURS = [['blue', '블루'], ['emerald', '에메랄드'], ['sunset', '선셋'], ['graphite', '그래파이트']];
  const DEFAULT = 'grid-blue';
  window.APP_ICONS = CONCEPTS.flatMap(([c, cn]) => COLOURS.map(([k, kn]) => ({ id: `${c}-${k}`, concept: cn, colour: kn })));
  const dir = id => id === DEFAULT ? 'icons/' : `icons/app/${id}/`;
  const face = id => /^face-([a-z0-9-]+)$/.exec(id)?.[1];
  // [manifest, favicon, apple-touch-icon]
  const links = id => face(id) ? ['json', '192.png', '180.png'].map(f => `chars/${face(id)}-icon${f === 'json' ? '.json' : '-' + f}`)
    : [id === DEFAULT ? 'manifest.webmanifest' : dir(id) + 'manifest.webmanifest', dir(id) + 'icon.svg', dir(id) + 'apple-touch-icon.png'];
  window.appIconSrc = id => links(id)[1];
  window.appIcon = () => {
    let id = DEFAULT;
    try { id = localStorage.getItem('adash.icon') || DEFAULT; } catch {}
    return face(id) || APP_ICONS.some(x => x.id === id) ? id : DEFAULT;
  };
  window.applyIcon = (id = appIcon()) => {
    const set = (sel, href) => { const el = document.querySelector(sel); if (el && el.getAttribute('href') !== href) el.setAttribute('href', href); };
    const [mf, fav, apple] = links(id);
    set('link[rel=manifest]', mf);
    set('link[rel=icon]', fav);
    document.querySelector('link[rel=icon]')?.setAttribute('type', face(id) ? 'image/png' : 'image/svg+xml');
    set('link[rel=apple-touch-icon]', apple);
    const logo = document.querySelector('.hrow h1 img');
    if (logo) logo.src = fav;
    const big = face(id) ? `chars/${face(id)}-icon-512.png` : dir(id) + 'icon-512.png';
    window.webkit?.messageHandlers?.adash?.postMessage({ icon: new URL(big, location.href).href });
  };
  window.setAppIcon = id => {
    try { if (id === DEFAULT) localStorage.removeItem('adash.icon'); else localStorage.setItem('adash.icon', id); } catch {}
    applyIcon(id);
  };
  applyIcon();
  // the header logo comes after this script
  document.addEventListener('DOMContentLoaded', () => applyIcon());
})();
