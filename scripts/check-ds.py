#!/usr/bin/env python3
"""Check the design system against the rules in design-system/GUIDELINES.md that a script can see.

    python3 scripts/check-ds.py

Prints each violation with its rule number (GUIDELINES.md) and exits 1 if there are any. Standard library only.
"""
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
DS = os.path.join(ROOT, 'design-system')
FRONT = os.path.join(ROOT, 'frontend')
MATERIALS = ['glass', 'matte']
problems = []


def rel(p):
    return os.path.relpath(p, ROOT)


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def report(rule, where, msg):
    problems.append(f'[{rule}] {where}: {msg}')


def css_body(text):
    """CSS without comments, keeping line numbers."""
    return re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)


def lines(text):
    return enumerate(css_body(text).split('\n'), 1)


# --- the material contract: the tokens glass.css (the reference material) sets in its light block
glass = css_body(read(os.path.join(DS, 'materials', 'glass.css')))
first_block = glass[glass.index('{') + 1:glass.index('}')]
CONTRACT = sorted(set(re.findall(r'(--[\w-]+)\s*:', first_block)))
if not CONTRACT:
    report('M1', 'materials/glass.css', 'no contract tokens found')

# M1: every material defines the whole contract for the light theme (dark may override a subset)
for m in MATERIALS:
    p = os.path.join(DS, 'materials', f'{m}.css')
    if not os.path.exists(p):
        report('M1', rel(p), 'material file missing')
        continue
    body = css_body(read(p))
    light = body[body.index('{') + 1:body.index('}')]
    missing = [t for t in CONTRACT if not re.search(re.escape(t) + r'\s*:', light)]
    if missing:
        report('M1', rel(p), 'light block lacks ' + ', '.join(missing))
    extra = sorted(set(re.findall(r'(--[\w-]+)\s*:', body)) - set(CONTRACT))
    if extra:
        report('M1', rel(p), 'sets tokens outside the contract: ' + ', '.join(extra) + ' (add them to every material)')
    if f'data-material="{m}"' not in body:
        report('M1', rel(p), f'not keyed on data-material="{m}"')

# --- component CSS (and the page CSS, for the material rules)
comp_dir = os.path.join(DS, 'components')
components = sorted(d for d in os.listdir(comp_dir) if os.path.isdir(os.path.join(comp_dir, d)))
COLOR = re.compile(r'#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(')
for name in components:
    for f in sorted(os.listdir(os.path.join(comp_dir, name))):
        p = os.path.join(comp_dir, name, f)
        if not f.endswith('.css'):
            continue
        for n, line in lines(read(p)):
            where = f'{rel(p)}:{n}'
            if COLOR.search(line):
                report('C1', where, 'colour literal; use a palette or material token')
            if re.search(r'backdrop-filter\s*:(?!\s*var\()', line):
                report('M2', where, 'backdrop-filter must be a material token (var(--surface-blur…))')
            if re.search(r'--(glass|blur)\b|--glass-', line):
                report('M2', where, 'old glass token; use the --surface-* contract')
            if '!important' in line:
                report('S2', where, '!important')
            sel = line.split('{')[0] if '{' in line else ''
            if re.search(r'(^|[\s,>+~(])#[\w-]', sel):
                report('S1', where, 'id selector in a component')

app_css = os.path.join(FRONT, 'app.css')
for n, line in lines(read(app_css)):
    where = f'{rel(app_css)}:{n}'
    if re.search(r'backdrop-filter\s*:(?!\s*var\()', line):
        report('M2', where, 'backdrop-filter must be a material token')
    if re.search(r'rgb\(255 255 255', line):
        report('M2', where, 'white highlight literal; use --surface-hi / --control-hi / --bar-*')
    if re.search(r'--(glass|blur)\b|--glass-', line):
        report('M2', where, 'old glass token; use the --surface-* contract')

# --- breakpoints (B1): every @media width in the design system and the page is one of the three in tokens.css
BREAKPOINTS = {'500px', '700px', '900px'}
css_files = [app_css] + [os.path.join(d, f) for d, _, fs in os.walk(DS) for f in fs if f.endswith('.css')]
for p in sorted(css_files):
    for n, line in lines(read(p)):
        for q in re.findall(r'@media[^{]*', line):
            for feat, val in re.findall(r'\((min|max)-width\s*:\s*([^)]+)\)', q):
                if feat != 'max' or val.strip() not in BREAKPOINTS:
                    report('B1', f'{rel(p)}:{n}', f'({feat}-width: {val.strip()}); use max-width 500px, 700px or 900px')
            for val in re.findall(r'\bwidth\s*[<>]=?\s*([\d.]+\w*)', q) + re.findall(r'([\d.]+\w*)\s*[<>]=?\s*width\b', q):
                if val not in BREAKPOINTS:
                    report('B1', f'{rel(p)}:{n}', f'width {val} in range syntax; only 500px, 700px or 900px')

# --- the fold layout (B8, B10): the one fold query, copied verbatim from tokens.css (the rule that sets --fold: 1)
SEGMENTS = '(horizontal-viewport-segments: 2)'
tokens_body = css_body(read(os.path.join(DS, 'foundations', 'tokens.css')))
FOLD = next((m.strip() for m in re.findall(r'@media([^{]*)\{\s*:root\s*\{\s*--fold:\s*1;', tokens_body) if 'viewport-segments' not in m), None)
if not FOLD:
    report('B8', 'design-system/foundations/tokens.css', 'no fold query (an @media that sets :root { --fold: 1; })')
