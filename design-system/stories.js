// Stories: each component's markup contract (components/<name>/<name>.html) split into named cases, read by the
// preview (index.html, all cases stacked) and the story viewer (stories.html, one case at a time, checked one by one).
// After the opening doc comment, a case starts with
//   <!-- @story name — what it shows -->
// and runs to the next one; markup before the first marker is the case 「기본」. data-story-play="js" on an element runs
// once the case is drawn in the viewer, with this = the element (open a dialog, show a toast); the preview shows the
// markup as written. <div class="icons" data-icons></div> is filled with every symbol in icons.svg.
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const text = url => fetch(url).then(r => r.text());

export function parse(name, src) {
  const doc = (src.match(/^<!--([\s\S]*?)-->/) || [, ''])[1].replace(/^ {5}/gm, '').trim();
  const body = src.replace(/^<!--[\s\S]*?-->\s*/, '');
  const [title, ...rest] = doc.split('\n');
  const parts = body.split(/<!--\s*@story\s+([\s\S]*?)\s*-->\s*/);
  const stories = parts[0].trim() ? [{ name: '기본', note: '', html: parts[0].trim() }] : [];
  for (let i = 1; i < parts.length; i += 2) {
    const [n, ...note] = parts[i].split(' — ');
    stories.push({ name: n.trim(), note: note.join(' — ').trim(), html: parts[i + 1].trim() });
  }
  return { name, title, doc: rest.join('\n'), body, stories };
}

// every component imported by ds.css, in cascade order. Fetched all at once: on Cloudflare Pages each <name>.html costs
// a redirect (to the extensionless URL), so one by one the page took ~20s to fill in.
export async function load() {
  const css = await text('ds.css');
  const names = [...css.matchAll(/@import "components\/([\w-]+)\/\1\.css"/g)].map(m => m[1]);
  const [sprite, ...srcs] = await Promise.all(['components/icon/icons.svg', ...names.map(n => `components/${n}/${n}.html`)].map(text));
  return { sprite, components: names.map((n, i) => parse(n, srcs[i])) };
}

export const fillIcons = (root, sprite) => {
  const ids = [...sprite.matchAll(/<symbol id="([\w-]+)"/g)].map(m => m[1]);
  root.querySelectorAll('[data-icons]').forEach(el => {
    el.innerHTML = ids.map(n => `<div><ds-icon name="${n}"></ds-icon>${n}</div>`).join('');
  });
};
