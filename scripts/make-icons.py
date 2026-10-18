#!/usr/bin/env python3
"""Generate the app icons: 5 concepts x 4 colours, liquid glass over a deep colour field.

Writes, for each icon <concept>-<colour>, icon.svg, icon-192.png, icon-512.png (also the maskable one) and
apple-touch-icon.png plus a manifest.webmanifest that points at them, under frontend/icons/app/<id>/. The default
(grid-blue) goes to frontend/icons/ and frontend/manifest.webmanifest instead. PNGs are rendered with headless
Chrome. The picker (frontend/icon-boot.js) lists the same ids; keep the two in step.
  scripts/make-icons.py
Settings (environment variables):
  CHROME  the Chrome binary (default: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome)
"""
import json, os, pathlib, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FRONT = ROOT / 'frontend'
CHROME = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
DEFAULT = 'grid-blue'

# bg: the field's gradient · glow: the two colours the glass refracts · lit: the lit tile's bottom tint · dot: accent
COLOURS = {
    'blue':     dict(bg=('#16206b', '#2f5fd6', '#7a4fd8'), glow=('#2fd39a', '#ff8a5c'), lit='#dfe8ff', dot='#4fe39a', shadow='#0a1040'),
    'emerald':  dict(bg=('#04342a', '#0f8a68', '#3cc4a0'), glow=('#b6f05a', '#2fa7ff'), lit='#dcfff2', dot='#d9ff6b', shadow='#02241c'),
    'sunset':   dict(bg=('#4a0f33', '#d9476f', '#ff9a4d'), glow=('#ffd166', '#7a4fd8'), lit='#ffe6dc', dot='#fff27a', shadow='#2a0820'),
    'graphite': dict(bg=('#0b0d10', '#262b33', '#4a515c'), glow=('#6b7cff', '#2fd39a'), lit='#e6e9ef', dot='#4fe39a', shadow='#000000'),
}


def defs(c):
    return f'''  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{c['bg'][0]}"/>
      <stop offset=".55" stop-color="{c['bg'][1]}"/>
      <stop offset="1" stop-color="{c['bg'][2]}"/>
    </linearGradient>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="46"/></filter>
    <filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="{c['shadow']}" flood-opacity=".35"/></filter>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".55"/>
      <stop offset=".5" stop-color="#fff" stop-opacity=".08"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".02"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".95"/>
      <stop offset=".45" stop-color="#fff" stop-opacity=".25"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".6"/>
    </linearGradient>
    <linearGradient id="lit" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".95"/>
      <stop offset="1" stop-color="{c['lit']}" stop-opacity=".78"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <!-- colour the glass refracts -->
  <circle cx="150" cy="390" r="120" fill="{c['glow'][0]}" opacity=".45" filter="url(#soft)"/>
  <circle cx="390" cy="120" r="110" fill="{c['glow'][1]}" opacity=".35" filter="url(#soft)"/>'''


def glass(tag, attrs, fill='#ffffff" fill-opacity=".16'):
    """A frosted shape: body (shadowed), top sheen, bright rim."""
    return (f'  <g filter="url(#drop)"><{tag} {attrs} fill="{fill}"/></g>\n'
            f'  <{tag} {attrs} fill="url(#sheen)"/>\n'
            f'  <{tag} {attrs} fill="none" stroke="url(#rim)" stroke-width="3"/>')


def dot(cx, cy, r, c):
    """A lit accent dot with a glow and a highlight."""
    return (f'  <circle cx="{cx}" cy="{cy}" r="{r + 6}" fill="{c["dot"]}" filter="url(#glow)" opacity=".9"/>\n'
            f'  <circle cx="{cx}" cy="{cy}" r="{r}" fill="{c["dot"]}"/>\n'
            f'  <ellipse cx="{cx}" cy="{cy - r * .38:g}" rx="{r * .58:g}" ry="{r / 3:g}" fill="#fff" opacity=".55"/>')


def stroke(d, c, w):
    """An accent stroke with a glow under it."""
    return (f'  <path d="{d}" fill="none" stroke="{c["dot"]}" stroke-width="{w + 8}" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" opacity=".8"/>\n'
            f'  <path d="{d}" fill="none" stroke="{c["dot"]}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>')


# Each concept keeps its shapes inside the central 80% circle that maskable icons keep.
def grid(c):
    tiles = [(116, 116, 'url(#lit)'), (268, 116, '#ffffff" fill-opacity=".14'),
             (116, 268, '#ffffff" fill-opacity=".14'), (268, 268, '#ffffff" fill-opacity=".34')]
    return ('  <!-- a 2x2 grid of agent cards, one running -->\n'
            + '\n'.join(glass('rect', f'x="{x}" y="{y}" width="128" height="128" rx="30"', f) for x, y, f in tiles)
            + '\n' + dot(332, 180, 24, c))


def pulse(c):
    return ('  <!-- one card with a heartbeat: agents alive -->\n'
            + glass('rect', 'x="106" y="136" width="300" height="240" rx="56"') + '\n'
            + stroke('M146 262H204L230 202L268 322L298 232L316 262H366', c, 22))