norm = lambda q: re.sub(r'\s+', ' ', q).strip()
for p in sorted(css_files):
    for n, line in lines(read(p)):
        for q in re.findall(r'@media([^{]*)', line):
            for part in q.split(','):
                if re.search(r'aspect-ratio|viewport-segments|height', part) and FOLD and norm(part) not in (norm(FOLD), SEGMENTS):
                    report('B8', f'{rel(p)}:{n}', f'{norm(part)}: aspect, height and segment conditions only as the fold query (tokens.css) or {SEGMENTS}')
        if 'env(viewport-segment' in line and not p.endswith(os.path.join('foundations', 'tokens.css')):
            report('B10', f'{rel(p)}:{n}', 'env(viewport-segment-*) outside tokens.css; use --hinge, --seg-w or --pane-gap')

# --- registration (R1–R5)
ds_css = read(os.path.join(DS, 'ds.css'))
# the files sw.js precaches: literal 'ds/…' paths plus the lists it expands with .map(c => `ds/components/${c}/…`)
sw_text = read(os.path.join(FRONT, 'sw.js'))
SERVED = set(re.findall(r"'(ds/[^']+)'", sw_text))
for names_, tmpl in re.findall(r"\[([^\]]*)\]\.map\(c => `(ds/components/[^`]+)`\)", sw_text):
    for c in re.findall(r"'([\w-]+)'", names_):
        SERVED.add(tmpl.replace('${c}', c))
ds_js = read(os.path.join(DS, 'ds.js'))
sw = read(os.path.join(FRONT, 'sw.js'))
readme = read(os.path.join(DS, 'README.md'))
imports = re.findall(r'@import "([^"]+)"', ds_css)
for m in MATERIALS:
    if f'materials/{m}.css' not in imports:
        report('R1', 'design-system/ds.css', f'materials/{m}.css not imported')
if imports[:2] != ['foundations/tokens.css', 'foundations/base.css']:
    report('R1', 'design-system/ds.css', 'must start with foundations/tokens.css, foundations/base.css')
mat_last = max((imports.index(f'materials/{m}.css') for m in MATERIALS if f'materials/{m}.css' in imports), default=-1)
for name in components:
    folder = os.path.join(comp_dir, name)
    files = os.listdir(folder)
    css = f'components/{name}/{name}.css'
    if f'{name}.css' not in files:
        report('F1', f'design-system/components/{name}', f'{name}.css missing')
    elif css not in imports:
        report('R1', 'design-system/ds.css', f'{css} not imported')
    elif imports.index(css) < mat_last:
        report('R1', 'design-system/ds.css', f'{css} imported before the materials')
    # H1–H3: <name>.html is the markup contract (and the preview's source)
    html_p = os.path.join(folder, f'{name}.html')
    if not os.path.exists(html_p):
        report('H1', f'design-system/components/{name}', f'{name}.html missing (the markup contract)')
        html = ''
    else:
        html = read(html_p)
        if not re.match(r'\s*<!--\s*' + re.escape(name) + r' — ', html):
            report('H2', rel(html_p), f'must open with a comment "<!-- {name} — what it is." and the markup it takes')
        if '<script' in html or '<style' in html:
            report('H3', rel(html_p), 'markup only: no <script> or <style> (styles live in the .css, behaviour in ds-*.js)')
    for f in files:
        if f.endswith('.js') and f.startswith('ds-'):
            tag = f[:-3]
            if f'./components/{name}/{f}' not in ds_js:
                report('R2', 'design-system/ds.js', f'{name}/{f} not imported')
            src = read(os.path.join(folder, f))
            if f"customElements.define('{tag}'" not in src:
                report('E1', f'design-system/components/{name}/{f}', f"must define <{tag}> (customElements.define('{tag}', …))")
            if 'attachShadow' in src:
                report('E2', f'design-system/components/{name}/{f}', 'shadow DOM; components are light DOM')
            if f'<{tag}' not in html:
                report('H1', f'design-system/components/{name}/{name}.html', f'no <{tag}> example')
        elif f.endswith('.js') and not f.endswith('-boot.js'):
            report('F1', f'design-system/components/{name}/{f}', 'scripts are ds-<name>.js (an element) or <name>-boot.js')
        if not f.endswith(('.md', '.html')) and f'ds/components/{name}/{f}' not in SERVED:
            report('R3', 'frontend/sw.js', f'ds/components/{name}/{f} not in SHELL')
    if f'`{name}/`' not in readme and f'{name}/' not in readme:
        report('R5', 'design-system/README.md', f'component {name}/ not in the table')
for m_ in MATERIALS:
    if f'ds/materials/{m_}.css' not in SERVED:
        report('R3', 'frontend/sw.js', f'ds/materials/{m_}.css not in SHELL')

# --- icons (I1)
sprite = read(os.path.join(comp_dir, 'icon', 'icons.svg'))
for sid, attrs, body in re.findall(r'<symbol id="([\w-]+)"([^>]*)>(.*?)</symbol>', sprite, re.S):
    if 'viewBox="0 0 24 24"' not in attrs:
        report('I1', 'icons.svg', f'#{sid}: viewBox must be 0 0 24 24')
    if re.search(r'\b(fill|stroke|style|class)=', body):
        report('I1', 'icons.svg', f'#{sid}: no fill/stroke/style/class on shapes (icon.css strokes them in currentColor)')

if problems:
    print('\n'.join(problems))
    print(f'\n{len(problems)} problem(s). Rules: design-system/GUIDELINES.md')
    sys.exit(1)
print(f'design system OK: {len(components)} components, {len(MATERIALS)} materials, {len(CONTRACT)} contract tokens')
