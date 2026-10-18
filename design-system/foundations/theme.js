// Design system theme runtime. Load it with a plain <script> in <head>, before the stylesheets paint, so a dark
// choice never flashes light.
// - adash.theme = system | light | dark, per device; 「시스템」 keeps following the OS while the page is open.
//   applyTheme(choice) sets <html data-theme="light|dark">, which tokens.css keys its palettes on.
// - adash.theme.custom = {light: {"--accent": "#…", …}, dark: {…}}: the user's colours over the built-in palette of
//   that base, set inline on <html> (they beat the stylesheet's :root rules). themeCustom() reads it.
// - adash.material = glass | matte: how surfaces look (materials/*.css). applyMaterial(choice) sets
//   <html data-material>; MATERIALS lists them with their names.
// - Both fire a document event after applying: ds:theme {choice, base} and ds:material {choice}. Components that
//   show the current choice (ds-theme-toggle, ds-theme-editor) listen to it; nothing else needs to.
//   Saving the choice is the caller's job (the components below do it); applyTheme/applyMaterial only apply.
// - THEME_VARS: the tokens a user may recolour, with their names; PALETTES: ready-made sets over them.
(() => {
  const os = matchMedia('(prefers-color-scheme: dark)');
  const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  let applied = [];
  window.themeCustom = () => { try { return JSON.parse(read('adash.theme.custom', '{}')) || {}; } catch { return {}; } };
  window.applyTheme = (choice = read('adash.theme', 'system')) => {
    const dark = choice === 'dark' || (choice === 'system' && os.matches), base = dark ? 'dark' : 'light', root = document.documentElement;
    root.dataset.theme = base;
    applied.forEach(v => root.style.removeProperty(v));
    const own = themeCustom()[base] || {};
    applied = Object.keys(own).filter(v => v.startsWith('--'));
    applied.forEach(v => root.style.setProperty(v, own[v]));
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', own['--bg'] || (dark ? '#0f1215' : '#f4f5f7'));
    document.dispatchEvent(new CustomEvent('ds:theme', { detail: { choice, base } }));
    return base;
  };
  window.themeChoice = () => read('adash.theme', 'system');
  window.THEMES = [['system', '시스템'], ['light', '라이트'], ['dark', '다크']];
  window.MATERIALS = [['glass', '유리'], ['matte', '매트']];
  window.materialChoice = () => { const m = read('adash.material', 'glass'); return MATERIALS.some(([k]) => k === m) ? m : 'glass'; };
  window.applyMaterial = (choice = materialChoice()) => {
    document.documentElement.dataset.material = choice;
    document.dispatchEvent(new CustomEvent('ds:material', { detail: { choice } }));
    return choice;
  };
  os.addEventListener('change', () => applyTheme());
  applyTheme();
  applyMaterial();
})();

window.THEME_VARS = [['--bg', '배경'], ['--panel', '카드·상자'], ['--panel2', '카드 안쪽'], ['--line', '테두리'], ['--text', '글자'],
  ['--muted', '흐린 글자'], ['--accent', '강조'], ['--run', '실행 중'], ['--ok', '연결·진행'], ['--warn', '입력 대기·결정'], ['--bad', '오류·응답 없음'],
  ['--done', '완료'], ['--idle', '유휴'], ['--coord', '코디네이터']];
// Palette examples, each with a light and a dark set over THEME_VARS; 「색 편집」 offers them, and picking one replaces
// the overrides of the base in use. --warn also fills badges with white text (결정 대기), so it stays a mid-dark tone.
const V = s => Object.fromEntries(s.split(' ').map((c, i) => [THEME_VARS[i][0], c]));
window.PALETTES = [
  ['GitHub', { light: V('#f6f8fa #ffffff #f6f8fa #d0d7de #1f2328 #656d76 #0969da #0969da #0969da #9a6700 #cf222e #1a7f37 #d0d7de #8250df'),
               dark: V('#0d1117 #161b22 #1c2128 #30363d #e6edf3 #8d96a0 #2f81f7 #2f81f7 #2f81f7 #bb8009 #f85149 #3fb950 #484f58 #a371f7') }],
  ['Nord', { light: V('#eceff4 #ffffff #e5e9f0 #d8dee9 #2e3440 #5f6b7f #5e81ac #5e81ac #5e81ac #b0841e #bf616a #6e9a50 #c5cdd9 #5e81ac'),
             dark: V('#2e3440 #3b4252 #434c5e #4c566a #eceff4 #a3acbd #88c0d0 #81a1c1 #81a1c1 #9a7520 #e0868f #a3be8c #4c566a #5e81ac') }],
  ['Solarized', { light: V('#fdf6e3 #fffbf0 #eee8d5 #e0d9c3 #073642 #657b83 #268bd2 #268bd2 #2aa198 #b58900 #dc322f #859900 #c9c2ad #6c71c4'),
                  dark: V('#002b36 #073642 #0a3f4c #164c58 #eee8d5 #93a1a1 #268bd2 #268bd2 #2aa198 #b58900 #f2645a #859900 #3d5a62 #6c71c4') }],
  ['Dracula', { light: V('#fffbeb #ffffff #f5f1e3 #e3dfd0 #1f1f1f #6c664b #644ac9 #036a96 #036a96 #a34d14 #cb3a2a #14710a #cfcfde #644ac9'),
                dark: V('#1e1f29 #282a36 #2f3241 #44475a #f8f8f2 #a3a7c2 #bd93f9 #8be9fd #8be9fd #b0621a #ff5555 #50fa7b #44475a #7a58c2') }],
  ['Gruvbox', { light: V('#f9f5d7 #fbf1c7 #f2e5bc #d5c4a1 #3c3836 #7c6f64 #076678 #076678 #427b58 #b57614 #9d0006 #79740e #d5c4a1 #8f3f71'),
                dark: V('#1d2021 #282828 #32302f #504945 #ebdbb2 #a89984 #83a598 #83a598 #8ec07c #a86a12 #fb4934 #b8bb26 #504945 #a35a7a') }],
  ['고대비', { light: V('#ffffff #ffffff #ffffff #000000 #000000 #333333 #0033cc #0033cc #0033cc #8a5a00 #c00000 #006400 #888888 #0033cc'),
              dark: V('#000000 #000000 #0a0a0a #ffffff #ffffff #d0d0d0 #4da3ff #4da3ff #4da3ff #9a6a00 #ff4d4d #3ddc84 #777777 #1f6fd1') }],
];