def bot(c):
    return ('  <!-- an agent\'s face -->\n'
            '  <path d="M256 160V122" stroke="#fff" stroke-opacity=".75" stroke-width="10" stroke-linecap="round"/>\n'
            + dot(256, 108, 18, c) + '\n'
            + glass('rect', 'x="98" y="230" width="34" height="80" rx="14"') + '\n'
            + glass('rect', 'x="380" y="230" width="34" height="80" rx="14"') + '\n'
            + glass('rect', 'x="132" y="160" width="248" height="216" rx="62"', '#ffffff" fill-opacity=".2') + '\n'
            + dot(208, 254, 26, c) + '\n' + dot(304, 254, 26, c) + '\n'
            '  <rect x="220" y="318" width="72" height="14" rx="7" fill="#fff" opacity=".75"/>')


def terminal(c):
    return ('  <!-- a terminal window with a prompt -->\n'
            + glass('rect', 'x="106" y="130" width="300" height="252" rx="44"') + '\n'
            '  <path d="M108 184H404" stroke="#fff" stroke-opacity=".35" stroke-width="3"/>\n'
            f'  <circle cx="146" cy="157" r="9" fill="{c["dot"]}"/>\n'
            '  <circle cx="174" cy="157" r="9" fill="#fff" opacity=".6"/>\n'
            '  <circle cx="202" cy="157" r="9" fill="#fff" opacity=".6"/>\n'
            + stroke('M160 240L208 276L160 312', c, 22) + '\n'
            '  <rect x="236" y="300" width="96" height="22" rx="11" fill="#fff" opacity=".9"/>')


def nodes(c):
    sats = [(150, 176), (372, 196), (240, 388)]
    return ('  <!-- agents connected around a coordinator -->\n'
            + ''.join(f'  <path d="M256 256L{x} {y}" stroke="#fff" stroke-opacity=".5" stroke-width="10" stroke-linecap="round"/>\n' for x, y in sats)
            + '\n'.join(glass('circle', f'cx="{x}" cy="{y}" r="44"') for x, y in sats) + '\n'
            + glass('circle', 'cx="256" cy="256" r="64"', 'url(#lit)') + '\n'
            + dot(256, 256, 30, c))


CONCEPTS = {'grid': grid, 'pulse': pulse, 'bot': bot, 'terminal': terminal, 'nodes': nodes}


def svg(concept, colour):
    c = COLOURS[colour]
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
            f'  <!-- Agent Dashboard app icon {concept}-{colour}, generated by scripts/make-icons.py: full-bleed square (the OS\n'
            f'       masks it). Rendered to the PNGs next to it. -->\n'
            f'{defs(c)}\n{CONCEPTS[concept](c)}\n</svg>\n')


def manifest(base, prefix):
    icons = [('icon-192.png', '192x192', 'image/png', 'any'), ('icon-512.png', '512x512', 'image/png', 'any'),
             ('icon-maskable-512.png', '512x512', 'image/png', 'maskable'), ('icon.svg', 'any', 'image/svg+xml', 'any')]
    m = {
        'id': base, 'name': 'Agent Dashboard', 'short_name': 'Agents',
        'description': 'Claude Code·Codex 에이전트 세션과 Orca Run 을 실시간으로 보는 대시보드',
        'lang': 'ko', 'start_url': base, 'scope': base, 'display': 'standalone',
        'background_color': '#0f1215', 'theme_color': '#0f1215',
        'icons': [dict(src=prefix + s, sizes=z, type=t, purpose=p) for s, z, t, p in icons],
    }
    lines = ',\n'.join('    { ' + json.dumps(i, ensure_ascii=False)[1:-1] + ' }' for i in m.pop('icons'))
    head = json.dumps(m, ensure_ascii=False, indent=2)[:-2]
    return f'{head},\n  "icons": [\n{lines}\n  ]\n}}\n'


def render(src, out, size, tmp):
    page = tmp / 'r.html'
    page.write_text(f'<style>html,body{{margin:0}}img{{display:block;width:{size}px;height:{size}px}}</style><img src="{src.as_uri()}">')
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    f'--window-size={size},{size}', f'--screenshot={out}', page.as_uri()],
                   check=True, capture_output=True)


def main():
    with tempfile.TemporaryDirectory() as t:
        tmp = pathlib.Path(t)
        for concept in CONCEPTS:
            for colour in COLOURS:
                iid = f'{concept}-{colour}'
                d = FRONT / 'icons' if iid == DEFAULT else FRONT / 'icons' / 'app' / iid
                d.mkdir(parents=True, exist_ok=True)
                (d / 'icon.svg').write_text(svg(concept, colour))
                for name, size in (('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)):
                    render(d / 'icon.svg', d / name, size, tmp)
                (d / 'icon-maskable-512.png').write_bytes((d / 'icon-512.png').read_bytes())
                if iid == DEFAULT:
                    (FRONT / 'manifest.webmanifest').write_text(manifest('./', 'icons/'))
                else:
                    (d / 'manifest.webmanifest').write_text(manifest('../../../', ''))
                print(iid)


if __name__ == '__main__':
    main()
